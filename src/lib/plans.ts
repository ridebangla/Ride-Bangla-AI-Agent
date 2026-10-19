/**
 * plans.ts — SaaS plan catalog (shared, no server-only imports).
 *
 * Deliberately free of the `stripe` SDK import so client components
 * (e.g. the /billing plan picker) can use the plan metadata without
 * bundling stripe-node into the browser. Server billing code lives in
 * `@/lib/stripe`, which re-exports everything here.
 */

/** Paid plan ids — matches the Phase 1 `plan` values on the Business doc. */
export type PaidPlanId = "starter" | "growth" | "pro";

export const PAID_PLANS: readonly PaidPlanId[] = ["starter", "growth", "pro"];

/** Marketing metadata for the paid plans (USD, monthly). */
export const PLAN_META: Record<
  PaidPlanId,
  { name: string; priceUsd: number; tagline: string }
> = {
  starter: {
    name: "Starter",
    priceUsd: 19,
    tagline: "For small businesses getting started with AI support.",
  },
  growth: {
    name: "Growth",
    priceUsd: 49,
    tagline: "For growing businesses that live on customer chat.",
  },
  pro: {
    name: "Pro",
    priceUsd: 99,
    tagline: "For high-volume businesses and teams.",
  },
};

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return (
    typeof value === "string" &&
    (PAID_PLANS as readonly string[]).includes(value)
  );
}
