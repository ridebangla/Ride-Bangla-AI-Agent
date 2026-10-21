/**
 * Tenant-control round-trips + automatic notifications (owner directive
 * 2026-10-21, platform side).
 *
 * Part 1 pins the contract between the Admin Console's writes and THIS
 * platform's gate: each test applies exactly the field payload a console
 * control writes (suspend / reactivate / extend trial / override) to a
 * fixture business and asks isSubscriptionActive() — the console control
 * only "works" if the gate flips. Two tests deliberately assert the OLD
 * payloads do NOT flip the gate: they document the defects the console
 * fix repaired (extend-trial used to move trialEndsAt only; reactivate
 * used to restore a lapsed trial unchanged).
 *
 * Part 2 pins the automatic-notification decisions in
 * src/lib/inactive-notify.ts (pure functions): who gets notified, the
 * episode dedupe, the 7-day repeat, and the fresh-human-notice
 * protection.
 */
import { describe, it, expect, vi } from "vitest";

// The sweep's writer (runInactiveNotifySweep) is not exercised here —
// only the pure decision functions are. Mock the Admin SDK seam the
// module imports (same pattern as billing-phase2.test.ts) so the suite
// never needs firebase-admin credentials.
vi.mock("@/lib/admin-db", () => ({
  getAdminDb: () => {
    throw new Error("Admin SDK is not available in unit tests");
  },
  __resetAdminDbForTests: () => {},
}));

import { isSubscriptionActive } from "@/lib/subscription";
import {
  decideAutoNotice,
  shouldSendAutoNotice,
  type BusinessGateFields,
} from "@/lib/inactive-notify";
import type { Business } from "@/lib/models";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const past = (days: number) => new Date(NOW - days * DAY);
const future = (days: number) => new Date(NOW + days * DAY);

function biz(partial: Record<string, unknown>): Business {
  return {
    id: "biz-test",
    name: "Test",
    slug: "test",
    isActive: true,
    ...partial,
  } as unknown as Business;
}

