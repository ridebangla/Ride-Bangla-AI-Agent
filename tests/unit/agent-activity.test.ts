import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

// ---- Engine collaborators, scripted per test ----
vi.mock("@/lib/ai/providers", () => ({
  completeWithFallback: vi.fn(),
  hasAnyProviderKey: vi.fn(() => true),
  normalizePreferredProvider: vi.fn((p: unknown) => p ?? "auto"),
  resolveSiteKeys: vi.fn(async () => ({ openai: "sk-test" })),
}));

vi.mock("@/lib/ai/tools", () => ({
  agentTools: [],
  executeToolCall: vi.fn(async () => JSON.stringify({ ok: true })),
}));

vi.mock("@/lib/catalog", () => ({
  getCatalogBrief: vi.fn(async () => ""),
  matchProductsInMessage: vi.fn(async () => []),
  matchCategoryProducts: vi.fn(async () => []),
  findAlternatives: vi.fn(async () => ({ products: [], reason: "none" })),
  looksLikeProductInquiry: vi.fn(() => false),
  retainLineFor: vi.fn(() => ""),
}));

describe("activityKindForTool", () => {
  it("maps every agent tool to its true activity", async () => {
    const { activityKindForTool } = await import("@/lib/ai/activity");
    expect(activityKindForTool("search_catalog")).toBe("searching_catalog");
    expect(activityKindForTool("recommend_alternative")).toBe(
      "recommending_alternatives"
    );
    expect(activityKindForTool("show_products")).toBe("finding_products");
    expect(activityKindForTool("create_ticket")).toBe("creating_ticket");
    expect(activityKindForTool("assign_to_person")).toBe("assigning_ticket");
    expect(activityKindForTool("send_internal_email")).toBe("sending_email");
    expect(activityKindForTool("get_customer_history")).toBe("checking_history");
    expect(activityKindForTool("schedule_followup")).toBe("scheduling_followup");
    expect(activityKindForTool("take_order")).toBe("taking_order");
    expect(activityKindForTool("trigger_webhook")).toBe("triggering_webhook");
  });

  it("returns null for unknown tools (caption stays generic)", async () => {
    const { activityKindForTool } = await import("@/lib/ai/activity");
    expect(activityKindForTool("browse_website")).toBeNull();
    expect(activityKindForTool("anything_else")).toBeNull();
  });
});

describe("parseActivityToken", () => {
  it("accepts well-formed tokens and rejects everything else", async () => {
    const { parseActivityToken } = await import("@/lib/ai/activity");
    expect(parseActivityToken("at-abc123XYZ_9")).toBe("at-abc123XYZ_9");
    expect(parseActivityToken("short")).toBe("");
    expect(parseActivityToken("has spaces init")).toBe("");
    expect(parseActivityToken(42)).toBe("");
    expect(parseActivityToken(null)).toBe("");
    expect(parseActivityToken(undefined)).toBe("");
  });
});

describe("reportActivity / clearActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.conversation.update.mockResolvedValue({});
    mockPrisma.conversation.findUnique.mockResolvedValue({ liveActivity: null });
  });

  it("reportActivity persists kind + channel + timestamp", async () => {
    const { reportActivity } = await import("@/lib/ai/activity");
    await reportActivity("conv-1", "sending_reply", { channel: "whatsapp" });
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: {
        liveActivity: {
          kind: "sending_reply",
          channel: "whatsapp",
          at: expect.any(String),
        },
      },
    });
  });

  it("reportActivity never throws when the write fails", async () => {
    mockPrisma.conversation.update.mockRejectedValue(new Error("db down"));
    const { reportActivity } = await import("@/lib/ai/activity");
    await expect(
      reportActivity("conv-1", "composing")
    ).resolves.toBeUndefined();
  });

  it("clearActivity writes null only when an activity is recorded", async () => {
    const { clearActivity } = await import("@/lib/ai/activity");

    mockPrisma.conversation.findUnique.mockResolvedValue({
      liveActivity: { kind: "composing", channel: null, at: new Date().toISOString() },
    });
    await clearActivity("conv-1");
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: { liveActivity: null },
    });

    vi.clearAllMocks();
    mockPrisma.conversation.findUnique.mockResolvedValue({ liveActivity: null });
    await clearActivity("conv-1");
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });
});

