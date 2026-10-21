/**
 * plans.ts — SaaS plan catalog (shared, no server-only imports).
 *
 * Deliberately free of the `stripe` SDK import so client components
 * (e.g. the /billing plan picker) can use the plan metadata without
 * bundling stripe-node into the browser. Server billing code lives in
 * `@/lib/stripe`, which re-exports everything here.
 */

/** Free trial length for every new SaaS signup — the FIRST MONTH FREE
 *  (user decision 2026-10-20: 30 days, superseding the 2026-10-19 7-day rule).
 *  Client-safe (no server-only imports) so marketing pages and the signup
 *  form can render it without bundling server code. */
export const TRIAL_DAYS = 30;

/** Paid plan ids — matches the Phase 1 `plan` values on the Business doc. */
export type PaidPlanId = "starter" | "growth" | "pro";

export const PAID_PLANS: readonly PaidPlanId[] = ["starter", "growth", "pro"];

/** Billing cadence. Yearly = 10x monthly (2 months free, user decision). */
export type BillingInterval = "monthly" | "yearly";

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "monthly" || value === "yearly";
}

/** Marketing metadata for the paid plans (USD). Yearly = 2 months free.
 *  `messagesPerMonth` is the AI-message allowance per 30-day usage period
 *  (Billing Phase 2). Overages are not sold separately yet — at 100% the
 *  dashboard shows an upgrade notice. */
export const PLAN_META: Record<
  PaidPlanId,
  {
    name: string;
    priceUsd: number;
    yearlyPriceUsd: number;
    tagline: string;
    messagesPerMonth: number;
  }
> = {
  starter: {
    name: "Starter",
    priceUsd: 19,
    yearlyPriceUsd: 190,
    tagline: "For small businesses getting started with AI support.",
    messagesPerMonth: 1000,
  },
  growth: {
    name: "Growth",
    priceUsd: 49,
    yearlyPriceUsd: 490,
    tagline: "For growing businesses that live on customer chat.",
    messagesPerMonth: 5000,
  },
  pro: {
    name: "Pro",
    priceUsd: 99,
    yearlyPriceUsd: 990,
    tagline: "For high-volume businesses and teams.",
    messagesPerMonth: 15000,
  },
};

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return (
    typeof value === "string" &&
    (PAID_PLANS as readonly string[]).includes(value)
  );
}

/** Permanent FREE tier (owner rule 2026-10-22): a trial-origin account
 *  whose trial has lapsed resolves to this tier instead of a hard
 *  inactive stop — usable, but capped at the owner's example scale
 *  ("এক মাসে সে একশো মেসেজ"): 100 AI messages per 30-day usage period,
 *  $0. Deliberately NOT part of PLAN_META / PAID_PLANS: it is not
 *  purchasable and never listed for sale; it exists only as the
 *  resolution floor applied by subscription.ts / billing-usage.ts. */
export const FREE_PLAN_ID = "free";
export const FREE_MESSAGES_PER_MONTH = 100;

/** The tier-relevant fields of a business doc (raw Firestore shapes). */
export interface TierStateFields {
  plan?: unknown;
  subscriptionStatus?: unknown;
  trialEndsAt?: unknown;
}

function tierDateMs(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime())
        ? d.getTime()
        : null;
    } catch {
      return null;
    }
  }
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * True while a trial is actually running: status 'trialing' with a
 * trial end still in the future. During this window NO usage quota
 * applies (owner rule 2026-10-22) — only the time-box does.
 */
export function isInActiveTrial(
  biz: TierStateFields,
  nowMs: number = Date.now()
): boolean {
  if (biz.subscriptionStatus !== "trialing") return false;
  const end = tierDateMs(biz.trialEndsAt);
  return end !== null && end > nowMs;
}

/**
 * True when a business sits on the permanent FREE tier: its trial has
 * lapsed. Two shapes count — status still 'trialing' with a past trial
 * end (expiry is computed, never written by a cron), or status
 * 'expired' on a trial-origin doc (plan 'trial' with a past trial end;
 * the plan requirement keeps a lapsed PAID plan, and the console's
 * date-only payloads, out of the free tier). Suspended / canceled /
 * past_due states never resolve here.
 */
export function isFreeTierBusiness(
  biz: TierStateFields,
  nowMs: number = Date.now()
): boolean {
  const end = tierDateMs(biz.trialEndsAt);
  if (end === null || end > nowMs) return false;
  if (biz.subscriptionStatus === "trialing") return true;
  if (biz.subscriptionStatus === "expired") return biz.plan === "trial";
  return false;
}
