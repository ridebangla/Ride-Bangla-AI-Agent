import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Stripe from "stripe";
import {
  constructWebhookEvent,
  getPlanForPriceId,
  getPriceIdForPlan,
  isBillingConfigured,
  isPaidPlanId,
  getStripe,
  __resetStripeClientForTests,
  PAID_PLANS,
  PLAN_META,
  WebhookNotConfiguredError,
  WebhookSignatureError,
  StripeNotConfiguredError,
} from "@/lib/stripe";

// Proves the webhook verification logic offline using Stripe's own test
// helpers: generateTestHeaderString produces a real HMAC signature for a
// payload + secret, and constructEvent is the exact call the webhook route
// makes. No network, no Stripe account needed.
describe("stripe webhook signature verification (offline)", () => {
  const SECRET = "whsec_test_1234567890";
  const payload = JSON.stringify({
    id: "evt_test_123",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_123", object: "checkout.session" } },
  });

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("accepts a payload signed with the configured secret", () => {
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
    });
    const event = constructWebhookEvent(payload, header);
    expect(event.id).toBe("evt_test_123");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a payload signed with the WRONG secret", () => {
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_wrong_secret",
    });
    expect(() => constructWebhookEvent(payload, header)).toThrow(
      WebhookSignatureError
    );
  });

  it("rejects a tampered payload", () => {
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
    });
    expect(() =>
      constructWebhookEvent(payload + "tampered", header)
    ).toThrow(WebhookSignatureError);
  });

  it("rejects a missing signature header", () => {
    expect(() => constructWebhookEvent(payload, null)).toThrow(
      WebhookSignatureError
    );
  });

  it("throws WebhookNotConfiguredError (route answers 503) when the secret is missing", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => constructWebhookEvent(payload, "t=1,v1=abc")).toThrow(
      WebhookNotConfiguredError
    );
  });
});

describe("billing configuration gating", () => {
  const OLD_KEY = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    __resetStripeClientForTests();
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = OLD_KEY;
    __resetStripeClientForTests();
  });

  it("isBillingConfigured() is false without STRIPE_SECRET_KEY", () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(isBillingConfigured()).toBe(false);
    expect(getStripe()).toBeNull();
  });

  it("isBillingConfigured() is true with STRIPE_SECRET_KEY", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    expect(isBillingConfigured()).toBe(true);
    expect(getStripe()).not.toBeNull();
  });

  it("getStripe() returns the same lazy client (no re-construction)", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    expect(getStripe()).toBe(getStripe());
  });

  it("StripeNotConfiguredError carries an honest message", () => {
    const err = new StripeNotConfiguredError();
    expect(err.message).toMatch(/not connected yet/i);
  });
});

describe("plan / price-id mapping", () => {
  const OLD = {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth: process.env.STRIPE_PRICE_GROWTH,
    pro: process.env.STRIPE_PRICE_PRO,
  };

  beforeEach(() => {
    process.env.STRIPE_PRICE_STARTER = "price_starter_1";
    process.env.STRIPE_PRICE_GROWTH = "price_growth_1";
    process.env.STRIPE_PRICE_PRO = "price_pro_1";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(OLD)) {
      const env = `STRIPE_PRICE_${k.toUpperCase()}`;
      if (v === undefined) delete process.env[env];
      else process.env[env] = v;
    }
  });

  it("exposes exactly the three paid plans with USD prices", () => {
    expect(PAID_PLANS).toEqual(["starter", "growth", "pro"]);
    expect(PLAN_META.starter.priceUsd).toBe(19);
    expect(PLAN_META.growth.priceUsd).toBe(49);
    expect(PLAN_META.pro.priceUsd).toBe(99);
  });

  it("isPaidPlanId validates plan ids", () => {
    expect(isPaidPlanId("starter")).toBe(true);
    expect(isPaidPlanId("growth")).toBe(true);
    expect(isPaidPlanId("pro")).toBe(true);
    expect(isPaidPlanId("trial")).toBe(false);
    expect(isPaidPlanId("")).toBe(false);
    expect(isPaidPlanId(null)).toBe(false);
    expect(isPaidPlanId(undefined)).toBe(false);
  });

  it("maps plan <-> price id both ways", () => {
    expect(getPriceIdForPlan("starter")).toBe("price_starter_1");
    expect(getPriceIdForPlan("growth")).toBe("price_growth_1");
    expect(getPriceIdForPlan("pro")).toBe("price_pro_1");
    expect(getPlanForPriceId("price_starter_1")).toBe("starter");
    expect(getPlanForPriceId("price_growth_1")).toBe("growth");
    expect(getPlanForPriceId("price_pro_1")).toBe("pro");
    expect(getPlanForPriceId("price_unknown")).toBeNull();
  });

  it("returns null for missing price env vars (honest 503 path)", () => {
    delete process.env.STRIPE_PRICE_STARTER;
    expect(getPriceIdForPlan("starter")).toBeNull();
    // reverse map must not match a missing entry
    expect(getPlanForPriceId("")).toBeNull();
  });
});
