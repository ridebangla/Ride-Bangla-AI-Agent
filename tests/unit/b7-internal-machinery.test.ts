/**
 * b7-internal-machinery.test.ts — B7 (AI leg): the company account is
 * OUTSIDE the key/credit/limit machinery.
 *
 * Pins:
 *  (1) recordAiMessage does NOT increment (or write at all) for an
 *      internal business; non-internal metering is byte-identical,
 *      and a string "true" flag does not earn the exemption.
 *  (2) resolveSiteKeys for an internal business returns the PLATFORM
 *      (env) keys only — no tenant key required, a tenant key present
 *      does not override; non-internal resolution is unchanged.
 *  (3) The public-route rate limiters exempt VERIFIED internal
 *      identity (the server-resolved business behind the siteKey):
 *      activity polling, thread polling, and the voice route never
 *      429 the company business, while a non-internal business is
 *      still limited at exactly the same thresholds as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { chatMock } = vi.hoisted(() => ({
  chatMock: vi.fn(async () => ({ response: "ok", products: [], silent: false })),
}));

vi.mock("@/lib/ai/engine", () => ({
  chat: chatMock,
  getAIConfig: vi.fn(async () => ({ language: "en", model: "gpt-4o-mini" })),
  createNewConversation: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({
  getBusinessBySiteKey: vi.fn(async (key: string) =>
    key === "internal-key"
      ? { id: "biz-int", name: "Ride Bangla", isInternalAccount: true }
      : key === "normal-key"
        ? { id: "biz-norm", name: "Tenant" }
        : null
  ),
  enterBusinessContext: vi.fn(),
  runWithBusiness: vi.fn((_id: string, fn: () => unknown) => fn()),
}));

import { prisma, getUnscopedPrisma } from "@/lib/prisma";
import { recordAiMessage } from "@/lib/billing-usage";
import { resolveSiteKeys, hasAnyProviderKey } from "@/lib/ai/providers";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

const RECENT = new Date(Date.now() - 60 * 60 * 1000);

const INTERNAL_REC = {
  id: "biz-int",
  name: "Ride Bangla",
  slug: "ride-bangla",
  isActive: true,
  isInternalAccount: true,
  plan: "trial",
  subscriptionStatus: "trialing",
  trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  aiMessagesUsed: 0,
  usagePeriodStart: RECENT,
};

const NORMAL_REC = {
  id: "biz-norm",
  name: "Tenant",
  slug: "tenant",
  isActive: true,
  plan: "starter",
  subscriptionStatus: "active",
  aiMessagesUsed: 0,
  usagePeriodStart: RECENT,
};

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  vi.clearAllMocks();
  chatMock.mockResolvedValue({ response: "ok", products: [], silent: false });
  savedEnv = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
describe("B7 (1) — recordAiMessage skips metering for internal businesses", () => {
  it("internal: no update is written at all", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({
      aiMessagesUsed: 42,
      usagePeriodStart: RECENT,
      isInternalAccount: true,
    });
    await recordAiMessage("biz-int");
    expect(mockPrisma.business.update).not.toHaveBeenCalled();
  });

  it("non-internal: increments exactly as before", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({
      aiMessagesUsed: 42,
      usagePeriodStart: RECENT,
    });
    await recordAiMessage("biz-norm");
    expect(mockPrisma.business.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { aiMessagesUsed: 43 } })
    );
  });

  it("a string 'true' flag does NOT earn the exemption (spoof discipline)", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({
      aiMessagesUsed: 42,
      usagePeriodStart: RECENT,
      isInternalAccount: "true",
    });
    await recordAiMessage("biz-norm");
    expect(mockPrisma.business.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { aiMessagesUsed: 43 } })
    );
  });
});

// ---------------------------------------------------------------------------
describe("B7 (2) — resolveSiteKeys: internal resolves platform keys only", () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = "platform-groq-key";
    mockPrisma.business.findUnique.mockImplementation(
      async (args: { where?: { id?: string } }) =>
        args?.where?.id === "biz-int" ? INTERNAL_REC : NORMAL_REC
    );
    mockPrisma.settings.findFirst.mockResolvedValue({
      aiKeys: { groq: "tenant-groq-key" },
      aiApiKey: "",
      aiProvider: "openai",
    });
  });

  it("internal with a tenant key present still gets the PLATFORM key", async () => {
    const keys = await resolveSiteKeys("biz-int");
    expect(keys.groq).toBe("platform-groq-key");
    expect(hasAnyProviderKey(keys)).toBe(true);
  });

  it("internal with NO tenant key resolves platform keys (never aiConfigured:false)", async () => {
    mockPrisma.settings.findFirst.mockResolvedValue(null);
    const keys = await resolveSiteKeys("biz-int");
    expect(keys.groq).toBe("platform-groq-key");
    expect(hasAnyProviderKey(keys)).toBe(true);
  });

  it("non-internal resolution is unchanged: the tenant key still wins", async () => {
    const keys = await resolveSiteKeys("biz-norm");
    expect(keys.groq).toBe("tenant-groq-key");
  });
});

// ---------------------------------------------------------------------------
describe("B7 (4) — public-route rate limiters exempt verified internal identity", () => {
  beforeEach(() => {
    mockPrisma.business.findUnique.mockImplementation(
      async (args: { where?: { id?: string } }) =>
        args?.where?.id === "biz-int" ? INTERNAL_REC : NORMAL_REC
    );
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.settings.findFirst.mockResolvedValue(null);
  });

  it("activity polling: internal polls past the limit, non-internal is capped at 120/min", async () => {
    const { GET } = await import("@/app/api/chat/activity/route");
    const { createRequest } = await import("../helpers/request");
    const call = (siteKey: string, token: string) =>
      GET(
        createRequest("/api/chat/activity", {
          searchParams: { siteKey, token },
        })
      );

    // Non-internal: the 121st poll inside the window is refused.
    let lastStatus = 0;
    for (let i = 0; i < 121; i++) {
      lastStatus = (await call("normal-key", "at-norm-1")).status;
    }
    expect(lastStatus).toBe(429);

    // Internal: the same volume never trips the limiter.
    for (let i = 0; i < 125; i++) {
      lastStatus = (await call("internal-key", "at-int-1")).status;
    }
    expect(lastStatus).not.toBe(429);
  });

  it("voice: internal is exempt from the 10/min limiter, non-internal is not", async () => {
    const { POST } = await import("@/app/api/chat/voice/route");
    const { createRequest } = await import("../helpers/request");
    mockPrisma.conversation.create.mockResolvedValue({ id: "conv-1" });
    const call = (siteKey: string, visitorId: string) =>
      POST(
        createRequest("http://localhost:3000/api/chat/voice", {
          method: "POST",
          body: {
            siteKey,
            visitorId,
            audio: { mimeType: "audio/webm", base64: "aGVsbG8=" },
          },
        })
      );

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      lastStatus = (await call("normal-key", "visitor-norm")).status;
    }
    expect(lastStatus).toBe(429);

    for (let i = 0; i < 12; i++) {
      lastStatus = (await call("internal-key", "visitor-int")).status;
    }
    expect(lastStatus).not.toBe(429);
  });
});

// Silence an unused-import warning path: getUnscopedPrisma is the same
// mock client as prisma in tests/setup.ts.
void getUnscopedPrisma;
