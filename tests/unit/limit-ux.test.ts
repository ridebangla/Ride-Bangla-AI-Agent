/**
 * limit-ux.test.ts — Limit-exhausted popup/bar (owner directive 2026-10-22).
 *
 * Covers:
 *  1. The pure reset-line renderer for the doctrine's daily-exhausted and
 *     hourly-exhausted shapes (staged fixtures) — both render the owner's
 *     exact reset phrases — plus the live platform shape (30-day usage
 *     period reset).
 *  2. The popup working texts VERBATIM (owner's dictated phrases).
 *  3. The spend gate exemptions: internal/company accounts never exhaust.
 *  4. getLimitExhaustedState: exhausted starter → period reset state;
 *     internal → null; not-exhausted → null; unknown business → null.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  LIMIT_UX_TEXTS,
  buildLimitBody,
  formatResetDateTime,
  hoursUntil,
  resetSlotPhrase,
  type LimitReset,
} from "@/lib/limit-ux";
import {
  isMessageLimitExceeded,
  getLimitExhaustedState,
  USAGE_PERIOD_MS,
} from "@/lib/billing-usage";
import { getUnscopedPrisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Staged admin-db fake: empty ai_plans (→ code catalog) and no
// company_identity doc (→ projection flags only).
// ---------------------------------------------------------------------------
vi.mock("@/lib/admin-db", () => ({
  getAdminDb: () => ({
    collection: (_name: string) => ({
      get: async () => ({ forEach: (_cb: (d: unknown) => void) => {} }),
      doc: (_id: string) => ({ get: async () => ({ exists: false }) }),
      where: () => ({
        get: async () => ({ forEach: (_cb: (d: unknown) => void) => {} }),
      }),
    }),
  }),
  __resetAdminDbForTests: () => {},
}));

const NOW = new Date("2026-10-22T13:42:00+06:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

function stageBusiness(doc: Record<string, unknown> | null) {
  const db = getUnscopedPrisma() as unknown as {
    business: { findUnique: { mockResolvedValue: (v: unknown) => void } };
  };
  db.business.findUnique.mockResolvedValue(doc);
}

describe("limit-ux: owner working texts (verbatim)", () => {
  it("headline is the owner's exact phrase", () => {
    expect(LIMIT_UX_TEXTS.headline).toBe("আপনার সীমা শেষ হয়ে গেছে");
  });

  it("view-plans button is the owner's exact phrase", () => {
    expect(LIMIT_UX_TEXTS.viewPlans).toBe("প্ল্যানগুলো দেখুন");
  });

  it("CTA is the owner's own wording, verbatim", () => {
    expect(LIMIT_UX_TEXTS.cta).toBe("Update your package");
  });

  it("body template is the owner's exact template with a {slot}", () => {
    expect(LIMIT_UX_TEXTS.bodyTemplate).toBe(
      "আপনার বর্তমান প্ল্যানের সীমা শেষ। আবার ব্যবহার করতে পারবেন {slot}। এখনই চালিয়ে যেতে চাইলে প্ল্যান আপগ্রেড করুন।"
    );
  });
});

describe("limit-ux: reset-line rendering (daily / hourly / period)", () => {
  it("daily-exhausted renders 'পরের দিন'", () => {
    const reset: LimitReset = { kind: "daily" };
    expect(resetSlotPhrase(reset, NOW)).toBe("পরের দিন");
    expect(buildLimitBody(reset, NOW)).toBe(
      "আপনার বর্তমান প্ল্যানের সীমা শেষ। আবার ব্যবহার করতে পারবেন পরের দিন। এখনই চালিয়ে যেতে চাইলে প্ল্যান আপগ্রেড করুন।"
    );
  });

  it("hourly-exhausted renders 'আর X ঘণ্টা পরে' with a live countdown", () => {
    const inTwoAndAHalfHours: LimitReset = {
      kind: "hourly",
      resetAtMs: NOW + 2.5 * 60 * 60 * 1000,
    };
    expect(hoursUntil(inTwoAndAHalfHours.resetAtMs, NOW)).toBe(3);
    expect(resetSlotPhrase(inTwoAndAHalfHours, NOW)).toBe("আর 3 ঘণ্টা পরে");
    expect(buildLimitBody(inTwoAndAHalfHours, NOW)).toBe(
      "আপনার বর্তমান প্ল্যানের সীমা শেষ। আবার ব্যবহার করতে পারবেন আর 3 ঘণ্টা পরে। এখনই চালিয়ে যেতে চাইলে প্ল্যান আপগ্রেড করুন।"
    );
  });

  it("hourly countdown never shows 0 hours", () => {
    const inTwentyMinutes: LimitReset = {
      kind: "hourly",
      resetAtMs: NOW + 20 * 60 * 1000,
    };
    expect(resetSlotPhrase(inTwentyMinutes, NOW)).toBe("আর 1 ঘণ্টা পরে");
  });

  it("period reset renders the actual reset date", () => {
    const periodStart = NOW - 5 * DAY;
    const reset: LimitReset = {
      kind: "period",
      resetAtMs: periodStart + USAGE_PERIOD_MS,
    };
    const slot = resetSlotPhrase(reset, NOW);
    expect(slot).toBe(formatResetDateTime(periodStart + USAGE_PERIOD_MS));
    // The 30-day period starting 2026-10-17 resets 2026-11-16.
    expect(slot).toContain("2026");
    expect(buildLimitBody(reset, NOW)).toContain(slot);
  });
});

describe("limit-ux: internal/company exemption at the spend gate", () => {
  const exhaustedUsage = {
    plan: "starter",
    subscriptionStatus: "active",
    aiMessagesUsed: 10000,
    usagePeriodStart: new Date(NOW - 5 * DAY),
  };

  it("isInternalAccount=true is never exhausted, however high the usage", () => {
    expect(
      isMessageLimitExceeded(
        { ...exhaustedUsage, isInternalAccount: true },
        NOW,
        1000
      )
    ).toBe(false);
  });

  it("manualActiveOverride=true lifts the cap entirely", () => {
    expect(
      isMessageLimitExceeded(
        { ...exhaustedUsage, manualActiveOverride: true },
        NOW,
        1000
      )
    ).toBe(false);
  });

  it("a normal tenant at the allowance IS exhausted", () => {
    expect(
      isMessageLimitExceeded(
        { ...exhaustedUsage, aiMessagesUsed: 1000 },
        NOW,
        1000
      )
    ).toBe(true);
  });

  it("a normal tenant below the allowance is not exhausted", () => {
    expect(
      isMessageLimitExceeded(
        { ...exhaustedUsage, aiMessagesUsed: 999 },
        NOW,
        1000
      )
    ).toBe(false);
  });
});

describe("limit-ux: getLimitExhaustedState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("null businessId (Super Admin) → null", async () => {
    expect(await getLimitExhaustedState(null)).toBeNull();
  });

  it("unknown business → null", async () => {
    stageBusiness(null);
    expect(await getLimitExhaustedState("nope")).toBeNull();
  });

  it("exhausted starter tenant → period reset state", async () => {
    const start = new Date(NOW - 5 * DAY);
    stageBusiness({
      plan: "starter",
      subscriptionStatus: "active",
      aiMessagesUsed: 1000,
      usagePeriodStart: start,
    });
    const state = await getLimitExhaustedState("biz-1");
    expect(state).not.toBeNull();
    expect(state!.exhausted).toBe(true);
    expect(state!.planId).toBe("starter");
    expect(state!.limit).toBe(1000);
    expect(state!.used).toBe(1000);
    expect(state!.reset.kind).toBe("period");
    if (state!.reset.kind === "period") {
      expect(state!.reset.resetAtMs).toBe(start.getTime() + USAGE_PERIOD_MS);
    }
  });

  it("exhausted free-tier tenant → period reset state", async () => {
    const start = new Date(NOW - 5 * DAY);
    stageBusiness({
      plan: "trial",
      subscriptionStatus: "expired",
      trialEndsAt: new Date(NOW - DAY),
      aiMessagesUsed: 100,
      usagePeriodStart: start,
    });
    const state = await getLimitExhaustedState("biz-free");
    expect(state).not.toBeNull();
    expect(state!.limit).toBe(100);
    expect(state!.reset.kind).toBe("period");
  });

  it("internal account with massive usage → null (exempt)", async () => {
    stageBusiness({
      plan: "starter",
      subscriptionStatus: "active",
      aiMessagesUsed: 999999,
      usagePeriodStart: new Date(NOW - 5 * DAY),
      isInternalAccount: true,
    });
    expect(await getLimitExhaustedState("biz-internal")).toBeNull();
  });

  it("tenant below the allowance → null", async () => {
    stageBusiness({
      plan: "growth",
      subscriptionStatus: "active",
      aiMessagesUsed: 10,
      usagePeriodStart: new Date(NOW - 5 * DAY),
    });
    expect(await getLimitExhaustedState("biz-ok")).toBeNull();
  });
});

describe("limit-ux: popup/bar static render (staged catalog fixtures)", () => {
  it("renders the full popup: texts, live-catalog plans, CTA", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const { LimitExhaustedPopupContent } = await import(
      "@/components/billing/limit-exhausted-popup"
    );
    const { codeCatalog } = await import("@/lib/plan-catalog");

    // Staged CatalogPlanView fixtures in the LIVE catalog's shape
    // (id/name/tagline/messagesPerMonth/price + a live offer).
    const stagedPlans = codeCatalog().map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      messagesPerMonth: p.messagesPerMonth,
      active: true,
      source: p.source,
      monthly: {
        regularPriceUsd: p.priceUsd,
        offer:
          p.id === "growth"
            ? {
                offerId: "off-launch",
                name: "Launch offer",
                endsAt: new Date(NOW + 7 * DAY).toISOString(),
                effectivePriceUsd: 39,
                regularPriceUsd: p.priceUsd,
              }
            : null,
      },
      yearly: {
        regularPriceUsd: p.yearlyPriceUsd,
        offer: null,
      },
    }));

    const html = renderToStaticMarkup(
      React.createElement(LimitExhaustedPopupContent, {
        // Relative to the real clock (the component counts down from now).
        reset: { kind: "hourly", resetAtMs: Date.now() + 2.5 * 60 * 60 * 1000 },
        plans: stagedPlans,
        currentPlanId: "starter",
        used: 1000,
        limit: 1000,
        onClose: () => {},
      })
    );

    // Owner's exact texts.
    expect(html).toContain("আপনার সীমা শেষ হয়ে গেছে");
    expect(html).toContain("আর 3 ঘণ্টা পরে");
    expect(html).toContain("Update your package");
    // Plans from the catalog (never hardcoded): names, allowances, prices.
    expect(html).toContain("Starter");
    expect(html).toContain("Growth");
    expect(html).toContain("Pro");
    expect(html).toContain("1,000");
    expect(html).toContain("15,000");
    expect(html).toContain("$19");
    expect(html).toContain("$39");
    expect(html).toContain("Launch offer");
    expect(html).toContain("Current plan");
    // Upgrade path.
    expect(html).toContain('href="/billing"');
    // Usage line.
    expect(html).toContain("1,000 / 1,000");
  });

  it("bar renders the headline, reset phrase and view-plans button", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const { LimitUxProvider } = await import(
      "@/components/billing/limit-ux-context"
    );
    const { LimitExhaustedBar } = await import(
      "@/components/billing/limit-exhausted-bar"
    );

    const html = renderToStaticMarkup(
      React.createElement(
        LimitUxProvider,
        { exhausted: true },
        React.createElement(LimitExhaustedBar, { reset: { kind: "daily" } })
      )
    );
    expect(html).toContain("আপনার সীমা শেষ হয়ে গেছে");
    expect(html).toContain("পরের দিন");
    expect(html).toContain("প্ল্যানগুলো দেখুন");
  });

  it("bar renders nothing when not exhausted", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const { LimitUxProvider } = await import(
      "@/components/billing/limit-ux-context"
    );
    const { LimitExhaustedBar } = await import(
      "@/components/billing/limit-exhausted-bar"
    );

    const html = renderToStaticMarkup(
      React.createElement(
        LimitUxProvider,
        { exhausted: false },
        React.createElement(LimitExhaustedBar, { reset: { kind: "daily" } })
      )
    );
    expect(html).not.toContain("আপনার সীমা শেষ হয়ে গেছে");
  });
});
