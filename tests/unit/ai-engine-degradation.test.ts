import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveSiteKeys } from "@/lib/ai/providers";

/**
 * AI-perfection round (2026-10-23), FIX-B + FIX-C: engine prep-read
 * degradation. Production root cause: with the Firestore daily quota
 * exhausted, EVERY prep read in chat() (settings, conversation,
 * provider keys, then knowledge/catalog) rejected, the Promise.all
 * killed the turn, and even a bare greeting died — the deterministic
 * greeting fast path sits AFTER all of those reads.
 *
 * These cases prove each read now degrades individually:
 *  - conversation read fails -> ephemeral conversation, greeting
 *    still answered, user-message save skipped (nothing persisted
 *    as if it were a real record);
 *  - config read fails -> the platform default config shape is used;
 *  - key resolution fails -> the EXISTING honest not-connected
 *    fallback answers (aiConfigured: false), never a faked reply;
 *  - knowledge read fails -> the turn completes with the prompt's
 *    zero-knowledge honesty block governing.
 *
 * resolveSiteKeys is replaced with a controllable stub (the real
 * resolver is already fail-soft internally, so a rejection cannot be
 * produced through the prisma mocks); every other provider function
 * is the real one, and completions go through the mocked OpenAI
 * client exactly as in ai-engine.test.ts.
 */

const mockOpenAICreateFn = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockOpenAICreateFn,
        },
      };
    },
  };
});

vi.mock("@/lib/ai/providers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/providers")>();
  return {
    ...actual,
    resolveSiteKeys: vi.fn(async () => ({ openai: "sk-test" })),
  };
});

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;
const mockResolveSiteKeys = resolveSiteKeys as unknown as ReturnType<
  typeof vi.fn
>;

const SETTINGS = {
  id: "default",
  businessName: "Test Biz",
  businessDesc: "A test business",
  welcomeMessage: "Hello!",
  tone: "friendly",
  language: "auto",
  aiProvider: "openai",
  aiModel: "gpt-4",
  aiApiKey: "sk-test",
  maxTokens: 1000,
  temperature: 0.7,
};

describe("AI Engine prep-read degradation (FIX-B / FIX-C)", () => {
  beforeEach(() => {
    mockOpenAICreateFn.mockReset();
    mockResolveSiteKeys.mockReset();
    mockResolveSiteKeys.mockResolvedValue({ openai: "sk-test" });

    mockPrisma.settings.findFirst.mockReset();
    mockPrisma.settings.findFirst.mockResolvedValue({ ...SETTINGS });
    mockPrisma.settings.create.mockReset();
    mockPrisma.settings.create.mockResolvedValue({ id: "default" });

    mockPrisma.knowledgeEntry.findMany.mockReset();
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);

    mockPrisma.conversation.findUnique.mockReset();
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-1",
      channel: "whatsapp",
      customerName: "John",
      customerContact: "+1555",
      status: "active",
      messages: [{ role: "customer", content: "Hi", createdAt: new Date() }],
    });

    mockPrisma.message.create.mockReset();
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockReset();
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it("FIX-B: conversation read rejects + pure greeting -> greeting returned, user message NOT persisted", async () => {
    mockPrisma.conversation.findUnique.mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Hello");

    expect(result.response).toBe(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(result.silent).toBe(false);
    expect(result.products).toEqual([]);
    // The greeting is deterministic — no provider call was needed.
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
    // Ephemeral mode: the customer's message save (which sits before
    // the fast paths and is NOT fail-soft in the normal flow) must be
    // skipped — no "customer" row is written for an unread conversation.
    const savedRoles = mockPrisma.message.create.mock.calls.map(
      (c) => (c[0] as { data: { role: string } }).data.role
    );
    expect(savedRoles).not.toContain("customer");
  });

  it("FIX-B: config read rejects -> platform default config is used for a full-pipeline turn", async () => {
    mockPrisma.settings.findFirst.mockRejectedValue(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "Default-config answer" },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "What are your opening hours?");

    expect(result.response).toBe("Default-config answer");
    // Default model from the platform settings defaults (gpt-4o-mini),
    // not the unreadable tenant settings (gpt-4).
    expect(mockOpenAICreateFn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" })
    );
    // The system prompt is built from the default business name —
    // the generic platform default, never an invented tenant fact.
    const callArgs = mockOpenAICreateFn.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain("My Business");
  });

  it("FIX-B: config + conversation reads both reject + greeting -> greeting in the default business name", async () => {
    mockPrisma.settings.findFirst.mockRejectedValue(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );
    mockPrisma.conversation.findUnique.mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "হাই");

    expect(result.response).toBe(
      "হ্যালো, স্যার/ম্যাডাম! My Business-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });

  it("FIX-B: key resolution rejects -> honest not-connected fallback, no throw, no provider call", async () => {
    mockResolveSiteKeys.mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "I need help with my order");

    expect(result.response).toContain("AI brain isn't connected");
    expect(result.aiConfigured).toBe(false);
    expect(result.silent).toBe(false);
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
    // The conversation read SUCCEEDED here, so the turn is not
    // ephemeral: the user message is persisted exactly as before.
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "customer",
          content: "I need help with my order",
        }),
      })
    );
  });

  it("FIX-C: knowledge read rejects -> chat completes and the prompt carries the zero-knowledge honesty block", async () => {
    mockPrisma.knowledgeEntry.findMany.mockRejectedValueOnce(
      new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.")
    );
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "General answer" },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "What is your return policy?");

    expect(result.response).toBe("General answer");
    const callArgs = mockOpenAICreateFn.mock.calls[0][0];
    const systemMessage = callArgs.messages[0];
    expect(systemMessage.content).toContain(
      "No knowledge base entries are available for this business yet"
    );
    expect(systemMessage.content).toContain("NO verified facts");
  });

  it("FIX-B regression guard: a readable conversation with aiEnabled=false still goes silently to human takeover", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-1",
      channel: "whatsapp",
      customerName: "John",
      customerContact: "+1555",
      status: "active",
      aiEnabled: false,
      messages: [],
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Hello, I need a person");

    // Takeover semantics are NOT weakened by the degradation paths:
    // when the read succeeds, aiEnabled=false still stores silently.
    expect(result.silent).toBe(true);
    expect(result.response).toBe("");
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "customer" }),
      })
    );
  });
});
