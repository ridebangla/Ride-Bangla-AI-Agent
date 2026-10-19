import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

// Mock OpenAI (same pattern as phase3.test.ts)
const mockOpenAICreateFn = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockOpenAICreateFn,
        },
      };
      audio = {
        transcriptions: { create: vi.fn() },
      };
    },
  };
});

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

const DEFAULT_SETTINGS = {
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
  aiEnabled: true,
};

const DEFAULT_CONVERSATION = {
  id: "conv-1",
  channel: "widget",
  customerName: "Visitor",
  customerContact: "v-1",
  status: "active",
  aiEnabled: true,
  messages: [],
};

const ACTIVE_BIZ = {
  id: "biz-1",
  isActive: true,
  subscriptionStatus: "active",
  trialEndsAt: null,
  plan: "starter",
};

const INACTIVE_BIZ = {
  id: "biz-1",
  isActive: true,
  subscriptionStatus: "expired",
  trialEndsAt: null,
  plan: "trial",
};

describe("Phase 5: Meta webhook signature verification", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_APP_ID = "app-id-123";
    process.env.META_APP_SECRET = "super-secret-abc";
    process.env.META_VERIFY_TOKEN = "verify-token-xyz";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("accepts a correctly signed payload", async () => {
    const { verifyMetaSignature } = await import("@/lib/channels/meta");
    const body = JSON.stringify({ object: "page", entry: [] });
    const sig =
      "sha256=" +
      crypto.createHmac("sha256", "super-secret-abc").update(body, "utf8").digest("hex");
    expect(verifyMetaSignature(body, sig)).toBe(true);
  });

  it("rejects a wrong signature (fail-closed)", async () => {
    const { verifyMetaSignature } = await import("@/lib/channels/meta");
    expect(verifyMetaSignature("{}", "sha256=deadbeef")).toBe(false);
  });

  it("rejects when the secret is not configured", async () => {
    delete process.env.META_APP_SECRET;
    const { verifyMetaSignature } = await import("@/lib/channels/meta");
    expect(verifyMetaSignature("{}", "sha256=anything")).toBe(false);
  });

  it("rejects when the signature header is missing", async () => {
    const { verifyMetaSignature } = await import("@/lib/channels/meta");
    expect(verifyMetaSignature("{}", null)).toBe(false);
  });

  it("verifies the subscription handshake only with the right token", async () => {
    const { verifyMetaSubscription } = await import("@/lib/channels/meta");
    expect(verifyMetaSubscription("subscribe", "verify-token-xyz")).toBe(true);
    expect(verifyMetaSubscription("subscribe", "wrong")).toBe(false);
    expect(verifyMetaSubscription("unsubscribe", "verify-token-xyz")).toBe(false);
  });

  it("reports unconfigured when env is missing (honest state)", async () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    const { isMetaConfigured } = await import("@/lib/channels/meta");
    expect(isMetaConfigured()).toBe(false);
  });
});

describe("Phase 5: WhatsApp Cloud webhook verification", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_TOKEN = "wa-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "12345";
    process.env.WHATSAPP_VERIFY_TOKEN = "wa-verify";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("verifies the handshake with the right token", async () => {
    const { verifyWhatsAppSubscription } = await import(
      "@/lib/channels/whatsapp-cloud"
    );
    expect(verifyWhatsAppSubscription("subscribe", "wa-verify")).toBe(true);
    expect(verifyWhatsAppSubscription("subscribe", "nope")).toBe(false);
  });

  it("is not configured when env is missing", async () => {
    delete process.env.WHATSAPP_TOKEN;
    const { isWhatsAppCloudConfigured } = await import(
      "@/lib/channels/whatsapp-cloud"
    );
    expect(isWhatsAppCloudConfigured()).toBe(false);
  });
});

describe("Phase 5: X helpers", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.X_API_KEY = "ck";
    process.env.X_API_SECRET = "cs";
    process.env.X_BEARER_TOKEN = "bearer";
    process.env.X_ACCESS_TOKEN = "at";
    process.env.X_ACCESS_SECRET = "as";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("answers the CRC challenge with HMAC-SHA256 of the consumer secret", async () => {
    const { answerXCRChallenge } = await import("@/lib/social/x");
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", "cs").update("crc-token-1").digest("base64");
    expect(answerXCRChallenge("crc-token-1")).toBe(expected);
  });

  it("refuses the CRC challenge without a secret (honest, never faked)", async () => {
    delete process.env.X_API_SECRET;
    const { answerXCRChallenge } = await import("@/lib/social/x");
    expect(answerXCRChallenge("crc-token-1")).toBeNull();
  });

  it("signs OAuth 1.0a deterministically with fixed nonce/timestamp", async () => {
    const { signOAuth1 } = await import("@/lib/social/x");
    const a = signOAuth1(
      { method: "POST", url: "https://api.twitter.com/2/tweets", bodyParams: {} },
      "ck",
      "cs",
      "at",
      "as",
      "fixednonce",
      "1700000000"
    );
    const b = signOAuth1(
      { method: "POST", url: "https://api.twitter.com/2/tweets", bodyParams: {} },
      "ck",
      "cs",
      "at",
      "as",
      "fixednonce",
      "1700000000"
    );
    expect(a).toBe(b);
    expect(a.startsWith("OAuth ")).toBe(true);
    expect(a).toContain("oauth_signature=");
    expect(a).toContain('oauth_consumer_key="ck"');
  });
});

