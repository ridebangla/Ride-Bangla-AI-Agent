import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { getUnscopedPrisma } from "@/lib/prisma";
import { POST } from "@/app/api/webhooks/stripe/route";

// Exercises the REAL webhook route (signature verification + idempotent
// handlers) against the globally mocked Prisma client. Proves:
//  - bad signature → 400, missing secret → 503 (fail-closed)
//  - checkout.session.completed activates the right business and stores ids
//  - handlers are idempotent (Stripe retries don't double-write)
//  - unknown businesses are logged and skipped (no write)

const SECRET = "whsec_test_route_secret";

type MockDb = {
  business: Record<string, ReturnType<typeof vi.fn>>;
};

function db(): MockDb {
  return getUnscopedPrisma() as unknown as MockDb;
}

function signedRequest(payload: string, secret: string = SECRET): NextRequest {
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "stripe-signature": header,
      "Content-Type": "application/json",
    },
    body: payload,
  });
}

function stripeEvent(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    data: { object },
  });
}

const TRIALING_BIZ = {
  id: "biz_123",
  name: "Test Business",
  isActive: true,
  plan: "trial",
  subscriptionStatus: "trialing",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
};

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("signature gating", () => {
  it("answers 503 when STRIPE_WEBHOOK_SECRET is missing", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const payload = stripeEvent("checkout.session.completed", {});
    const res = await POST(
      signedRequest(payload, "whsec_anything")
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "webhook_not_configured" });
    expect(db().business.update).not.toHaveBeenCalled();
  });

  it("answers 400 on a bad signature", async () => {
    const payload = stripeEvent("checkout.session.completed", {});
    const res = await POST(signedRequest(payload, "whsec_wrong"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(db().business.update).not.toHaveBeenCalled();
  });
});

describe("checkout.session.completed", () => {
  function checkoutPayload() {
    return stripeEvent("checkout.session.completed", {
      id: "cs_test_1",
      object: "checkout.session",
      client_reference_id: "biz_123",
      customer: "cus_123",
      subscription: "sub_123",
      metadata: { businessId: "biz_123", plan: "growth" },
    });
  }

  it("activates a trialing business on the purchased plan and stores Stripe ids", async () => {
    db().business.findUnique.mockResolvedValue({ ...TRIALING_BIZ });
    const res = await POST(signedRequest(checkoutPayload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(db().business.update).toHaveBeenCalledTimes(1);
    expect(db().business.update).toHaveBeenCalledWith({
      where: { id: "biz_123" },
      data: {
        plan: "growth",
        subscriptionStatus: "active",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
      },
    });
  });

  it("is idempotent: already-active business is not written again", async () => {
    db().business.findUnique.mockResolvedValue({
      ...TRIALING_BIZ,
      plan: "growth",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
    });
    const res = await POST(signedRequest(checkoutPayload()));
    expect(res.status).toBe(200);
    expect(db().business.update).not.toHaveBeenCalled();
  });

  it("does not write for an unknown business (fail-closed)", async () => {
    db().business.findUnique.mockResolvedValue(null);
    const res = await POST(signedRequest(checkoutPayload()));
    expect(res.status).toBe(200);
    expect(db().business.update).not.toHaveBeenCalled();
  });
});

describe("invoice.payment_failed / invoice.payment_succeeded", () => {
  function invoicePayload() {
    return stripeEvent("invoice.payment_failed", {
      id: "in_test_1",
      object: "invoice",
      customer: "cus_123",
    });
  }

  it("downgrades active → past_due on payment failure", async () => {
    db().business.findFirst.mockResolvedValue({
      ...TRIALING_BIZ,
      plan: "growth",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_123",
    });
    const res = await POST(signedRequest(invoicePayload()));
    expect(res.status).toBe(200);
    expect(db().business.update).toHaveBeenCalledWith({
      where: { id: "biz_123" },
      data: { subscriptionStatus: "past_due" },
    });
  });

  it("lifts past_due → active on payment success", async () => {
    db().business.findFirst.mockResolvedValue({
      ...TRIALING_BIZ,
      plan: "growth",
      subscriptionStatus: "past_due",
      stripeCustomerId: "cus_123",
    });
    const payload = stripeEvent("invoice.payment_succeeded", {
      id: "in_test_2",
      object: "invoice",
      customer: "cus_123",
    });
    const res = await POST(signedRequest(payload));
    expect(res.status).toBe(200);
    expect(db().business.update).toHaveBeenCalledWith({
      where: { id: "biz_123" },
      data: { subscriptionStatus: "active" },
    });
  });

  it("does not touch a canceled business on payment failure", async () => {
    db().business.findFirst.mockResolvedValue({
      ...TRIALING_BIZ,
      subscriptionStatus: "canceled",
      stripeCustomerId: "cus_123",
    });
    const res = await POST(signedRequest(invoicePayload()));
    expect(res.status).toBe(200);
    expect(db().business.update).not.toHaveBeenCalled();
  });
});

describe("customer.subscription.deleted", () => {
  function deletedPayload() {
    return stripeEvent("customer.subscription.deleted", {
      id: "sub_123",
      object: "subscription",
      customer: "cus_123",
    });
  }

  it("suspends the business so the 402 hard-stop blocks AI everywhere", async () => {
    db().business.findFirst.mockResolvedValue({
      ...TRIALING_BIZ,
      plan: "growth",
      subscriptionStatus: "past_due",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
    });
    const res = await POST(signedRequest(deletedPayload()));
    expect(res.status).toBe(200);
    expect(db().business.update).toHaveBeenCalledWith({
      where: { id: "biz_123" },
      data: { subscriptionStatus: "suspended" },
    });
  });

  it("is idempotent when already suspended", async () => {
    db().business.findFirst.mockResolvedValue({
      ...TRIALING_BIZ,
      subscriptionStatus: "suspended",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
    });
    const res = await POST(signedRequest(deletedPayload()));
    expect(res.status).toBe(200);
    expect(db().business.update).not.toHaveBeenCalled();
  });
});
