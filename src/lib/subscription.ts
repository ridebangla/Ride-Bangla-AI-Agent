/**
 * subscription.ts — SaaS trial/subscription enforcement foundation (Phase 1).
 *
 * Business rule (user decision 16, business-critical): the first 10 days are
 * free. After the trial ends, payment is MANDATORY — the AI must hard-stop
 * replying for that business until they pay ("নয়তো আমরা চলতে পারব না").
 *
 * Active = Super Admin (businessId null, always) OR
 *          subscriptionStatus == 'active' OR
 *          (subscriptionStatus == 'trialing' AND trialEndsAt > now).
 * Everything else (past_due / canceled / expired / missing fields) = inactive.
 *
 * ---------------------------------------------------------------------------
 * ENFORCEMENT MAP — where the checks must live:
 *
 * 1. Pages (DONE in Phase 1):
 *    - `src/app/(dashboard)/layout.tsx` — tenant admin with inactive
 *      subscription is redirected to /billing (never the dashboard).
 *    - `src/app/page.tsx` (root) — same redirect for logged-in tenants.
 *    - `src/app/onboarding/page.tsx` — same redirect.
 *    NOTE: this is NOT done in `src/middleware.ts` on purpose — middleware
 *    runs on the edge runtime and cannot query Firestore (see the C-07
 *    comment there). Server components/layouts do the check instead.
 *
 * 2. AI reply paths (PHASE 3 MUST WIRE — currently marked with comments):
 *    - `src/app/api/chat/route.ts` (dashboard/API chat)
 *    - `src/app/api/chat/widget/route.ts` (public website widget)
 *    Both must call `isSubscriptionActive()` / `requireActiveSubscription()`
 *    and HARD-STOP the AI reply when false (HTTP 402 + a friendly
 *    "subscription expired" message), before any LLM tokens are spent.
 *
 * 3. Channel webhooks (PHASE 5 MUST WIRE):
 *    - `src/lib/channels/whatsapp.ts`, `telegram.ts`, `sms.ts`, `phone.ts`
 *      (inbound message handlers)
 *    - `src/app/api/social/process/route.ts`, `src/lib/social/engagement.ts`
 *      (social comment/DM auto-replies)
 *    Every one of these must check the subscription before generating an AI
 *    reply for an inbound message. A single shared helper
 *    (`requireActiveSubscription`) exists for exactly this.
 *
 * 4. Stripe billing (PHASE 4 — WIRED): `checkout.session.completed` sets
 *    `subscriptionStatus='active'` (and `plan` to starter/growth/pro);
 *    `invoice.payment_succeeded` lifts past_due → active;
 *    `invoice.payment_failed` sets past_due (Stripe Smart Retries handle
 *    dunning); `customer.subscription.deleted` sets 'suspended'. Webhook
 *    handlers are idempotent; all are fail-closed (unknown business → no
 *    write), so the Phase 3 402 hard-stop stays airtight (decision 16).
 *    Until Stripe keys exist, `/billing` says so honestly and trials are
 *    the only path — no fake checkout.
 * ---------------------------------------------------------------------------
 */

import { redirect } from "next/navigation";
import { getUnscopedPrisma } from "@/lib/prisma";
import type { Business } from "@/lib/models";

/** Free trial length for every new SaaS signup. */
export const TRIAL_DAYS = 10;
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired"
  // Phase 4: set by the Stripe `customer.subscription.deleted` webhook.
  // Like every other non-active status, fail-closed (no AI replies).
  | "suspended";

export interface SubscriptionInfo {
  /** null = Super Admin (no business row needed, always active). */
  businessId: string | null;
  /** 'trial' | 'starter' | 'growth' | 'pro' | 'super_admin' | 'unknown' */
  plan: string;
  subscriptionStatus: SubscriptionStatus | "super_admin" | "unknown";
  trialEndsAt: Date | null;
  /** Whole days of trial left (0 when not trialing). */
  trialDaysRemaining: number;
  isActive: boolean;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  // Firestore Timestamps decode to Date on read, but be defensive.
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The single source of truth for "may this business use the AI?".
 *
 * @param biz The business row, or null for the Super Admin (businessId null).
 */
export function isSubscriptionActive(biz: Business | null): boolean {
  // Super Admin (businessId null) — always active, never billed.
  if (biz === null) return true;
  if (!biz.isActive) return false;

  const status =
    typeof biz.subscriptionStatus === "string" ? biz.subscriptionStatus : "";

  if (status === "active") return true;

  if (status === "trialing") {
    const ends = toDate(biz.trialEndsAt);
    return ends !== null && ends.getTime() > Date.now();
  }

  // past_due / canceled / expired / missing status → inactive (fail-closed).
  return false;
}

/**
 * Read a business's subscription state. Uses the UNSCOPED client because this
 * runs in setup/auth/page code that has no tenant context yet (or is the
 * Super Admin). Never throws for a missing business — returns inactive.
 */
export async function getSubscription(
  businessId: string | null
): Promise<SubscriptionInfo> {
  if (!businessId) {
    return {
      businessId: null,
      plan: "super_admin",
      subscriptionStatus: "super_admin",
      trialEndsAt: null,
      trialDaysRemaining: 0,
      isActive: true,
    };
  }

  const db = getUnscopedPrisma();
  const biz = (await db.business.findUnique({
    where: { id: businessId },
  })) as unknown as Business | null;

  if (!biz) {
    return {
      businessId,
      plan: "unknown",
      subscriptionStatus: "unknown",
      trialEndsAt: null,
      trialDaysRemaining: 0,
      isActive: false,
    };
  }

  const trialEndsAt = toDate(biz.trialEndsAt);
  const status =
    typeof biz.subscriptionStatus === "string" ? biz.subscriptionStatus : "";
  const trialDaysRemaining =
    status === "trialing" && trialEndsAt
      ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86400000))
      : 0;

  return {
    businessId,
    plan:
      typeof biz.plan === "string" && biz.plan
        ? biz.plan
        : status === "trialing"
          ? "trial"
          : "unknown",
    subscriptionStatus: (status ||
      "unknown") as SubscriptionInfo["subscriptionStatus"],
    trialEndsAt,
    trialDaysRemaining,
    isActive: isSubscriptionActive(biz),
  };
}

/** Thrown when a business's trial/subscription is not active. */
export class SubscriptionInactiveError extends Error {
  constructor(businessId?: string | null) {
    super(
      `Subscription is not active${businessId ? ` (business ${businessId})` : ""}. ` +
        `AI replies are hard-stopped until the subscription is reactivated.`
    );
    this.name = "SubscriptionInactiveError";
  }
}

/**
 * For API routes / server actions (Phase 3/5): returns the subscription when
 * active, throws `SubscriptionInactiveError` when not. Callers convert that
 * into a 402 + friendly message — never generate an AI reply past this point.
 */
export async function requireActiveSubscription(
  businessId: string | null
): Promise<SubscriptionInfo> {
  const sub = await getSubscription(businessId);
  if (!sub.isActive) {
    throw new SubscriptionInactiveError(businessId);
  }
  return sub;
}

/**
 * For Server Components / layouts (Phase 1): redirects inactive tenant
 * admins to /billing. Super Admin (businessId null) always passes through.
 */
export async function requireActiveSubscriptionOrRedirect(
  businessId: string | null
): Promise<SubscriptionInfo> {
  const sub = await getSubscription(businessId);
  if (!sub.isActive) {
    redirect("/billing");
  }
  return sub;
}
