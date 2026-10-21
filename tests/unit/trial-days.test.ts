/**
 * trial-days.test.ts — the SaaS free period is the FIRST MONTH FREE:
 * 30 days (user decision 2026-10-20, superseding the 2026-10-19 7-day rule).
 *
 * Guards the single source of truth (TRIAL_DAYS in lib/plans, TRIAL_MS in
 * lib/subscription) that the email-signup and Google-signup routes use to
 * compute a new business's trialEndsAt.
 */
import { describe, it, expect } from "vitest";
import { TRIAL_DAYS } from "@/lib/plans";
import {
  TRIAL_MS,
  isSubscriptionActive,
  isInActiveTrial,
  isFreeTierBusiness,
} from "@/lib/subscription";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("first-month-free trial (30 days)", () => {
  it("TRIAL_DAYS is 30", () => {
    expect(TRIAL_DAYS).toBe(30);
  });

  it("TRIAL_MS equals exactly 30 days", () => {
    expect(TRIAL_MS).toBe(30 * DAY_MS);
    expect(TRIAL_MS).toBe(TRIAL_DAYS * DAY_MS);
  });

  it("a business created now gets trialEndsAt ~30 days out", () => {
    const trialEndsAt = new Date(Date.now() + TRIAL_MS);
    const daysOut = (trialEndsAt.getTime() - Date.now()) / DAY_MS;
    expect(daysOut).toBeGreaterThan(29.9);
    expect(daysOut).toBeLessThanOrEqual(30);
  });

  it("a trial 8 days in is still active (past the old 7-day limit)", () => {
    const biz = {
      isActive: true,
      subscriptionStatus: "trialing",
      trialEndsAt: new Date(Date.now() + 22 * DAY_MS), // created 8 days ago
    } as never;
    expect(isSubscriptionActive(biz)).toBe(true);
  });

  it("a trial past 30 days has LEFT the trial — it lands on the free tier (owner rule 2026-10-22)", () => {
    const biz = {
      isActive: true,
      subscriptionStatus: "trialing",
      trialEndsAt: new Date(Date.now() - DAY_MS), // ended yesterday
    } as never;
    expect(isInActiveTrial(biz)).toBe(false);
    expect(isFreeTierBusiness(biz)).toBe(true);
    // The free tier is usable (its 100-message cap lives in
    // billing-usage), so the gate no longer hard-stops a lapsed trial.
    expect(isSubscriptionActive(biz)).toBe(true);
  });
});
