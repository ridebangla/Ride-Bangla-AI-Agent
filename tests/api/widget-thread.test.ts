import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

vi.mock("@/lib/tenant", () => ({
  getBusinessBySiteKey: vi.fn(async (key: string) =>
    key === "good-key" ? { id: "biz-1" } : null
  ),
  enterBusinessContext: vi.fn(),
  runWithBusiness: vi.fn((_id: string, fn: () => unknown) => fn()),
}));

const T0 = new Date("2026-10-21T06:00:00.000Z");
const T1 = new Date("2026-10-21T06:01:00.000Z");
const T2 = new Date("2026-10-21T06:02:00.000Z");

describe("GET /api/chat/thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.message.findMany.mockResolvedValue([]);
  });

  it("rejects a missing site key", async () => {
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { conversationId: "c-1", visitorId: "v-1" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown site key", async () => {
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { siteKey: "bad-key", conversationId: "c-1", visitorId: "v-1" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("requires conversationId and visitorId", async () => {
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { siteKey: "good-key" },
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns the thread to its owner, oldest first, roles mapped", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "c-1",
      channel: "widget",
      customerContact: "v-1",
      aiEnabled: false,
    });
    // findMany is queried newest-first (desc + take); the route reverses.
    mockPrisma.message.findMany.mockResolvedValue([
      { id: "m-3", role: "assistant", content: "A human is here now.", createdAt: T2 },
      { id: "m-2", role: "assistant", content: "AI answer.", createdAt: T1 },
      { id: "m-1", role: "customer", content: "I need a human.", createdAt: T0 },
    ]);
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { siteKey: "good-key", conversationId: "c-1", visitorId: "v-1" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.aiEnabled).toBe(false);
    expect(data.messages.map((m: { id: string }) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(data.messages[0].role).toBe("customer");
    expect(data.messages[2].role).toBe("assistant");
    expect(data.messages[2].content).toBe("A human is here now.");
  });

  it("returns an empty thread when the visitor does not own it (no leak)", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "c-1",
      channel: "widget",
      customerContact: "someone-else",
      aiEnabled: true,
    });
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { siteKey: "good-key", conversationId: "c-1", visitorId: "v-1" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.messages).toEqual([]);
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty thread for a non-widget channel", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "c-9",
      channel: "whatsapp",
      customerContact: "v-1",
      aiEnabled: true,
    });
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { siteKey: "good-key", conversationId: "c-9", visitorId: "v-1" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.messages).toEqual([]);
  });

  it("never serves a thread under the public 'anonymous' identity", async () => {
    // Legacy conversations created without a visitorId are owned by the
    // literal string "anonymous" — public knowledge, not a credential.
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "c-anon",
      channel: "widget",
      customerContact: "anonymous",
      aiEnabled: true,
    });
    mockPrisma.message.findMany.mockResolvedValue([
      { id: "m-1", role: "customer", content: "secret", createdAt: T0 },
    ]);
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { siteKey: "good-key", conversationId: "c-anon", visitorId: "anonymous" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.messages).toEqual([]);
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty thread for an unknown conversation id", async () => {
    const { GET } = await import("@/app/api/chat/thread/route");
    const res = await GET(
      createRequest("/api/chat/thread", {
        searchParams: { siteKey: "good-key", conversationId: "nope", visitorId: "v-1" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.messages).toEqual([]);
  });
});
