/**
 * subscription.ts — SaaS trial/subscription enforcement foundation (Phase 1).
 *
 * Business rule (user decision 16, business-critical): the first month is
 * free — a 30-day trial (TRIAL_DAYS in ./plans; user decision 2026-10-20,
 * superseding the 2026-10-19 7-day rule).
 *
 * THREE-STATE MODEL (owner rule 2026-10-22, superseding the post-trial
 * hard-stop for trial-origin accounts): while a trial is ACTIVE no
 * usage quota applies (only the time-box); when a trial LAPSES the
 * account lands on the permanent FREE tier (usable, capped at
 * FREE_MESSAGES_PER_MONTH by billing-usage) instead of a hard stop.
 * Paid plans are untouched, and past_due / canceled / suspended /
 * lapsed-PAID states still hard-stop exactly as before.
 *
 * Active = Super Admin (businessId null, always) OR
 *          isInternalAccount == true (the company's OWN account — owner
 *          rule 2026-10-21: free forever, no plan, no trial expiry) OR
 *          manualActiveOverride == true (admin kept tenant active w/o payment) OR
 *          an ACTIVE comp grant (see ./comp — plan + endsAt on the comp
 *          map; a suspended status hard-stops before comp) OR
 *          subscriptionStatus == 'active' OR
 *          (subscriptionStatus == 'trialing' AND trialEndsAt > now) OR
 *          isFreeTierBusiness (a lapsed trial on the free tier).
 * Everything else (past_due / canceled / missing fields) = inactive.
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

// Trial length lives in ./plans (client-safe) so marketing pages can
// render it too; re-exported here so existing server importers keep working.
import { TRIAL_DAYS, isFreeTierBusiness, isInActiveTrial } from "./plans";
import {
  isCompActive,
  activeCompPlanId,
  activeCompEndsAt,
  scopeAllows,
} from "./comp";
import { isCompanyBusiness } from "./company-identity";
export { TRIAL_DAYS, isFreeTierBusiness, isInActiveTrial };
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
  /** 'trial' | 'free' | 'starter' | 'growth' | 'pro' | 'super_admin' | 'unknown' | 'internal' */
  plan: string;
  subscriptionStatus: SubscriptionStatus | "super_admin" | "unknown" | "free";
  trialEndsAt: Date | null;
  /** Whole days of trial left (0 when not trialing). */
  trialDaysRemaining: number;
  isActive: boolean;
  /** 'monthly' | 'yearly' — from the business doc; null when not applicable. */
  billingInterval: "monthly" | "yearly" | null;
  /**
   * Internal owner comp (owner rule 2026-10-21): the company's own
   * account — free forever, unlimited, never billed. True when the
   * business is COMPANY under the estate-scoped identity (B9): its doc
   * carries `isInternalAccount === true` (set server-side / by the
   * Admin Console Super Admin, audit-logged) OR its id is listed in
   * the shared `company_identity/current` record.
   */
  isInternal: boolean;
  /**
   * Free tier (owner rule 2026-10-22): true when this business's trial
   * has lapsed and it resolves to the permanent free tier (plan 'free',
   * capped by billing-usage at FREE_MESSAGES_PER_MONTH).
   */
  isFreeTier: boolean;
  /**
   * Complimentary grant (comp): true when an active comp (see
   * src/lib/comp.ts) is what makes this business active. The comp plan
   * is reported in `plan` and its period end in `compEndsAt`
   * (= comp.endsAt). Internal still wins over comp.
   */
  isComp: boolean;
  /** Period end of the active comp (comp.endsAt); null when not comped. */
  compEndsAt: Date | null;
  /**
   * Feature scope for chat (B6): false only when the active grant
   * (comp scope, or an internal grantScope) exists and excludes
   * "chat". True for every unscoped account.
   */
  scopeAllowsChat: boolean;
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
  // Internal owner comp (owner rule 2026-10-21): the company's own
  // account is always active — no plan, no trial, no expiry. The flag
  // lives on THIS doc (keyed by business id); nothing client-supplied
  // (email, request field) can set it.
  if (biz.isInternalAccount === true) return true;
  // Manual override (Admin Console, Super Admin only, audit-logged):
  // the admin chose to keep this tenant active even without payment.
  if (biz.manualActiveOverride === true) return true;

  const status =
    typeof biz.subscriptionStatus === "string" ? biz.subscriptionStatus : "";

  // Suspended hard-stops BEFORE comp: a comp must never resurrect a
  // suspended account. The isActive kill-switch above already blocks
  // a fully deactivated business; this covers a doc whose status
  // alone records the suspension.
  if (status === "suspended") return false;

  // Complimentary grant (comp): an active comp makes the business
  // active on the comp plan until comp.endsAt (auto-expire by
  // comparison in isCompActive — no cron). Internal above still wins.
  if (isCompActive(biz as unknown as Record<string, unknown>)) return true;

  if (status === "active") {
    // Security/billing fix (2026-10-20 attack-test): a locally recorded
    // paid-period end (set by manual-claim approvals and wallet purchases)
    // must actually end the subscription. Without this check an "active"
    // business with a past subscriptionEndsAt stayed active forever —
    // Stripe-managed businesses record no endsAt and are unaffected.
    const ends = toDate((biz as { subscriptionEndsAt?: unknown }).subscriptionEndsAt);
    if (ends !== null && ends.getTime() <= Date.now()) return false;
    return true;
  }

  if (status === "trialing") {
    const ends = toDate(biz.trialEndsAt);
    if (ends !== null && ends.getTime() > Date.now()) return true;
    // Lapsed trial → falls through to the free-tier check below.
  }

  // Free tier (owner rule 2026-10-22): a lapsed TRIAL resolves to the
  // permanent free tier — usable but capped (billing-usage enforces
  // the cap), not hard-stopped. The isActive kill-switch above still
  // blocks completely, and isFreeTierBusiness itself never matches
  // suspended / canceled / past_due or a lapsed paid plan.
  if (isFreeTierBusiness(biz)) return true;

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
      billingInterval: null,
      isInternal: false,
      isFreeTier: false,
      isComp: false,
      compEndsAt: null,
      scopeAllowsChat: true,
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
      billingInterval: null,
      isInternal: false,
      isFreeTier: false,
      isComp: false,
      compEndsAt: null,
      scopeAllowsChat: true,
    };
  }

  // Internal owner account: display truthfully as "Internal" — never
  // "Trial" (its trial date is meaningless once comped) and never a
  // paid plan it did not buy.
  //
  // B9: company identity is estate-scoped — the business is company
  // when its own doc carries the projection flag OR its id is listed
  // in the shared company_identity/current record (isCompanyBusiness;
  // a read error degrades to the flag only). The pure sync
  // isSubscriptionActive() above keeps the flag-only semantics (it has
  // no async seam); every route gate reaches this async resolver.
  // A listed business is presented to the flag-based helpers as
  // flagged, so activation (kill-switch included) and grantScope
  // semantics are EXACTLY the internal ones.
  if (await isCompanyBusiness(biz as unknown as Record<string, unknown>)) {
    const asInternal = { ...biz, isInternalAccount: true } as Business;
    return {
      businessId,
      plan: "internal",
      subscriptionStatus: "active",
      trialEndsAt: null,
      trialDaysRemaining: 0,
      isActive: isSubscriptionActive(asInternal),
      billingInterval: null,
      isInternal: true,
      isFreeTier: false,
      isComp: false,
      compEndsAt: null,
      scopeAllowsChat: scopeAllows(
        asInternal as unknown as Record<string, unknown>,
        "chat"
      ),
    };
  }

  const trialEndsAt = toDate(biz.trialEndsAt);

  // Complimentary grant (comp): an active comp reports the COMP plan
  // and a period end of comp.endsAt. Internal above still wins; a
  // suspended business reports isActive=false here (isSubscriptionActive
  // hard-stops suspended before comp) — the comp never resurrects it.
  const compPlanId = activeCompPlanId(
    biz as unknown as Record<string, unknown>
  );
  if (compPlanId) {
    return {
      businessId,
      plan: compPlanId,
      subscriptionStatus: "active",
      trialEndsAt: null,
      trialDaysRemaining: 0,
      isActive: isSubscriptionActive(biz),
      billingInterval:
        biz.billingInterval === "yearly" ? "yearly" : "monthly",
      isInternal: false,
      isFreeTier: false,
      isComp: true,
      compEndsAt: activeCompEndsAt(
        biz as unknown as Record<string, unknown>
      ),
      scopeAllowsChat: scopeAllows(
        biz as unknown as Record<string, unknown>,
        "chat"
      ),
    };
  }

  // Free tier (owner rule 2026-10-22): a lapsed trial reports plan
  // 'free' truthfully — never "Trial" (it is over) and never a paid
  // plan it did not buy. The usage cap lives in billing-usage.
  if (isFreeTierBusiness(biz)) {
    return {
      businessId,
      plan: "free",
      subscriptionStatus: "free",
      trialEndsAt,
      trialDaysRemaining: 0,
      isActive: isSubscriptionActive(biz),
      billingInterval: null,
      isInternal: false,
      isFreeTier: true,
      isComp: false,
      compEndsAt: null,
      scopeAllowsChat: true,
    };
  }
  const status =
    typeof biz.subscriptionStatus === "string" ? biz.subscriptionStatus : "";
  const trialDaysRemaining =
    status === "trialing" && trialEndsAt
      ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86400000))
      : 0;
  const billingInterval =
    biz.billingInterval === "yearly" ? "yearly" : "monthly";

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
    billingInterval,
    isInternal: false,
    isFreeTier: false,
    isComp: false,
    compEndsAt: null,
    scopeAllowsChat: scopeAllows(
      biz as unknown as Record<string, unknown>,
      "chat"
    ),
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
