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
    const result = await chat("conv-1", "Hello");

    expect(result.response).toContain("could not generate a response");
  });
});

