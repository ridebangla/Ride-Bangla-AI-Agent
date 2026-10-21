import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

// The route's import chain reaches the AI engine, which constructs an
// OpenAI client at module load — mock it (same pattern as phase5.test.ts).
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
    audio = { transcriptions: { create: vi.fn() } };
  },
}));

// Team 10 attack-test regression (2026-10-21): the WhatsApp Cloud webhook
// must be fail-closed. Before the fix, an unsigned POST was fully
// processed whenever META_APP_SECRET was unset (proven live: a forged
// message was ingested as a customer conversation, messages:1).
const SECRET = "team10-test-app-secret";
const payload = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "x", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ from: "000000000000", type: "text", text: { body: "forged" } }] } }] }],
});
function sign(body: string, secret: string) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}
async function post(headers: Record<string, string>) {
  const { POST } = await import("@/app/api/webhooks/whatsapp/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: payload,
  });
  return POST(req);
}
describe("whatsapp webhook fail-closed", () => {
  const saved = process.env.META_APP_SECRET;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { if (saved === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = saved; });
  it("rejects 503 when META_APP_SECRET is unset (no legacy fallback)", async () => {
    delete process.env.META_APP_SECRET;
    const res = await post({});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "webhook_not_configured" });
  });
  it("rejects 401 with no signature when secret is set", async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post({});
    expect(res.status).toBe(401);
  });
  it("rejects 401 with a wrong signature when secret is set", async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post({ "x-hub-signature-256": sign(payload, "wrong-secret") });
    expect(res.status).toBe(401);
  });
  it("accepts a correctly signed event (gate opens only for Meta)", async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post({ "x-hub-signature-256": sign(payload, SECRET) });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });
});
