import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { getSubscription } from "@/lib/subscription";
import { checkMessageLimitExceeded } from "@/lib/billing-usage";
import { chat } from "@/lib/ai/engine";
import {
  __resetWidgetSiteKeyCache,
  getStaleBusinessBySiteKey,
} from "@/app/api/chat/widget/route";
import { createRequest, parseJsonResponse } from "../helpers/request";

/**
 * AI-perfection round (2026-10-23), FIX-A + FIX-D — widget route
 * behaviour while the data layer (Firestore) is down:
 *
 * FIX-A: when a turn dies in the route's outer catch, a PURE greeting
 * is answered from the siteKey cache — including a STALE entry — with
 * the engine's deterministic greeting builder (the real isPureGreeting
 * / buildGreetingReply are used here via importOriginal; only chat()
 * is stubbed). Non-greetings, and greetings with no cache entry, keep
 * the existing graceful failure text, byte-identical.
 *
 * FIX-D: a billing gate that THROWS (getSubscription /
 * checkMessageLimitExceeded failing, incl. the gate deadline) no
 * longer kills the turn — the turn proceeds with the billing state
 * unknown. Definitive billing results are unchanged: inactive ->
 * 402 subscription_paused, limit exceeded -> 402
 * message_limit_reached.
 */

const BN_GRACEFUL =
  "দুঃখিত, এই মুহূর্তে আপনার বার্তাটির উত্তর দিতে একটু সমস্যা হচ্ছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন, অথবা জরুরি হলে আমাদের টিমের সঙ্গে সরাসরি যোগাযোগ করুন।";
const EN_GRACEFUL =
  "I'm sorry, I'm having a little trouble answering your message right now. Please try again in a moment, or contact our team directly if it's urgent.";
const QUOTA = new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.");

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

vi.mock("@/lib/ai/engine", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/engine")>();
  return {
    ...actual,
    // Simulates a turn dying downstream of the gates.
    chat: vi.fn(async () => {
      throw new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.");
    }),
  };
});

vi.mock("@/lib/ai/activity", () => ({
  parseActivityToken: vi.fn(() => null),
  bindActivityToken: vi.fn(async () => {}),
}));

const mockGetBusiness = getBusinessBySiteKey as unknown as ReturnType<
  typeof vi.fn
>;
const mockGetSubscription = getSubscription as unknown as ReturnType<
  typeof vi.fn
>;
const mockCheckLimit = checkMessageLimitExceeded as unknown as ReturnType<
  typeof vi.fn
>;
const mockChat = chat as unknown as ReturnType<typeof vi.fn>;