describe("Phase 5: global AI kill-switch in the chat pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenAICreateFn.mockReset();
    mockPrisma.settings.findFirst.mockResolvedValue(DEFAULT_SETTINGS);
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue(DEFAULT_CONVERSATION);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it("stays silent when settings.aiEnabled is false (global kill-switch)", async () => {
    mockPrisma.settings.findFirst.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      aiEnabled: false,
    });
    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "hello?");

    expect(result.silent).toBe(true);
    expect(result.response).toBe("");
    // Zero AI spend: the model was never called, but the message was stored.
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).toHaveBeenCalled();
  });

  it("replies normally when settings.aiEnabled is true", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "Hi there!" } }],
    });
    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "hello?");

    expect(result.silent).toBe(false);
    expect(result.response).toBe("Hi there!");
    expect(mockOpenAICreateFn).toHaveBeenCalled();
  });

  it("per-conversation aiEnabled=false still silences when global is on", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue({
      ...DEFAULT_CONVERSATION,
      aiEnabled: false,
    });
    const { chat } = await import("@/lib/ai/engine");
    const result = await chat("conv-1", "hello?");

    expect(result.silent).toBe(true);
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });
});

describe("Phase 5: subscription hard-stop on channel inbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenAICreateFn.mockReset();
    mockPrisma.settings.findFirst.mockResolvedValue(DEFAULT_SETTINGS);
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue(DEFAULT_CONVERSATION);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it("stores the message silently when the subscription is inactive (no AI spend)", async () => {
    mockPrisma.business.findUnique.mockResolvedValue(INACTIVE_BIZ);
    const { processChannelMessage } = await import(
      "@/lib/channels/inbound"
    );
    const result = await processChannelMessage("conv-1", "biz-1", "hello?");

    expect(result.silent).toBe(true);
    expect(result.blockedBySubscription).toBe(true);
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "customer",
          content: "hello?",
        }),
      })
    );
  });

  it("runs the AI pipeline when the subscription is active", async () => {
    mockPrisma.business.findUnique.mockResolvedValue(ACTIVE_BIZ);
    mockOpenAICreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "Hi there!" } }],
    });
    const { processChannelMessage } = await import(
      "@/lib/channels/inbound"
    );
    const result = await processChannelMessage("conv-1", "biz-1", "hello?");

    expect(result.silent).toBe(false);
    expect(result.response).toBe("Hi there!");
    expect(mockOpenAICreateFn).toHaveBeenCalled();
  });
});

describe("Phase 5: webhook routes reject bad signatures", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_APP_ID = "app-id-123";
    process.env.META_APP_SECRET = "super-secret-abc";
    process.env.META_VERIFY_TOKEN = "verify-token-xyz";
    process.env.WHATSAPP_TOKEN = "wa-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "12345";
    process.env.WHATSAPP_VERIFY_TOKEN = "wa-verify";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("Meta webhook rejects a bad signature with 401", async () => {
    const { POST } = await import("@/app/api/webhooks/meta/route");
    const { createRequest } = await import("../helpers/request");
    const response = await POST(
      createRequest("/api/webhooks/meta", {
        method: "POST",
        body: { object: "page", entry: [] },
        headers: { "x-hub-signature-256": "sha256=wrong" },
      })
    );
    expect(response.status).toBe(401);
  });

  it("Meta webhook accepts the subscription handshake with the right token", async () => {
    const { GET } = await import("@/app/api/webhooks/meta/route");
    const { createRequest } = await import("../helpers/request");
    const response = await GET(
      createRequest("/api/webhooks/meta", {
        searchParams: {
          "hub.mode": "subscribe",
          "hub.verify_token": "verify-token-xyz",
          "hub.challenge": "challenge-123",
        },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-123");
  });

  it("Meta webhook rejects the handshake with a wrong token (403)", async () => {
    const { GET } = await import("@/app/api/webhooks/meta/route");
    const { createRequest } = await import("../helpers/request");
    const response = await GET(
      createRequest("/api/webhooks/meta", {
        searchParams: {
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong",
          "hub.challenge": "challenge-123",
        },
      })
    );
    expect(response.status).toBe(403);
  });

  it("WhatsApp webhook answers the handshake and rejects a bad token", async () => {
    const { GET } = await import("@/app/api/webhooks/whatsapp/route");
    const { createRequest } = await import("../helpers/request");
    const ok = await GET(
      createRequest("/api/webhooks/whatsapp", {
        searchParams: {
          "hub.mode": "subscribe",
          "hub.verify_token": "wa-verify",
          "hub.challenge": "wa-challenge",
        },
      })
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("wa-challenge");

    const bad = await GET(
      createRequest("/api/webhooks/whatsapp", {
        searchParams: {
          "hub.mode": "subscribe",
          "hub.verify_token": "nope",
          "hub.challenge": "wa-challenge",
        },
      })
    );
    expect(bad.status).toBe(403);
  });

  it("X webhook answers CRC only with a secret (503 without)", async () => {
    delete process.env.X_API_SECRET;
    const { GET } = await import("@/app/api/webhooks/x/route");
    const { createRequest } = await import("../helpers/request");
    const response = await GET(
      createRequest("/api/webhooks/x", {
        searchParams: { crc_token: "tok" },
      })
    );
    expect(response.status).toBe(503);
  });
});
