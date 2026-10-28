import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { getSubscription } from "@/lib/subscription";
import { __resetWidgetSiteKeyCache } from "@/lib/widget-sitekey-cache";
import { createRequest, parseJsonResponse } from "../helpers/request";

const BN_GRACEFUL =
  "দুঃখিত, এই মুহূর্তে আপনার বার্তাটির উত্তর দিতে একটু সমস্যা হচ্ছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন, অথবা জরুরি হলে আমাদের টিমের সঙ্গে সরাসরি যোগাযোগ করুন।";
const EN_GRACEFUL =
  "I'm sorry, I'm having a little trouble answering your message right now. Please try again in a moment, or contact our team directly if it's urgent.";

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
  // AI-perfection FIX-A: the route's failure catch consults the
  // greeting helpers; every message in this suite is substantive
  // (not a pure greeting), so the detector stub answers false and
  // the graceful-text expectations below are unchanged. The FIX-A
  // greeting branch itself is covered with the REAL helpers in
  // tests/unit/widget-data-layer-degradation.test.ts.
  isPureGreeting: vi.fn(() => false),
  buildGreetingReply: vi.fn(() => ""),
}));

vi.mock("@/lib/ai/activity", () => ({
  parseActivityToken: vi.fn(() => null),
  bindActivityToken: vi.fn(async () => {}),
}));

describe("POST /api/chat/widget turn-failure guarantee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-audit #2: the route caches siteKey -> business for 60s
    // (F5); each case here must start from a cold cache or a warm
    // entry would bypass the mocked lookup entirely.
    __resetWidgetSiteKeyCache();
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

  // Seam fix (agent-quality round, 2026-10-22): a turn dying AT the
  // Firestore data gates — getBusinessBySiteKey / getSubscription /
  // checkMessageLimitExceeded, all awaited BEFORE the message text was
  // bound to the failure path — used to fall back to the English graceful
  // text even for a Bengali message, because the catch saw an empty
  // failure text. The failure text is now derived from the incoming
  // message at request parse, before any data gate runs.
  it("answers in Bengali when the FIRST data gate throws for a Bengali message", async () => {
    (getBusinessBySiteKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );
    const res = await post({
      siteKey: "good-key",
      message: "হাই, আপনাদের সেবা সম্পর্কে জানতে চাই",
      visitorId: "v-seam-gate-bn",
    });
    expect(res.status).toBe(200);
    const data = await parseJsonResponse(res);
    expect(data.error).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("Failed to process message");
    expect(data.response).toBe(BN_GRACEFUL);
    expect(data.products).toEqual([]);
    expect(data.silent).toBe(false);
  });

  it("answers in English when a data gate throws for an English message", async () => {
    (getBusinessBySiteKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );
    const res = await post({
      siteKey: "good-key",
      message: "Hi, I want to know about your services",
      visitorId: "v-seam-gate-en",
    });
    expect(res.status).toBe(200);
    const data = await parseJsonResponse(res);
    expect(data.response).toBe(EN_GRACEFUL);
  });

  it("answers in Bengali when the SUBSCRIPTION gate throws for a Bengali message", async () => {
    (getSubscription as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );
    const res = await post({
      siteKey: "good-key",
      message: "আমার অর্ডারটা কোথায় আছে জানতে চাই",
      visitorId: "v-seam-sub-bn",
    });
    expect(res.status).toBe(200);
    const data = await parseJsonResponse(res);
    expect(data.response).toBe(BN_GRACEFUL);
  });

  it("answers a stream:true request in Bengali when a data gate throws before the stream opens", async () => {
    (getBusinessBySiteKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );
    const res = await post({
      siteKey: "good-key",
      message: "হাই, সাহায্য চাই",
      visitorId: "v-seam-gate-stream",
      stream: true,
    });
    expect(res.status).toBe(200);
    // The stream never opens when a gate dies — the turn settles through
    // the JSON failure path, which must carry the same in-language text.
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await parseJsonResponse(res);
    expect(data.response).toBe(BN_GRACEFUL);
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
