import { describe, it, expect } from "vitest";
import { canAiWork } from "@/lib/owner-controls/channel-controls";
import { decideAiSendWithOwnerControls } from "@/lib/owner-controls/send-path-gate";
import { decideSendGate } from "@/lib/owner-controls/send-gate";
import { couponSendBlockReason } from "@/lib/owner-controls/offer-controls";
import { composePriceAnswer } from "@/lib/business-rules";
import { resolveTenantOnboardingBranch } from "@/lib/landing";
import { checkStock } from "@/lib/inventory/stock-guard";
import { decideRatingRequest, decideReviewRequest } from "@/lib/order-ratings";
import {
  queueOrderRatingRequest,
  type RatingStore,
} from "@/lib/order-rating-requests";

/**
 * TEAM F (2026-11-03) — tenant end-to-end guards, pure-layer proof.
 * Every test here asserts a tenant rule from the task with no database
 * and no invented business data: isolation is PROVED by cross-tenant
 * inputs being refused, not asserted. Live-browser behaviour with a
 * real test tenant account remains UNVERIFIED (head's delegation).
 */

describe("canAiWork — landing page counts as the website source", () => {
  it("no website + unpublished landing + trial => blocked", () => {
    expect(
      canAiWork({ websiteAttached: false, hasActiveTrialOrPaid: true })
    ).toBe(false);
  });
  it("no website + PUBLISHED landing + trial => works", () => {
    expect(
      canAiWork({
        websiteAttached: false,
        landingPagePublished: true,
        hasActiveTrialOrPaid: true,
      })
    ).toBe(true);
  });
  it("published landing but no trial/paid => still blocked", () => {
    expect(
      canAiWork({
        websiteAttached: false,
        landingPagePublished: true,
        hasActiveTrialOrPaid: false,
      })
    ).toBe(false);
  });
  it("old callers (no landing field) behave exactly as before", () => {
    expect(
      canAiWork({ websiteAttached: true, hasActiveTrialOrPaid: true })
    ).toBe(true);
    expect(
      canAiWork({ websiteAttached: false, hasActiveTrialOrPaid: true })
    ).toBe(false);
  });
  it("internal holder still passes without any source", () => {
    expect(
      canAiWork({
        websiteAttached: false,
        hasActiveTrialOrPaid: false,
        isInternalHolder: true,
      })
    ).toBe(true);
  });
});

describe("decideAiSendWithOwnerControls — single onboarding definition", () => {
  const base = {
    businessId: "biz-a",
    doc: null,
    docError: false,
    channel: "whatsapp",
    conversationAiEnabled: true,
    globalAiOff: false,
    nowMs: 1_000,
  } as const;
  it("landing-only tenant passes the onboarding gate for messages", () => {
    expect(
      decideAiSendWithOwnerControls({
        ...base,
        onboarding: {
          websiteAttached: false,
          landingPagePublished: true,
          hasActiveTrialOrPaid: true,
        },
        kind: "message",
      })
    ).toEqual({ allowed: true });
  });
  it("cross-tenant doc blocks", () => {
    expect(
      decideAiSendWithOwnerControls({
        ...base,
        doc: {
          businessId: "biz-b",
          channelControls: {},
          commentMode: "auto",
        },
        onboarding: {
          websiteAttached: true,
          hasActiveTrialOrPaid: true,
        },
        kind: "message",
      })
    ).toMatchObject({ allowed: false, reason: "cross_tenant" });
  });
  it("offer with NO offer control blocks (missing = silence)", () => {
    expect(
      decideAiSendWithOwnerControls({
        ...base,
        onboarding: {
          websiteAttached: true,
          hasActiveTrialOrPaid: true,
        },
        kind: "offer",
        offerControl: null,
      })
    ).toMatchObject({ allowed: false, reason: "offer_not_enabled" });
  });
  it("offer with paused control blocks and keeps content", () => {
    expect(
      decideAiSendWithOwnerControls({
        ...base,
        onboarding: {
          websiteAttached: true,
          hasActiveTrialOrPaid: true,
        },
        kind: "offer",
        offerControl: {
          enabled: true,
          paused: true,
          contentFromOwnerConfig: true,
        },
      })
    ).toMatchObject({ allowed: false, reason: "offer_paused" });
  });
});

