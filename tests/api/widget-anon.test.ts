import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

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
  chat: vi.fn(async () => ({
    response: "ok",
    products: [],
    silent: false,
    aiConfigured: true,
  })),
  // AI-perfection FIX-A: the route imports the greeting helpers from
  // the engine; this suite never reaches the failure catch, so inert
  // stubs keep the mock complete.
  isPureGreeting: vi.fn(() => false),
  buildGreetingReply: vi.fn(() => ""),
}));

vi.mock("@/lib/ai/activity", () => ({
  parseActivityToken: vi.fn(() => null),
  bindActivityToken: vi.fn(async () => {}),
}));

describe("POST /api/chat/widget visitor identity", () => {
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
    return { res, data: await parseJsonResponse(res) };
  }

  function createdContact(): string {
    const arg = mockPrisma.conversation.create.mock.calls[0][0] as {
      data: { customerContact: string };
    };
    return arg.data.customerContact;
  }

  it("assigns an unguessable identity when visitorId is missing", async () => {
    const { res, data } = await post({ siteKey: "good-key", message: "hello" });
    expect(res.status).toBe(200);
    expect(createdContact()).toMatch(/^anon-/);
    expect(createdContact()).not.toBe("anonymous");
    expect(data.visitorId).toBe(createdContact());
    expect(data.conversationId).toBe("conv-new");
  });

  it("treats the literal 'anonymous' as no identity", async () => {
    const { res, data } = await post({
      siteKey: "good-key",
      message: "hello",
      visitorId: "anonymous",
    });
    expect(res.status).toBe(200);
    const calls = mockPrisma.conversation.create.mock.calls;
    const lastArg = calls[calls.length - 1][0] as {
      data: { customerContact: string };
    };
    expect(lastArg.data.customerContact).toMatch(/^anon-/);
    expect(data.visitorId).toBe(lastArg.data.customerContact);
  });

  it("preserves a real visitorId", async () => {
    const vid = `v-real-${Date.now()}`;
    const { res, data } = await post({
      siteKey: "good-key",
      message: "hello",
      visitorId: vid,
    });
    expect(res.status).toBe(200);
    expect(createdContact()).toBe(vid);
    expect(data.visitorId).toBe(vid);
  });
});
