import { describe, it, expect } from "vitest";
import { isSubscriptionActive } from "@/lib/subscription";
import {
  effectiveAiMessagesUsed,
  isMessageLimitExceeded,
  USAGE_PERIOD_MS,
} from "@/lib/billing-usage";

// Regression tests for the 2026-10-20 security attack-test fixes:
//  1. status "active" + a recorded subscriptionEndsAt in the past must be
//     INACTIVE (manual-claim / wallet subscriptions previously ran forever).
//  2. The plan message-limit gate (pure helpers) — metering previously never
//     refused a message, so any plan could send unlimited AI messages.

const biz = (over: Record<string, unknown>) =>
  ({
    id: "biz-1",
    name: "Test",
    slug: "test",
    siteKey: "rbsite-x",
    isActive: true,
    subscriptionStatus: "active",
    ...over,
  }) as never;

describe("subscriptionEndsAt gate (attack-test fix 1)", () => {
  it("active + past subscriptionEndsAt => inactive", () => {
    expect(
      isSubscriptionActive(
        biz({ subscriptionEndsAt: new Date(Date.now() - 1000) })
      )
    ).toBe(false);
  });
  it("active + future subscriptionEndsAt => active", () => {
    expect(
      isSubscriptionActive(
        biz({ subscriptionEndsAt: new Date(Date.now() + 86400000) })
      )
    ).toBe(true);
  });
  it("active + no subscriptionEndsAt (Stripe-managed) => active", () => {
    expect(isSubscriptionActive(biz({}))).toBe(true);
  });
  it("manual override still rescues an expired business", () => {
    expect(
      isSubscriptionActive(
        biz({
          subscriptionEndsAt: new Date(Date.now() - 1000),
          manualActiveOverride: true,
        })
      )
    ).toBe(true);
  });
});

describe("message-limit gate (attack-test fix 2)", () => {
  const now = Date.now();
  it("starter at limit => exceeded", () => {
    expect(
      isMessageLimitExceeded(
        { plan: "starter", aiMessagesUsed: 1000, usagePeriodStart: new Date(now) },
        now
      )
    ).toBe(true);
  });
  it("starter below limit => not exceeded", () => {
    expect(
      isMessageLimitExceeded(
        { plan: "starter", aiMessagesUsed: 999, usagePeriodStart: new Date(now) },
        now
      )
    ).toBe(false);
  });
  it("stale usage period resets the effective count", () => {
    expect(
      effectiveAiMessagesUsed(
        {
          plan: "starter",
          aiMessagesUsed: 5000,
          usagePeriodStart: new Date(now - USAGE_PERIOD_MS - 1),
        },
        now
      )
    ).toBe(0);
  });
  it("trial shares the starter allowance", () => {
    expect(
      isMessageLimitExceeded(
        { plan: "trial", aiMessagesUsed: 1000, usagePeriodStart: new Date(now) },
        now
      )
    ).toBe(true);
  });
  it("unknown plan has no catalog limit (subscription gate covers it)", () => {
    expect(
      isMessageLimitExceeded(
        { plan: "unknown", aiMessagesUsed: 999999, usagePeriodStart: new Date(now) },
        now
      )
    ).toBe(false);
  });
});