describe("decideSendGate — fail-closed outbound sends", () => {
  it("missing control record blocks", () => {
    expect(
      decideSendGate({
        businessId: "biz-a",
        sendType: "review_ask_text",
        control: null,
        content: { text: "Please review us" },
      })
    ).toMatchObject({ allowed: false, reason: "missing_config" });
  });
  it("control from another tenant blocks (cross_tenant)", () => {
    expect(
      decideSendGate({
        businessId: "biz-a",
        sendType: "review_ask_text",
        control: {
          businessId: "biz-b",
          sendType: "review_ask_text",
          enabled: true,
          paused: false,
        },
        content: { text: "Please review us" },
      })
    ).toMatchObject({ allowed: false, reason: "cross_tenant" });
  });
  it("disabled and paused controls block; enabled + text passes", () => {
    const content = { text: "Please review us" };
    expect(
      decideSendGate({
        businessId: "biz-a",
        sendType: "review_ask_text",
        control: {
          businessId: "biz-a",
          sendType: "review_ask_text",
          enabled: false,
          paused: false,
        },
        content,
      })
    ).toMatchObject({ allowed: false, reason: "disabled" });
    expect(
      decideSendGate({
        businessId: "biz-a",
        sendType: "review_ask_text",
        control: {
          businessId: "biz-a",
          sendType: "review_ask_text",
          enabled: true,
          paused: true,
        },
        content,
      })
    ).toMatchObject({ allowed: false, reason: "paused" });
    expect(
      decideSendGate({
        businessId: "biz-a",
        sendType: "review_ask_text",
        control: {
          businessId: "biz-a",
          sendType: "review_ask_text",
          enabled: true,
          paused: false,
        },
        content,
      })
    ).toMatchObject({ allowed: true });
  });
  it("paused coupon sends nothing, cross-tenant coupon is not found-equivalent", () => {
    const coupon = {
      businessId: "biz-a",
      code: "SAVE10",
      type: "percentage" as const,
      value: 10,
      expiresAt: "2030-01-01",
      minOrder: 0,
      maxUses: 100,
      uses: 0,
      allowMultiple: false,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      status: "paused",
    };
    expect(couponSendBlockReason(coupon, "biz-a")).toBe("paused");
    expect(couponSendBlockReason({ ...coupon, status: "active" }, "biz-b")).toBe(
      "cross_tenant"
    );
    expect(couponSendBlockReason(null, "biz-a")).toBe("not_configured");
  });
});

describe("composePriceAnswer — price + delivery + total, never guessed", () => {
  it("states price + delivery + total together when both are known", () => {
    expect(
      composePriceAnswer({
        price: 500,
        priceCurrency: "BDT",
        deliveryCharge: { amount: 60, currency: "BDT" },
      })
    ).toEqual({
      ok: true,
      price: 500,
      deliveryCharge: 60,
      total: 560,
      currency: "BDT",
    });
  });
  it("free delivery (0) is a real figure, not a missing charge", () => {
    const r = composePriceAnswer({
      price: 500,
      deliveryCharge: { amount: 0, currency: "BDT" },
    });
    expect(r).toEqual({
      ok: true,
      price: 500,
      deliveryCharge: 0,
      total: 500,
      currency: "BDT",
    });
  });
  it("missing delivery charge BLOCKS the total (ask/pending, never guess)", () => {
    expect(
      composePriceAnswer({ price: 500, deliveryCharge: null })
    ).toEqual({ ok: false, reason: "missing_delivery_charge" });
  });
  it("currency mismatch blocks instead of converting", () => {
    expect(
      composePriceAnswer({
        price: 500,
        priceCurrency: "USD",
        deliveryCharge: { amount: 60, currency: "BDT" },
      })
    ).toEqual({ ok: false, reason: "currency_mismatch" });
  });
  it("missing price blocks; no registration-fee field exists to leak", () => {
    expect(composePriceAnswer({ price: null, deliveryCharge: { amount: 60, currency: "BDT" } })).toEqual(
      { ok: false, reason: "missing_price" }
    );
  });
});

