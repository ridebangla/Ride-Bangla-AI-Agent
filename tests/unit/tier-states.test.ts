/**
 * tier-states.test.ts — the three-state limit model (owner rule
 * 2026-10-22):
 *
 *  (1) HOLDER/internal: no limits at all (pinned in internal-comp.test.ts).
 *  (2) TRIAL: while a trial is ACTIVE, no usage quota bites — only the
 *      time-box. Previously the trial borrowed the starter allowance
 *      (1000/30d) mid-trial; that cap is gone.
 *  (3) FREE TIER: a lapsed trial resolves to a permanent free tier —
 *      usable, capped at 100 AI messages per 30-day usage period —
 *      instead of a hard inactive stop. Suspended / canceled / past_due
 *      and lapsed PAID plans still hard-stop; paid plans are unchanged.
 */
import { describe, it, expect, vi } from "vitest";

// The catalog read must degrade to the code catalog in tests (same
// pattern as inactive-notify.test.ts).
vi.mock("@/lib/admin-db", () => ({
  getAdminDb: () => {
    throw new Error("Admin SDK is not available in unit tests");
  },
  __resetAdminDbForTests: () => {},
}));

import {
  isSubscriptionActive,
  isInActiveTrial,
  isFreeTierBusiness,
  getSubscription,
} from "@/lib/subscription";
import {
  isMessageLimitExceeded,
  buildCountdown,
  checkMessageLimitExceeded,
} from "@/lib/billing-usage";
import { FREE_PLAN, codeCatalog, resolveChargePrice } from "@/lib/plan-catalog";
import { FREE_MESSAGES_PER_MONTH } from "@/lib/plans";
import { getUnscopedPrisma } from "@/lib/prisma";
import type { Business } from "@/lib/models";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const past = (d: number) => new Date(NOW - d * DAY);
const future = (d: number) => new Date(NOW + d * DAY);
const PERIOD_START = new Date(NOW - 60 * 60 * 1000);

function biz(partial: Record<string, unknown>): Business {
  return {
    id: "biz-test",
    name: "Test",
    slug: "test",
    isActive: true,
    ...partial,
  } as unknown as Business;
}

const IN_TRIAL = {
  plan: "trial",
  subscriptionStatus: "trialing",
  trialEndsAt: future(10),
};
const LAPSED_TRIAL = {
  plan: "trial",
  subscriptionStatus: "trialing",
  trialEndsAt: past(2),
};

describe("state 2 — active trial: no usage quotas", () => {
  it("in-trial business at 999,999 messages is NOT limited", () => {
    expect(
      isMessageLimitExceeded({
        ...IN_TRIAL,
        aiMessagesUsed: 999999,
        usagePeriodStart: PERIOD_START,
      })
    ).toBe(false);
  });

  it("in-trial business is NOT limited even when a catalog override is passed", () => {
    expect(
      isMessageLimitExceeded(
        { ...IN_TRIAL, aiMessagesUsed: 999999, usagePeriodStart: PERIOD_START },
        NOW,
        1000 // the old starter-borrowed cap, as the catalog would pass it
      )
    ).toBe(false);
  });

  it("in-trial countdown: no usage limit, but the day countdown stays", () => {
    const cd = buildCountdown(
      { ...IN_TRIAL, aiMessagesUsed: 999999, usagePeriodStart: PERIOD_START },
      NOW
    );
    expect(cd.plan).toBe("trial");
    expect(cd.messagesLimit).toBeNull();
    expect(cd.messagesRemaining).toBeNull();
    expect(cd.percentUsed).toBeNull();
    expect(cd.daysRemaining).toBe(10);
    expect(cd.notices.every((n) => n.type === "days")).toBe(true);
  });

  it("trial expiry still ends the trial (time-box intact)", () => {
    expect(isInActiveTrial(biz(LAPSED_TRIAL))).toBe(false);
    expect(isInActiveTrial(biz(IN_TRIAL))).toBe(true);
  });
});

