import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

/**
 * Agent-quality Defect 8 (2026-10-22): a widget turn must NEVER surface
 * the raw English server error "Failed to process message". Production
 * logs showed the data layer throwing `8 RESOURCE_EXHAUSTED: Quota
 * exceeded` (Firestore) mid-turn — URL messages and plain messages
 * alike — and the exception escaping chat() into the route's catch.
 * The route now converts ANY escaped failure into a completed turn:
 * HTTP 200 with a graceful reply in the visitor's language.
 */

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

vi.mock("@/lib/tenant", () => ({
  getBusinessBySiteKey: vi.fn(async (key: string) =>
    key === "good-key" ? { id: "biz-1", name: "Biz" } : null
  ),
  enterBusinessContext: vi.fn(),
  runWithBusiness: vi.fn((_id: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/subscription", () => ({
  getSubscription: vi.fn(async () => ({ isActive: true })),
}));

vi.mock("@/lib/billing-usage", () => ({
  checkMessageLimitExceeded: vi.fn(async () => false),
}));

vi.mock("@/lib/ai/engine", () => ({
  chat: vi.fn(async () => {
    // Simulates the production failure class: a downstream data-layer
    // error escaping the engine mid-turn.
    throw new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.");
  }),
}));

vi.mock("@/lib/ai/activity", () => ({
  parseActivityToken: vi.fn(() => null),
  bindActivityToken: vi.fn(async () => {}),
}));

describe("POST /api/chat/widget turn-failure guarantee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: "conv-new" });
  });

  async function post(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/chat/widget/route");
    const res = await POST(
      createRequest("/api/chat/widget", { method: "POST", body })
    );
    return res;
  }

  it("turns an escaped engine failure into a completed Bengali turn for a Bengali URL message", async () => {
    const res = await post({
      siteKey: "good-key",
      message: "https://tools.ridebsngla.bd এটা আপনাদের কোন সেবা",
      visitorId: "v-d8-bn",
    });
    expect(res.status).toBe(200);
    const data = await parseJsonResponse(res);
    expect(data.error).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("Failed to process message");
    expect(data.conversationId).toBe("conv-new");
    expect(data.visitorId).toBe("v-d8-bn");
    expect(data.silent).toBe(false);
    expect(data.products).toEqual([]);
    // Bengali visitor -> Bengali graceful reply (functional error state).
    expect(data.response).toMatch(/[\u0980-\u09FF]/);
    expect(data.response).toContain("দুঃখিত");
  });

  it("answers in English when the visitor wrote in English", async () => {
    const res = await post({
      siteKey: "good-key",
      message: "https://example.com what is this site?",
      visitorId: "v-d8-en",
    });
    expect(res.status).toBe(200);
    const data = await parseJsonResponse(res);
    expect(data.response).toContain("try again in a moment");
    expect(data.response).not.toMatch(/[\u0980-\u09FF]/);
  });

  it("settles a streaming turn with a graceful done event, never a raw error event", async () => {
    const res = await post({
      siteKey: "good-key",
      message: "https://ai.ridebangla.bd তাহলে এটা কি",
      visitorId: "v-d8-stream",
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).not.toContain("Failed to process message");
    expect(body).not.toContain("event: error");
    expect(body).toContain("event: done");
    expect(body).toContain("দুঃখিত");
    expect(body).toContain('"conversationId":"conv-new"');
  });
});