describe("resolveTenantOnboardingBranch — all four approved branches", () => {
  it("claimed but unindexed website => website_verify (never trusted)", () => {
    expect(
      resolveTenantOnboardingBranch({
        websiteClaimed: true,
        websiteVerified: false,
        landingPublished: false,
        categoryCount: 2,
        productCount: 5,
      }).branch
    ).toBe("website_verify");
  });
  it("no website + unpublished landing => landing_page", () => {
    expect(
      resolveTenantOnboardingBranch({
        websiteClaimed: false,
        websiteVerified: false,
        landingPublished: false,
        categoryCount: 0,
        productCount: 0,
      }).branch
    ).toBe("landing_page");
  });
  it("verified website + no categories => landing_category with fallback group", () => {
    const r = resolveTenantOnboardingBranch({
      websiteClaimed: true,
      websiteVerified: true,
      landingPublished: false,
      categoryCount: 0,
      productCount: 3,
    });
    expect(r.branch).toBe("landing_category");
    expect(r.landingFallbackGroup).toBe(true);
  });
  it("categories but no products => catalog_intake needs photos + names", () => {
    const r = resolveTenantOnboardingBranch({
      websiteClaimed: true,
      websiteVerified: true,
      landingPublished: false,
      categoryCount: 2,
      productCount: 0,
    });
    expect(r.branch).toBe("catalog_intake");
    expect(r.catalogIntakeNeeds).toEqual(["photos", "names"]);
  });
  it("published landing page substitutes for a website source", () => {
    expect(
      resolveTenantOnboardingBranch({
        websiteClaimed: false,
        websiteVerified: false,
        landingPublished: true,
        categoryCount: 1,
        productCount: 1,
      }).branch
    ).toBe("complete");
  });
});

describe("stock-guard — tenant isolation + oversell block", () => {
  const req = {
    businessId: "biz-a",
    productId: "p1",
    variantId: null,
    productName: "Widget",
    quantity: 2,
  };
  it("a snapshot from another tenant never satisfies a request", () => {
    const r = checkStock(req, {
      businessId: "biz-b",
      productId: "p1",
      variantId: null,
      stockKnown: true,
      availableQuantity: 99,
      source: "ledger",
    });
    expect(r.mayPromise).toBe(false);
    expect(r.outcome).toBe("unknown-stock");
  });
  it("zero stock blocks the sale answer", () => {
    const r = checkStock(req, {
      businessId: "biz-a",
      productId: "p1",
      variantId: null,
      stockKnown: true,
      availableQuantity: 0,
      source: "ledger",
    });
    expect(r.mayPromise).toBe(false);
    expect(r.outcome).toBe("out-of-stock");
  });
  it("never-entered stock is unknown, never 'probably in stock'", () => {
    const r = checkStock(req, {
      businessId: "biz-a",
      productId: "p1",
      variantId: null,
      stockKnown: false,
      availableQuantity: null,
      source: "ledger",
    });
    expect(r.mayPromise).toBe(false);
    expect(r.outcome).toBe("unknown-stock");
  });
  it("sufficient ledger stock may be promised", () => {
    const r = checkStock(req, {
      businessId: "biz-a",
      productId: "p1",
      variantId: null,
      stockKnown: true,
      availableQuantity: 5,
      source: "ledger",
    });
    expect(r.mayPromise).toBe(true);
    expect(r.outcome).toBe("available");
  });
});

describe("review gates — real-use gating, tenant switch, no leakage", () => {
  it("star-rating request needs a real move TO confirmed + chat link", () => {
    expect(
      decideRatingRequest({
        status: "confirmed",
        previousStatus: "pending",
        conversationId: "conv-1",
        alreadyRequested: false,
      })
    ).toEqual({ request: true });
    expect(
      decideRatingRequest({
        status: "pending",
        previousStatus: null,
        conversationId: "conv-1",
        alreadyRequested: false,
      })
    ).toMatchObject({ request: false, reason: "not_confirmed" });
  });
  it("delivered review request needs tenant switch + link + delivered phase", () => {
    const base = {
      status: "confirmed",
      conversationId: "conv-1",
      courierPhase: "delivered",
      enabled: true,
      reviewUrl: "https://example.com/review",
      alreadyRequested: false,
    };
    expect(decideReviewRequest(base)).toEqual({
      request: true,
      link: "https://example.com/review",
    });
    expect(
      decideReviewRequest({ ...base, courierPhase: "in_transit" })
    ).toMatchObject({ request: false, reason: "not_delivered" });
    expect(decideReviewRequest({ ...base, enabled: false })).toMatchObject({
      request: false,
      reason: "disabled",
    });
  });
  it("rating queue refuses a conversation owned by another tenant", async () => {
    const store: RatingStore = {
      findConversation: async () => ({
        id: "conv-1",
        businessId: "biz-b",
      }),
      findFollowUps: async () => [],
      createFollowUp: async () => {
        throw new Error("must not create for a foreign conversation");
      },
      findOrdersByConversation: async () => [],
      updateOrder: async () => {},
    };
    const res = await queueOrderRatingRequest(
      {
        id: "order-1",
        businessId: "biz-a",
        status: "confirmed",
        conversationId: "conv-1",
      },
      "pending",
      { businessName: "Shop A", lang: "en" },
      store
    );
    expect(res).toEqual({ queued: false, reason: "cross_tenant" });
  });
});
