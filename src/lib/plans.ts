/**
 * plans.ts — SaaS plan catalog (shared, no server-only imports).
 *
 * Deliberately free of the `stripe` SDK import so client components
 * (e.g. the /billing plan picker) can use the plan metadata without
 * bundling stripe-node into the browser. Server billing code lives in
 * `@/lib/stripe`, which re-exports everything here.
 */

/** Free trial length for every new SaaS signup (user decision 2026-10-19: 7 days).
 *  Client-safe (no server-only imports) so marketing pages and the signup
 *  form can render it without bundling server code. */
export const TRIAL_DAYS = 7;

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