describe("POST /api/chat/widget data-layer degradation (FIX-A / FIX-D)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWidgetSiteKeyCache();
    delete process.env.WIDGET_SITEKEY_CACHE_TTL_MS;
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: "conv-new" });
  });

  async function post(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/chat/widget/route");
    const res = await POST(
      createRequest("/api/chat/widget", { method: "POST", body })
    );
    return { res, data: await parseJsonResponse(res) };
  }

  /** One healthy-gated turn whose engine dies: seeds the siteKey
   *  cache with Biz and settles through the graceful catch. */
  async function seedCache(visitorId: string) {
    const seeded = await post({
      siteKey: "good-key",
      message: "What services do you offer?",
      visitorId,
    });
    expect(seeded.res.status).toBe(200);
    expect(seeded.data.response).toBe(EN_GRACEFUL);
    expect(getStaleBusinessBySiteKey("good-key")?.name).toBe("Biz");
  }

  it("FIX-A: pure greeting + STALE cache entry + business gate throws -> deterministic greeting payload, no conversationId", async () => {
    await seedCache("v-a1-seed");
    // Make the cached entry stale (TTL 0) so the live gate path must
    // refetch — and the refetch throws. The stale-read accessor must
    // still hand the failure path the cached business.
    process.env.WIDGET_SITEKEY_CACHE_TTL_MS = "0";
    mockGetBusiness.mockRejectedValueOnce(QUOTA);

    const { res, data } = await post({
      siteKey: "good-key",
      message: "Hello",
      visitorId: "v-a1",
    });

    expect(res.status).toBe(200);
    expect(data.response).toBe(
      "Hello, Sir/Madam! Welcome to Biz. How can I help you today?"
    );
    expect(data.products).toEqual([]);
    expect(data.silent).toBe(false);
    expect(data.conversationId).toBeUndefined();
  });

  it("FIX-A: Bengali pure greeting + stale cache + gate throws -> Bengali greeting", async () => {
    await seedCache("v-a2-seed");
    process.env.WIDGET_SITEKEY_CACHE_TTL_MS = "0";
    mockGetBusiness.mockRejectedValueOnce(QUOTA);

    const { res, data } = await post({
      siteKey: "good-key",
      message: "হাই",
      visitorId: "v-a2",
    });

    expect(res.status).toBe(200);
    expect(data.response).toBe(
      "হ্যালো, স্যার/ম্যাডাম! Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(data.conversationId).toBeUndefined();
  });

  it("FIX-A: non-greeting + stale cache + gate throws -> graceful text, unchanged", async () => {
    await seedCache("v-a3-seed");
    process.env.WIDGET_SITEKEY_CACHE_TTL_MS = "0";
    mockGetBusiness.mockRejectedValueOnce(QUOTA);

    const { res, data } = await post({
      siteKey: "good-key",
      message: "What are your delivery hours?",
      visitorId: "v-a3",
    });

    expect(res.status).toBe(200);
    expect(data.response).toBe(EN_GRACEFUL);
    expect(data.products).toEqual([]);
    expect(data.silent).toBe(false);
  });

  it("FIX-A: pure greeting + NO cache entry + gate throws -> graceful text, unchanged", async () => {
    expect(getStaleBusinessBySiteKey("good-key")).toBeNull();
    mockGetBusiness.mockRejectedValueOnce(QUOTA);

    const { res, data } = await post({
      siteKey: "good-key",
      message: "হাই",
      visitorId: "v-a4",
    });

    expect(res.status).toBe(200);
    expect(data.response).toBe(BN_GRACEFUL);
  });

  it("FIX-D: getSubscription throws -> turn proceeds (no 402, engine reached)", async () => {
    mockGetSubscription.mockRejectedValueOnce(QUOTA);
    mockChat.mockResolvedValueOnce({
      response: "real answer",
      products: [],
      silent: false,
    });

    const { res, data } = await post({
      siteKey: "good-key",
      message: "What services do you offer?",
      visitorId: "v-d1",
    });

    expect(res.status).toBe(200);
    expect(data.response).toBe("real answer");
    expect(data.conversationId).toBe("conv-new");
    expect(mockChat).toHaveBeenCalled();
  });

  it("FIX-D: checkMessageLimitExceeded throws -> turn proceeds (no 402, engine reached)", async () => {
    mockCheckLimit.mockRejectedValueOnce(QUOTA);
    mockChat.mockResolvedValueOnce({
      response: "real answer",
      products: [],
      silent: false,
    });

    const { res, data } = await post({
      siteKey: "good-key",
      message: "What services do you offer?",
      visitorId: "v-d2",
    });

    expect(res.status).toBe(200);
    expect(data.response).toBe("real answer");
    expect(mockChat).toHaveBeenCalled();
  });

  it("FIX-D regression guard: definitive inactive subscription still returns 402 subscription_paused", async () => {
    mockGetSubscription.mockResolvedValueOnce({ isActive: false });

    const { res, data } = await post({
      siteKey: "good-key",
      message: "What services do you offer?",
      visitorId: "v-d3",
    });

    expect(res.status).toBe(402);
    expect(data.error).toBe("subscription_paused");
    expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("FIX-D regression guard: definitive limit-exceeded still returns 402 message_limit_reached", async () => {
    mockCheckLimit.mockResolvedValueOnce(true);

    const { res, data } = await post({
      siteKey: "good-key",
      message: "What services do you offer?",
      visitorId: "v-d4",
    });

    expect(res.status).toBe(402);
    expect(data.error).toBe("message_limit_reached");
    expect(mockChat).not.toHaveBeenCalled();
  });
});
