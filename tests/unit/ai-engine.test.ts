import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

// Mock OpenAI
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

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("AI Engine", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockOpenAICreateFn.mockReset();

    // Default settings
    mockPrisma.settings.findFirst.mockResolvedValue({
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
    });

    mockPrisma.settings.create.mockResolvedValue({
      id: "default",
      aiApiKey: "",
    });

    // Default knowledge base
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);

    // Default conversation
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-1",
      channel: "whatsapp",
      customerName: "John",
      customerContact: "+1555",
      status: "active",
      messages: [
        { role: "customer", content: "Hi", createdAt: new Date() },
      ],
    });

    // Default message creation
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it("should return fallback when AI API key is not configured", async () => {
    mockPrisma.settings.findFirst.mockResolvedValue({
      id: "default",
      aiApiKey: "",
      aiProvider: "openai",
      aiModel: "gpt-4",
      maxTokens: 1000,
      temperature: 0.7,
      businessName: "Test",
      businessDesc: "",
      welcomeMessage: "",
      tone: "friendly",
      language: "auto",
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Hello");

    expect(result.response).toContain("AI brain isn't connected");
    expect(result.silent).toBe(false);
    expect(result.products).toEqual([]);
  });

  it("should return error when conversation not found", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("nonexistent", "Hello");

    expect(result.response).toBe("Conversation not found.");
    expect(result.silent).toBe(false);
  });

  it("should call OpenAI with correct parameters", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "Hello! How can I help?" },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "I need help");

    expect(result.response).toBe("Hello! How can I help?");
    expect(result.products).toEqual([]);
    expect(result.silent).toBe(false);
    expect(mockOpenAICreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4",
        max_tokens: 1000,
        temperature: 0.7,
      })
    );
  });

  it("should save user and assistant messages", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "I can help with that." },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    await chat("conv-1", "Help me");

    // User message saved
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "customer",
          content: "Help me",
        }),
      })
    );

    // Assistant message saved
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "assistant",
          content: "I can help with that.",
        }),
      })
    );
  });

  it("should include knowledge base in system prompt", async () => {
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
      {
        category: { name: "FAQ" },
        title: "Return Policy",
        content: "30-day returns allowed",
        priority: 10,
      },
    ]);

    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "Our return policy..." },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    await chat("conv-1", "What is your return policy?");

    const callArgs = mockOpenAICreateFn.mock.calls[0][0];
    const systemMessage = callArgs.messages[0];
    expect(systemMessage.content).toContain("Return Policy");
    expect(systemMessage.content).toContain("30-day returns allowed");
  });

  it("should handle tool calls and recurse", async () => {
    // First call returns tool_calls
    mockOpenAICreateFn
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "get_customer_history",
                    arguments: JSON.stringify({ customerContact: "+1555" }),
                  },
                },
              ],
            },
          },
        ],
      })
      // Second call returns final response
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Based on your history, I can see...",
            },
          },
        ],
      });

    // Mock the customer history tool
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Do you know me?");

    expect(result.response).toBe("Based on your history, I can see...");
    expect(mockOpenAICreateFn).toHaveBeenCalledTimes(2);
  });

  it("should return fallback message when content is empty", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "" },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    // Voice/video round (F7): this case used to send "Hello", but a
    // bare greeting no longer reaches the provider at all (it is
    // answered deterministically) — a substantive message keeps
    // this case testing what it always tested: an empty provider
    // completion degrades to the honest fallback.
    const result = await chat("conv-1", "Tell me something");

    expect(result.response).toContain("could not generate a response");
  });

  it("re-audit #2 (F6): a failed completion is salvaged by one reduced retry", async () => {
    const sizeError = Object.assign(
      new Error(
        "413 Request too large for model `gpt-4` on tokens per minute (TPM): Limit 8000, Requested 9081, please reduce your message size"
      ),
      { status: 413 }
    );
    mockOpenAICreateFn
      .mockRejectedValueOnce(sizeError)
      .mockResolvedValueOnce({
        choices: [
          { finish_reason: "stop", message: { content: "Salvaged answer" } },
        ],
      });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Tell me about your services");

    expect(result.response).toBe("Salvaged answer");
    expect(mockOpenAICreateFn).toHaveBeenCalledTimes(2);
    // The salvage request is reduced: no tools, small maxTokens.
    const salvageParams = mockOpenAICreateFn.mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(salvageParams.tools).toBeUndefined();
    expect(salvageParams.max_tokens).toBeLessThanOrEqual(512);
  });

  it("re-audit #2 (F6): when the salvage also fails, the generic failure reply stands", async () => {
    const sizeError = Object.assign(
      new Error(
        "413 Request too large for model `gpt-4` on tokens per minute (TPM): Limit 8000, Requested 9081, please reduce your message size"
      ),
      { status: 413 }
    );
    mockOpenAICreateFn.mockRejectedValue(sizeError);

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Tell me about your services");

    expect(result.response).toContain(
      "temporarily unable to process your request"
    );
  });

  it("voice/video round (F7): a pure greeting is answered deterministically — ZERO provider calls, reply persisted", async () => {
    // The provider would answer if called — the point is it is NOT
    // called: a bare greeting must survive a dead provider layer.
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "PROVIDER REPLY — must not be used" },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Hello");

    expect(result.response).toBe(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
    // Persistence mirrors the identity path: the customer message
    // and the assistant greeting are both saved.
    const savedContents = mockPrisma.message.create.mock.calls.map(
      (c) => (c[0] as { data: { content: string } }).data.content
    );
    expect(savedContents).toContain("Hello");
    expect(savedContents).toContain(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
  });

  it("voice/video round (F7): a Bengali greeting is answered in Bengali with zero provider calls", async () => {
    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "হাই");

    expect(result.response).toBe(
      "হ্যালো, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });

  it("voice/video round (F7): a greeting answers even when the provider layer hard-fails", async () => {
    mockOpenAICreateFn.mockRejectedValue(
      Object.assign(new Error("429 Too Many Requests"), { status: 429 })
    );

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "আসসালামু আলাইকুম");

    expect(result.response).toBe(
      "ওয়ালাইকুম আসসালাম, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(result.silent).toBe(false);
  });

  it("re-audit #2 (F7): a greeting plus a question uses the full pipeline", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        { finish_reason: "stop", message: { content: "We offer delivery." } },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "Hello, what services do you offer?");

    expect(result.response).toBe("We offer delivery.");
    const params = mockOpenAICreateFn.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(params.tools).toBeDefined();
  });
});

