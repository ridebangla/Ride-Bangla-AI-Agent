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

const FRESH = () => new Date().toISOString();
const STALE = () => new Date(Date.now() - 10 * 60_000).toISOString();

describe("GET /api/chat/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
  });

  it("rejects an unknown site key", async () => {
    const { GET } = await import("@/app/api/chat/activity/route");
    const res = await GET(
      createRequest("/api/chat/activity", {
        searchParams: { siteKey: "bad-key", token: "at-abcdef123" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("requires a conversationId or a token", async () => {
    const { GET } = await import("@/app/api/chat/activity/route");
    const res = await GET(
      createRequest("/api/chat/activity", {
        searchParams: { siteKey: "good-key" },
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns the live activity for a token-bound conversation", async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      channel: "widget",
      customerContact: "visitor-1",
      activityToken: "at-abcdef123",
      liveActivity: { kind: "searching_catalog", channel: null, at: FRESH() },
    });
    const { GET } = await import("@/app/api/chat/activity/route");
    const res = await GET(
      createRequest("/api/chat/activity", {
        searchParams: { siteKey: "good-key", token: "at-abcdef123" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.activity).toEqual({ kind: "searching_catalog", channel: null });
  });

  it("returns the activity via conversationId + matching visitor", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      channel: "widget",
      customerContact: "visitor-1",
      activityToken: "at-other9999",
      liveActivity: {
        kind: "sending_reply",
        channel: "whatsapp",
        at: FRESH(),
      },
    });
    const { GET } = await import("@/app/api/chat/activity/route");
    const res = await GET(
      createRequest("/api/chat/activity", {
        searchParams: {
          siteKey: "good-key",
          conversationId: "conv-1",
          visitorId: "visitor-1",
        },
      })
    );
    const data = await parseJsonResponse(res);
    expect(data.activity).toEqual({ kind: "sending_reply", channel: "whatsapp" });
  });

  it("never leaks activity to a different visitor", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      channel: "widget",
      customerContact: "visitor-1",
      activityToken: "at-abcdef123",
      liveActivity: { kind: "composing", channel: null, at: FRESH() },
    });
    const { GET } = await import("@/app/api/chat/activity/route");
    const res = await GET(
      createRequest("/api/chat/activity", {
        searchParams: {
          siteKey: "good-key",
          conversationId: "conv-1",
          visitorId: "someone-else",
        },
      })
    );
    const data = await parseJsonResponse(res);
    expect(data.activity).toBeNull();
  });

  it("hides stale activity (a turn that died mid-action)", async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      channel: "widget",
      customerContact: "visitor-1",
      activityToken: "at-abcdef123",
      liveActivity: { kind: "composing", channel: null, at: STALE() },
    });
    const { GET } = await import("@/app/api/chat/activity/route");
    const res = await GET(
      createRequest("/api/chat/activity", {
        searchParams: { siteKey: "good-key", token: "at-abcdef123" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(data.activity).toBeNull();
  });

  it("ignores non-widget conversations", async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      channel: "whatsapp",
      customerContact: "+8801000000000",
      activityToken: "at-abcdef123",
      liveActivity: { kind: "composing", channel: null, at: FRESH() },
    });
    const { GET } = await import("@/app/api/chat/activity/route");
    const res = await GET(
      createRequest("/api/chat/activity", {
        searchParams: { siteKey: "good-key", token: "at-abcdef123" },
      })
    );
    const data = await parseJsonResponse(res);
    expect(data.activity).toBeNull();
  });
});
