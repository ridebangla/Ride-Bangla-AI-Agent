import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { __resetWidgetSiteKeyCache } from "@/lib/widget-sitekey-cache";
import { createRequest, parseJsonResponse } from "../helpers/request";

/**
 * Widget in-flight coalescing (head call 2026-11-03): a flushed burst
 * POST carries `messages: string[]` plus the backwards-compatible
 * `message` (joined text). The route must treat `messages` as
 * canonical, run groupBursts() over the array, and call chat() ONCE
 * with the combined text — while single-message requests behave
 * exactly as before. No timed burst window exists in this step.
 */

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

const mockChat = vi.fn(async () => ({
  response: "ok",
  products: [],
  silent: false,
}));

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
  chat: mockChat,
  isPureGreeting: vi.fn(() => false),
  buildGreetingReply: vi.fn(() => ""),
}));

const mockBindActivityToken = vi.fn(async () => {});
vi.mock("@/lib/ai/activity", () => ({
  parseActivityToken: vi.fn((t: unknown) =>
    typeof t === "string" ? t : null
  ),
  bindActivityToken: mockBindActivityToken,
}));

describe("POST /api/chat/widget burst messages[]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWidgetSiteKeyCache();
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: "conv-new" });
    // Real customer resolution: no existing row -> auto-create.
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.customer.create.mockResolvedValue({ id: "cust-1" });
  });

  async function post(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/chat/widget/route");
    return POST(createRequest("/api/chat/widget", { method: "POST", body }));
  }

  it("calls chat() exactly once with the newline-joined burst text", async () => {
    const res = await post({
      siteKey: "good-key",
      messages: ["one", "two", "three"],
      message: "one\ntwo\nthree",
      visitorId: "v-burst-1",
      activityToken: "at-1",
    });
    expect(res.status).toBe(200);
    const data = await parseJsonResponse(res);
    expect(data.conversationId).toBe("conv-new");
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toBe("one\ntwo\nthree");
  });

  it("treats messages[] as canonical over a conflicting message field", async () => {
    const res = await post({
      siteKey: "good-key",
      messages: ["real one", "real two"],
      message: "something else entirely",
      visitorId: "v-burst-2",
    });
    expect(res.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toBe("real one\nreal two");
  });

  it("leaves a single-message request unchanged", async () => {
    const res = await post({
      siteKey: "good-key",
      message: "hello single",
      visitorId: "v-single-1",
    });
    expect(res.status).toBe(200);
    const data = await parseJsonResponse(res);
    expect(data.response).toBe("ok");
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toBe("hello single");
  });

  it("rejects empty, non-string, and oversized burst input without calling chat()", async () => {
    const bad: Array<Record<string, unknown>> = [
      { siteKey: "good-key", messages: ["ok", ""], visitorId: "v-bad-1" },
      { siteKey: "good-key", messages: ["ok", "   "], visitorId: "v-bad-2" },
      { siteKey: "good-key", messages: ["ok", 42], visitorId: "v-bad-3" },
      { siteKey: "good-key", messages: "not-an-array", visitorId: "v-bad-4" },
      {
        siteKey: "good-key",
        messages: ["x".repeat(5001)],
        visitorId: "v-bad-5",
      },
      {
        siteKey: "good-key",
        messages: ["a".repeat(3000), "b".repeat(3000)],
        visitorId: "v-bad-6",
      },
      { siteKey: "good-key", messages: [], visitorId: "v-bad-7" },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("keeps tenant, customer-resolution, and activity binding intact for a burst", async () => {
    // Unknown tenant: 401 before chat(), exactly as for single sends.
    const denied = await post({
      siteKey: "nope-key",
      messages: ["one", "two"],
      visitorId: "v-burst-3",
    });
    expect(denied.status).toBe(401);
    expect(mockChat).not.toHaveBeenCalled();

    // Existing conversation: customerId backfill + exactly ONE
    // activity-token bind for the whole burst (not one per text).
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-old",
      customerContact: "v-burst-4",
      customerId: null,
      activityToken: null,
    });
    const res = await post({
      siteKey: "good-key",
      messages: ["one", "two", "three"],
      message: "one\ntwo\nthree",
      visitorId: "v-burst-4",
      conversationId: "conv-old",
      activityToken: "at-9",
    });
    expect(res.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][0]).toBe("conv-old");
    expect(mockBindActivityToken).toHaveBeenCalledTimes(1);
    expect(mockBindActivityToken).toHaveBeenCalledWith(
      "conv-old",
      "at-9",
      null
    );
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conv-old" },
        data: expect.objectContaining({ customerId: "cust-1" }),
      })
    );
  });

  it("counts a burst as ONE turn for rate limiting (20 bursts pass, 21st is 429)", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await post({
        siteKey: "good-key",
        messages: ["a", "b", "c"],
        message: "a\nb\nc",
        visitorId: "v-burst-rl",
      });
      expect(res.status).toBe(200);
    }
    const limited = await post({
      siteKey: "good-key",
      messages: ["a", "b", "c"],
      message: "a\nb\nc",
      visitorId: "v-burst-rl",
    });
    expect(limited.status).toBe(429);
    // 20 turns, not 20 x 3 texts.
    expect(mockChat).toHaveBeenCalledTimes(20);
  });

  it("streams a burst through chat() once with the combined text", async () => {
    const res = await post({
      siteKey: "good-key",
      messages: ["stream one", "stream two"],
      message: "stream one\nstream two",
      visitorId: "v-burst-stream",
      stream: true,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const bodyText = await res.text();
    expect(bodyText).toContain("conv-new");
    expect(bodyText).toContain('"response":"ok"');
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][1]).toBe("stream one\nstream two");
  });
});