describe("state 3 — free tier: lapsed trial, capped at 100", () => {
  it("FREE_MESSAGES_PER_MONTH is the owner's 100", () => {
    expect(FREE_MESSAGES_PER_MONTH).toBe(100);
    expect(FREE_PLAN.id).toBe("free");
    expect(FREE_PLAN.priceUsd).toBe(0);
    expect(FREE_PLAN.messagesPerMonth).toBe(100);
  });

  it("the free tier is NOT purchasable and NOT in the sale catalog", async () => {
    expect(codeCatalog().map((p) => p.id)).toEqual(["starter", "growth", "pro"]);
    expect(await resolveChargePrice("free", "monthly")).toBeNull();
  });

  it("lapsed trial gate: active as free tier", () => {
    const b = biz(LAPSED_TRIAL);
    expect(isFreeTierBusiness(b)).toBe(true);
    expect(isSubscriptionActive(b)).toBe(true);
  });

  it("free tier cap: 99 messages pass, 100 block", () => {
    expect(
      isMessageLimitExceeded({
        ...LAPSED_TRIAL,
        aiMessagesUsed: 99,
        usagePeriodStart: PERIOD_START,
      })
    ).toBe(false);
    expect(
      isMessageLimitExceeded({
        ...LAPSED_TRIAL,
        aiMessagesUsed: 100,
        usagePeriodStart: PERIOD_START,
      })
    ).toBe(true);
  });

  it("free tier countdown: plan 'free', limit 100, no end date", () => {
    const cd = buildCountdown(
      { ...LAPSED_TRIAL, aiMessagesUsed: 30, usagePeriodStart: PERIOD_START },
      NOW
    );
    expect(cd.plan).toBe("free");
    expect(cd.messagesLimit).toBe(100);
    expect(cd.messagesRemaining).toBe(70);
    expect(cd.daysRemaining).toBeNull();
    expect(cd.subscriptionEndsAt).toBeNull();
  });

  it("status 'expired' on a trial-origin doc is also free tier", () => {
    const b = biz({ plan: "trial", subscriptionStatus: "expired", trialEndsAt: past(5) });
    expect(isFreeTierBusiness(b)).toBe(true);
    expect(isSubscriptionActive(b)).toBe(true);
  });

  it("getSubscription reports a lapsed trial as plan 'free'", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.business.findUnique.mockResolvedValue({
      ...(biz(LAPSED_TRIAL) as unknown as Record<string, unknown>),
    });
    const sub = await getSubscription("biz-test");
    expect(sub.plan).toBe("free");
    expect(sub.isFreeTier).toBe(true);
    expect(sub.isInternal).toBe(false);
    expect(sub.isActive).toBe(true);
  });

  it("checkMessageLimitExceeded enforces the free cap through the DB path", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.business.findUnique.mockResolvedValue({
      id: "biz-test",
      ...LAPSED_TRIAL,
      aiMessagesUsed: 150,
      usagePeriodStart: PERIOD_START,
    });
    expect(await checkMessageLimitExceeded("biz-test")).toBe(true);
    db.business.findUnique.mockResolvedValue({
      id: "biz-test",
      ...LAPSED_TRIAL,
      aiMessagesUsed: 42,
      usagePeriodStart: PERIOD_START,
    });
    expect(await checkMessageLimitExceeded("biz-test")).toBe(false);
    db.business.findUnique.mockResolvedValue({
      id: "biz-test",
      ...IN_TRIAL,
      aiMessagesUsed: 999999,
      usagePeriodStart: PERIOD_START,
    });
    expect(await checkMessageLimitExceeded("biz-test")).toBe(false);
  });
});

describe("states that must still hard-stop / stay unchanged", () => {
  it("suspended lapsed trial is blocked completely (isActive kill-switch wins)", () => {
    const b = biz({ ...LAPSED_TRIAL, isActive: false });
    expect(isSubscriptionActive(b)).toBe(false);
  });

  it("status 'suspended' never resolves to free", () => {
    const b = biz({ plan: "trial", subscriptionStatus: "suspended", trialEndsAt: past(2) });
    expect(isFreeTierBusiness(b)).toBe(false);
    expect(isSubscriptionActive(b)).toBe(false);
  });

  it("canceled and past_due never resolve to free", () => {
    for (const subscriptionStatus of ["canceled", "past_due"]) {
      const b = biz({ plan: "trial", subscriptionStatus, trialEndsAt: past(2) });
      expect(isFreeTierBusiness(b)).toBe(false);
      expect(isSubscriptionActive(b)).toBe(false);
    }
  });

  it("a lapsed PAID plan does NOT drop to the free tier", () => {
    const b = biz({ plan: "starter", subscriptionStatus: "expired" });
    expect(isFreeTierBusiness(b)).toBe(false);
    expect(isSubscriptionActive(b)).toBe(false);
  });

  it("paid plans keep their exact caps", () => {
    expect(
      isMessageLimitExceeded({
        subscriptionStatus: "active",
        plan: "starter",
        aiMessagesUsed: 1000,
        usagePeriodStart: PERIOD_START,
      })
    ).toBe(true);
    expect(
      isMessageLimitExceeded({
        subscriptionStatus: "active",
        plan: "growth",
        aiMessagesUsed: 4999,
        usagePeriodStart: PERIOD_START,
      })
    ).toBe(false);
  });
});
