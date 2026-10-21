import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

/**
 * Agent-quality Defect 8 (2026-10-22): a wedged turn (downstream retry
 * backoff, e.g. Firestore quota errors) must settle with the graceful
 * in-language reply at the route's soft deadline instead of hanging
 * until the platform severs the connection — which is what made the
 * widget show "Connection problem" while the server was still working.
 * The deadline is read per request, so the test shortens it via env
 * right before posting.
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
  chat: vi.fn(
    () =>
      // A turn that never settles on its own (wedged downstream).
      new Promise(() => {})
  ),
}));

vi.mock("@/lib/ai/activity", () => ({
  parseActivityToken: vi.fn(() => null),
  bindActivityToken: vi.fn(async () => {}),
}));

describe("POST /api/chat/widget turn deadline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({ id: "conv-new" });
  });

  it("settles a wedged turn gracefully at the deadline instead of hanging", async () => {
    process.env.WIDGET_TURN_DEADLINE_MS = "1000";
    const { POST } = await import("@/app/api/chat/widget/route");
    const started = Date.now();
    const res = await POST(
      createRequest("/api/chat/widget", {
        method: "POST",
        body: {
          siteKey: "good-key",
          message: "https://ai.ridebangla.bd তাহলে এটা কি",
          visitorId: "v-d8-deadline",
        },
      })
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(5000);
    const data = await parseJsonResponse(res);
    expect(JSON.stringify(data)).not.toContain("Failed to process message");
    expect(data.response).toContain("দুঃখিত");
    expect(data.conversationId).toBe("conv-new");
  });
});