describe("activity labels + freshness", () => {
  it("labels the current action, per channel for sends", async () => {
    const { activityLabel } = await import("@/lib/ai/activity-labels");
    expect(activityLabel({ kind: "searching_catalog" })).toContain(
      "searching the catalog"
    );
    expect(
      activityLabel({ kind: "sending_reply", channel: "whatsapp" })
    ).toContain("WhatsApp");
    expect(
      activityLabel({ kind: "sending_reply", channel: "facebook" })
    ).toContain("Facebook");
    expect(activityLabel({ kind: "sending_reply", channel: null })).toContain(
      "sending the reply"
    );
    expect(activityLabel({ kind: "composing" }, "bn")).toContain("উত্তর লিখছে");
  });

  it("isFreshActivity hides stale, malformed and future entries", async () => {
    const { isFreshActivity } = await import("@/lib/ai/activity-labels");
    const now = Date.now();
    expect(
      isFreshActivity({ kind: "composing", at: new Date(now - 1000).toISOString() }, now)
    ).toBe(true);
    expect(
      isFreshActivity({ kind: "composing", at: new Date(now - 10 * 60_000).toISOString() }, now)
    ).toBe(false);
    expect(isFreshActivity(null, now)).toBe(false);
    expect(isFreshActivity({ kind: "composing" }, now)).toBe(false);
    expect(isFreshActivity("composing", now)).toBe(false);
  });
});

describe("engine live-activity sequence", () => {
  // A tiny in-memory conversation doc the mocked facade reads/writes,
  // so clearActivity sees what reportActivity wrote — like production.
  let stored: Record<string, unknown>;
  let activityWrites: Array<string | null>;

  beforeEach(async () => {
    vi.clearAllMocks();
    stored = {
      id: "conv-1",
      channel: "widget",
      customerName: "Website Visitor",
      customerContact: "visitor-1",
      status: "active",
      aiEnabled: true,
      messages: [],
      liveActivity: undefined,
    };
    activityWrites = [];

    mockPrisma.settings.findFirst.mockResolvedValue({
      id: "settings-1",
      businessName: "Test Biz",
      businessDesc: "",
      welcomeMessage: "",
      tone: "friendly",
      language: "auto",
      aiProvider: "openai",
      aiModel: "gpt-test",
      aiApiKey: "sk-test",
      aiEnabled: true,
      maxTokens: 500,
      temperature: 0.7,
      agentBehavior: "",
    });
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-1" });
    mockPrisma.conversation.findUnique.mockImplementation(async () => stored);
    mockPrisma.conversation.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, "liveActivity")) {
          const la = data.liveActivity as { kind?: string } | null;
          activityWrites.push(la ? la.kind ?? "?" : null);
        }
        Object.assign(stored, data);
        return stored;
      }
    );

    const providers = await import("@/lib/ai/providers");
    (providers.hasAnyProviderKey as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (providers.resolveSiteKeys as ReturnType<typeof vi.fn>).mockResolvedValue({
      openai: "sk-test",
    });
  });

  it("tool-call turn: knowledge -> composing -> catalog search -> composing -> attach search -> cleared", async () => {
    const providers = await import("@/lib/ai/providers");
    (providers.completeWithFallback as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "search_catalog", arguments: "{\"query\":\"bag\"}" },
          },
        ],
      })
      .mockResolvedValueOnce({ text: "Found a bag for you.", toolCalls: undefined });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Do you have a laptop bag?");

    expect(result.response).toBe("Found a bag for you.");
    expect(activityWrites).toEqual([
      "consulting_knowledge",
      "composing",
      "searching_catalog",
      "composing",
      "searching_catalog",
      null,
    ]);
    expect(stored.liveActivity).toBeNull();
  });

  it("plain reply turn: knowledge -> composing -> attach search -> cleared", async () => {
    const providers = await import("@/lib/ai/providers");
    (providers.completeWithFallback as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "Hello! How can I help?",
      toolCalls: undefined,
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Hi there");

    expect(result.response).toBe("Hello! How can I help?");
    expect(activityWrites).toEqual([
      "consulting_knowledge",
      "composing",
      "searching_catalog",
      null,
    ]);
  });

  it("human takeover: pure silence, zero activity writes", async () => {
    stored.aiEnabled = false;
    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Hi");
    expect(result.silent).toBe(true);
    expect(activityWrites).toEqual([]);
  });

  it("brain offline: deterministic catalog attach is reported, then cleared", async () => {
    const providers = await import("@/lib/ai/providers");
    (providers.hasAnyProviderKey as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Do you sell bags?");

    expect(result.aiConfigured).toBe(false);
    expect(activityWrites).toEqual(["searching_catalog", null]);
  });
});
