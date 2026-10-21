/**
 * Internal owner comp — AI platform (owner rule 2026-10-21).
 *
 * The company's own account is free forever: permanently active, no
 * message limit, no trial expiry, never billed — while every customer
 * account keeps its exact plan behaviour. These tests pin the pure
 * enforcement logic in src/lib/subscription.ts + src/lib/billing-usage.ts:
 *
 *  (a) an internal business passes every former limit point;
 *  (b) a normal business is still limited exactly as before;
 *  (c) SPOOF: the comp binds to the flag on the business doc only —
 *      lookalike inputs (a string "true", a truthy non-boolean, or an
 *      unrelated record that merely CLAIMS the owner's email) get
 *      nothing.
 */
import { describe, it, expect } from "vitest";
import { isSubscriptionActive } from "@/lib/subscription";
import {
  isMessageLimitExceeded,
  buildCountdown,
  type BusinessUsageFields,
} from "@/lib/billing-usage";
import type { Business } from "@/lib/models";

const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PERIOD_START = new Date(Date.now() - 60 * 60 * 1000); // 1h ago

function biz(partial: Record<string, unknown>): Business {
  return {
    id: "biz-test",
    name: "Test",
    slug: "test",
    isActive: true,
    ...partial,
  } as unknown as Business;
}

describe("internal owner comp — subscription gate", () => {
  it("(a) internal business with an EXPIRED trial is still active", () => {
    const b = biz({
      plan: "trial",
      subscriptionStatus: "trialing",
      trialEndsAt: PAST,
      isInternalAccount: true,
    });
    expect(isSubscriptionActive(b)).toBe(true);
  });

  it("(a) internal business with status 'expired' is still active", () => {
    const b = biz({
      plan: "trial",
      subscriptionStatus: "expired",
      isInternalAccount: true,
    });
    expect(isSubscriptionActive(b)).toBe(true);
  });

  it("(b) normal business with an expired trial is INACTIVE", () => {
    const b = biz({
      plan: "trial",
      subscriptionStatus: "trialing",
      trialEndsAt: PAST,
    });
    expect(isSubscriptionActive(b)).toBe(false);
  });

  it("(b) normal active-plan business past subscriptionEndsAt is INACTIVE", () => {
    const b = biz({
      plan: "starter",
      subscriptionStatus: "active",
      subscriptionEndsAt: PAST,
    });
    expect(isSubscriptionActive(b)).toBe(false);
  });

  it("(c) SPOOF: string 'true' does not comp the account", () => {
    const b = biz({
      plan: "trial",
      subscriptionStatus: "trialing",
      trialEndsAt: PAST,
      isInternalAccount: "true",
    });
    expect(isSubscriptionActive(b)).toBe(false);
  });

  it("(c) SPOOF: truthy number 1 does not comp the account", () => {
    const b = biz({
      plan: "trial",
      subscriptionStatus: "expired",
      isInternalAccount: 1,
    });
    expect(isSubscriptionActive(b)).toBe(false);
  });

  it("a deactivated business (isActive false) stays inactive even when internal", () => {
    const b = biz({ isActive: false, isInternalAccount: true });
    expect(isSubscriptionActive(b)).toBe(false);
  });
});

describe("internal owner comp — message limit gate", () => {
  const usage = (partial: BusinessUsageFields): BusinessUsageFields => ({
    plan: "trial",
    aiMessagesUsed: 999999, // far beyond the 1000 trial/starter allowance
    usagePeriodStart: PERIOD_START,
    ...partial,
  });

  it("(a) internal business is NEVER message-limited, at any usage", () => {
    expect(isMessageLimitExceeded(usage({ isInternalAccount: true }))).toBe(false);
  });

  it("(b) normal trial business at the same usage IS limited", () => {
    expect(isMessageLimitExceeded(usage({}))).toBe(true);
  });

  it("(b) normal starter business at the same usage IS limited", () => {
    expect(isMessageLimitExceeded(usage({ plan: "starter" }))).toBe(true);
  });

  it("(c) SPOOF: string 'true' does not lift the limit", () => {
    expect(isMessageLimitExceeded(usage({ isInternalAccount: "true" }))).toBe(true);
  });
});

describe("internal owner comp — billing countdown (dashboard truthfulness)", () => {
  it("(a) internal countdown: plan 'internal', no days/limit/notices", () => {
    const cd = buildCountdown({
      plan: "trial",
      subscriptionStatus: "trialing",
      trialEndsAt: PAST,
      aiMessagesUsed: 5000,
      usagePeriodStart: PERIOD_START,
      isInternalAccount: true,
    });
    expect(cd.plan).toBe("internal");
    expect(cd.daysRemaining).toBeNull();
    expect(cd.messagesRemaining).toBeNull();
    expect(cd.messagesLimit).toBeNull();
    expect(cd.percentUsed).toBeNull();
    expect(cd.subscriptionEndsAt).toBeNull();
    expect(cd.notices).toEqual([]);
  });

  it("(b) normal expiring trial still produces day + usage notices", () => {
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const cd = buildCountdown({
      plan: "trial",
      subscriptionStatus: "trialing",
      trialEndsAt: soon,
      aiMessagesUsed: 990,
      usagePeriodStart: PERIOD_START,
    });
    expect(cd.plan).toBe("trial");
    expect(cd.daysRemaining).toBe(2);
    expect(cd.notices.length).toBeGreaterThan(0);
  });
});
