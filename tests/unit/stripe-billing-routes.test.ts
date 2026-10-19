import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as checkoutPOST } from "@/app/api/billing/checkout/route";
import { POST as portalPOST } from "@/app/api/billing/portal/route";

// The production behavior TODAY: no Stripe keys exist, so both billing
// routes must answer with an honest 503 (billing_not_configured) instead
// of crashing or faking a checkout. requireAuth is globally mocked as an
// admin of "test-business" (see tests/setup.ts).

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_STARTER;
  delete process.env.STRIPE_PRICE_GROWTH;
  delete process.env.STRIPE_PRICE_PRO;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

describe("POST /api/billing/checkout (no Stripe keys)", () => {
  it("answers 503 billing_not_configured instead of crashing", async () => {
    const res = await checkoutPOST(post("/api/billing/checkout", { plan: "growth" }));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe("billing_not_configured");
    expect(data.message).toMatch(/being connected/i);
  });

  it("rejects an invalid plan with 400 before touching Stripe", async () => {
    const res = await checkoutPOST(post("/api/billing/checkout", { plan: "enterprise" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_plan");
  });

  it("rejects a missing plan with 400", async () => {
    const res = await checkoutPOST(post("/api/billing/checkout", {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_plan");
  });
});

describe("POST /api/billing/portal (no Stripe keys)", () => {
  it("answers 503 billing_not_configured instead of crashing", async () => {
    const res = await portalPOST(post("/api/billing/portal"));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe("billing_not_configured");
    expect(data.message).toMatch(/being connected/i);
  });
});