/** Apply a console write payload to a fixture the way Firestore would. */
function applied(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Business {
  return biz({ ...base, ...patch });
}

describe("console writes vs the platform gate", () => {
  const paidActive = {
    plan: "growth",
    subscriptionStatus: "active",
    subscriptionEndsAt: future(20),
  };

  it("suspend payload flips an active tenant to inactive", () => {
    const after = applied(paidActive, {
      subscriptionStatus: "suspended",
      previousSubscriptionStatus: "active",
    });
    expect(isSubscriptionActive(after)).toBe(false);
  });

  it("extend-trial FIX: status restore + new end revives an EXPIRED tenant", () => {
    const expired = { plan: "trial", subscriptionStatus: "expired", trialEndsAt: past(5) };
    const fixed = applied(expired, {
      trialEndsAt: future(7),
      subscriptionStatus: "trialing",
      previousSubscriptionStatus: null,
    });
    expect(isSubscriptionActive(fixed)).toBe(true);
  });

  it("extend-trial OLD payload (date only) did NOT revive an expired tenant", () => {
    const expired = { plan: "trial", subscriptionStatus: "expired", trialEndsAt: past(5) };
    const old = applied(expired, { trialEndsAt: future(7) });
    expect(isSubscriptionActive(old)).toBe(false);
  });

  it("reactivate FIX: suspended trial-lapsed tenant + trial renewal is active", () => {
    const suspended = {
      plan: "trial",
      subscriptionStatus: "suspended",
      previousSubscriptionStatus: "trialing",
      trialEndsAt: past(3),
    };
    const fixed = applied(suspended, {
      subscriptionStatus: "trialing",
      previousSubscriptionStatus: null,
      trialEndsAt: future(7),
    });
    expect(isSubscriptionActive(fixed)).toBe(true);
  });

  it("reactivate OLD payload (status only) left the tenant inactive", () => {
    const suspended = {
      plan: "trial",
      subscriptionStatus: "suspended",
      previousSubscriptionStatus: "trialing",
      trialEndsAt: past(3),
    };
    const old = applied(suspended, {
      subscriptionStatus: "trialing",
      previousSubscriptionStatus: null,
    });
    expect(isSubscriptionActive(old)).toBe(false);
  });

  it("reactivate also lifts the isActive kill-switch", () => {
    const killed = { ...paidActive, isActive: false };
    expect(isSubscriptionActive(biz(killed))).toBe(false);
    const after = applied(killed, {
      subscriptionStatus: "active",
      isActive: true,
    });
    expect(isSubscriptionActive(after)).toBe(true);
  });

  it("manual override payload activates; removing it restores the gate result", () => {
    const expired = { plan: "starter", subscriptionStatus: "expired" };
    const on = applied(expired, { manualActiveOverride: true });
    expect(isSubscriptionActive(on)).toBe(true);
    const off = applied(expired, { manualActiveOverride: false });
    expect(isSubscriptionActive(off)).toBe(false);
  });

  it("internal account ignores a suspend payload (why the console refuses)", () => {
    const internal = { ...paidActive, isInternalAccount: true };
    const after = applied(internal, { subscriptionStatus: "suspended" });
    expect(isSubscriptionActive(after)).toBe(true);
  });
});

describe("automatic notification decisions", () => {
  const fields = (partial: Record<string, unknown>): BusinessGateFields =>
    ({ isActive: true, ...partial }) as BusinessGateFields;

  it("active paid tenant: no notice", () => {
    expect(
      decideAutoNotice(
        fields({ subscriptionStatus: "active", subscriptionEndsAt: future(20) }),
        NOW
      )
    ).toBeNull();
  });

  it("trial ending within 3 days: trial_ending, keyed by the trial end", () => {
    const endsAt = future(2);
    const d = decideAutoNotice(
      fields({ subscriptionStatus: "trialing", trialEndsAt: endsAt }),
      NOW
    );
    expect(d?.kind).toBe("trial_ending");
    expect(d?.episodeKey).toBe(`trial:${endsAt.toISOString()}`);
  });

  it("trial ending in 10 days: no notice yet", () => {
    expect(
      decideAutoNotice(
        fields({ subscriptionStatus: "trialing", trialEndsAt: future(10) }),
        NOW
      )
    ).toBeNull();
  });

  it("lapsed trial: trial_ended", () => {
    const d = decideAutoNotice(
      fields({ subscriptionStatus: "trialing", trialEndsAt: past(1) }),
      NOW
    );
    expect(d?.kind).toBe("trial_ended");
  });

  it("expired / past_due / suspended / period-lapsed: subscription_inactive", () => {
    for (const partial of [
      { subscriptionStatus: "expired" },
      { subscriptionStatus: "past_due" },
      { subscriptionStatus: "suspended" },
      { subscriptionStatus: "active", subscriptionEndsAt: past(2) },
    ]) {
      expect(decideAutoNotice(fields(partial), NOW)?.kind).toBe(
        "subscription_inactive"
      );
    }
  });

  it("internal and override tenants: never notified", () => {
    expect(
      decideAutoNotice(
        fields({ subscriptionStatus: "expired", isInternalAccount: true }),
        NOW
      )
    ).toBeNull();
    expect(
      decideAutoNotice(
        fields({ subscriptionStatus: "expired", manualActiveOverride: true }),
        NOW
      )
    ).toBeNull();
  });

  it("dedupe: same episode within 7 days is not re-sent; after 7 days it is", () => {
    const decision = decideAutoNotice(
      fields({ subscriptionStatus: "expired" }),
      NOW
    )!;
    const marked = fields({
      subscriptionStatus: "expired",
      autoNotify: {
        kind: decision.kind,
        episodeKey: decision.episodeKey,
        sentAt: past(1),
      },
    });
    expect(shouldSendAutoNotice(marked, decision, NOW)).toBe(false);
    const markedOld = fields({
      subscriptionStatus: "expired",
      autoNotify: {
        kind: decision.kind,
        episodeKey: decision.episodeKey,
        sentAt: past(8),
      },
    });
    expect(shouldSendAutoNotice(markedOld, decision, NOW)).toBe(true);
  });

  it("dedupe: trial_ending fires once per trial, never repeats", () => {
    const decision = decideAutoNotice(
      fields({ subscriptionStatus: "trialing", trialEndsAt: future(2) }),
      NOW
    )!;
    const marked = fields({
      subscriptionStatus: "trialing",
      trialEndsAt: future(2),
      autoNotify: {
        kind: decision.kind,
        episodeKey: decision.episodeKey,
        sentAt: past(8),
      },
    });
    expect(shouldSendAutoNotice(marked, decision, NOW)).toBe(false);
  });

  it("a fresh human notice is protected; an old one is not", () => {
    const decision = decideAutoNotice(
      fields({ subscriptionStatus: "expired" }),
      NOW
    )!;
    const freshHuman = fields({
      subscriptionStatus: "expired",
      adminNotice: { createdBy: "admin@ridebangla.bd", createdAt: past(1) },
    });
    expect(shouldSendAutoNotice(freshHuman, decision, NOW)).toBe(false);
    const oldHuman = fields({
      subscriptionStatus: "expired",
      adminNotice: { createdBy: "admin@ridebangla.bd", createdAt: past(9) },
    });
    expect(shouldSendAutoNotice(oldHuman, decision, NOW)).toBe(true);
    const systemNotice = fields({
      subscriptionStatus: "expired",
      adminNotice: { createdBy: "system:auto-notify", createdAt: past(1) },
    });
    // A system notice does not protect — but the dedupe marker does, so
    // use a marker-free doc here to isolate the protection rule.
    expect(shouldSendAutoNotice(systemNotice, decision, NOW)).toBe(true);
  });
});
