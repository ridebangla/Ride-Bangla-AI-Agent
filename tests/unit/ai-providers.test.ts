/**
 * ai-providers.test.ts — unit tests for the multi-provider LLM layer.
 *
 * All provider calls are mocked; NO real API keys are used anywhere.
 * Env keys are fake values set per-test and restored afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";

// ---- Mock the OpenAI SDK (used for openai + groq) ----
const mockCreate = vi.fn();
const constructedClients: Array<{ opts: Record<string, unknown> }> = [];
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
      audio = { transcriptions: { create: vi.fn() } };
      constructor(opts: Record<string, unknown>) {
        constructedClients.push({ opts });
      }
    },
    toFile: vi.fn(async (bytes: Buffer, name: string) => ({ bytes, name })),
  };
});

import {
  AllProvidersFailedError,
  completeWithFallback,
  completeWithProvider,
  getProviderPriority,
  hasAnyProviderKey,
  keyedProviders,
  normalizePreferredProvider,
  normalizeProviderHint,
  publicProviderStatus,
  resolveSiteKeys,
  type ProviderKeys,
} from "@/lib/ai/providers";
import { maskSettingsSecrets } from "@/lib/security";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const FAKE = {
  groq: "gsk-test-fake-groq-key-123",
  gemini: "AIza-test-fake-gemini-key-456",
  openai: "sk-test-fake-openai-key-789",
};

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_PROVIDER_PRIORITY: process.env.AI_PROVIDER_PRIORITY,
  };
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIORITY;
  mockCreate.mockReset();
  constructedClients.length = 0;
  mockPrisma.settings.findFirst.mockReset();
  mockPrisma.settings.findFirst.mockResolvedValue(null);
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

function geminiFetchOk(text: string, functionCalls?: Array<{ name: string; args: object }>) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              ...(text ? [{ text }] : []),
              ...(functionCalls ?? []).map((fc) => ({ functionCall: fc })),
            ],
          },
        },
      ],
    }),
  }));
}

function openAiOk(text: string, toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>) {
  mockCreate.mockResolvedValue({
    choices: [
      {
        message: {
          content: text,
          ...(toolCalls ? { tool_calls: toolCalls.map((t) => ({ ...t, type: "function" })) } : {}),
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */

describe("getProviderPriority", () => {
  it("defaults to groq,gemini,openai", () => {
    expect(getProviderPriority()).toEqual(["groq", "gemini", "openai"]);
  });
  it("parses AI_PROVIDER_PRIORITY and drops unknown names", () => {
    expect(getProviderPriority("gemini,openai,bogus,groq")).toEqual(["gemini", "openai", "groq"]);
  });
  it("dedupes and falls back to default when empty", () => {
    expect(getProviderPriority("groq,groq")).toEqual(["groq"]);
    expect(getProviderPriority("")).toEqual(["groq", "gemini", "openai"]);
  });
});

describe("normalizeProviderHint / normalizePreferredProvider", () => {
  it("accepts the allowlisted hints", () => {
    expect(normalizeProviderHint("auto")).toBe("auto");
    expect(normalizeProviderHint("groq")).toBe("groq");
    expect(normalizeProviderHint("GEMINI")).toBe("gemini");
    expect(normalizeProviderHint(undefined)).toBe("auto");
  });
  it("rejects anything else loudly", () => {
    expect(() => normalizeProviderHint("claude")).toThrow(/Invalid provider hint/);
    expect(() => normalizeProviderHint("evil")).toThrow(/Invalid provider hint/);
  });
  it("maps legacy claude/ollama provider values to null (auto chain)", () => {
    expect(normalizePreferredProvider("groq")).toBe("groq");
    expect(normalizePreferredProvider("claude")).toBeNull();
    expect(normalizePreferredProvider("ollama")).toBeNull();
    expect(normalizePreferredProvider("")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("resolveSiteKeys", () => {
  it("falls back to env keys when no site config exists", async () => {
    process.env.GROQ_API_KEY = FAKE.groq;
    process.env.GEMINI_API_KEY = FAKE.gemini;
    mockPrisma.settings.findFirst.mockResolvedValue(null);
    const keys = await resolveSiteKeys();
    expect(keys.groq).toBe(FAKE.groq);
    expect(keys.gemini).toBe(FAKE.gemini);
    expect(keys.openai).toBeNull();
  });

  it("prefers the site's own dedicated keys over env", async () => {
    process.env.GROQ_API_KEY = "gsk-shared-env-key";
    process.env.GEMINI_API_KEY = FAKE.gemini;
    mockPrisma.settings.findFirst.mockResolvedValue({
      aiKeys: { groq: "gsk-site-dedicated", gemini: "", openai: null },
      aiApiKey: "",
      aiProvider: "openai",
    });
    const keys = await resolveSiteKeys("biz-123");
    expect(keys.groq).toBe("gsk-site-dedicated"); // site key wins
    expect(keys.gemini).toBe(FAKE.gemini); // falls back to env
    expect(mockPrisma.settings.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: "biz-123" } })
    );
  });

  it("merges the legacy single dashboard key under its provider", async () => {
    mockPrisma.settings.findFirst.mockResolvedValue({
      aiKeys: {},
      aiApiKey: "sk-legacy-dashboard",
      aiProvider: "openai",
    });
    const keys = await resolveSiteKeys();
    expect(keys.openai).toBe("sk-legacy-dashboard");
    expect(keys.groq).toBeNull();
  });

  it("ignores the legacy key when the provider is a legacy (unimplemented) one", async () => {
    mockPrisma.settings.findFirst.mockResolvedValue({
      aiApiKey: "some-key",
      aiProvider: "claude",
    });
    const keys = await resolveSiteKeys();
    expect(keys.openai).toBeNull();
    expect(keys.groq).toBeNull();
    expect(keys.gemini).toBeNull();
  });

  it("survives Firestore errors and still returns env keys", async () => {
    process.env.GROQ_API_KEY = FAKE.groq;
    mockPrisma.settings.findFirst.mockRejectedValue(new Error("firestore down"));
    const keys = await resolveSiteKeys("biz-9");
    expect(keys.groq).toBe(FAKE.groq);
  });

  it("hasAnyProviderKey / keyedProviders behave", () => {
    expect(hasAnyProviderKey({})).toBe(false);
    expect(hasAnyProviderKey({ groq: "x" })).toBe(true);
    expect(keyedProviders({ groq: "x", openai: "y" })).toEqual(["groq", "openai"]);
  });
});

/* ------------------------------------------------------------------ */

describe("completeWithFallback", () => {
  it("uses the first keyed provider in priority order", async () => {
    openAiOk("hello from groq");
    const res = await completeWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      { keys: { groq: FAKE.groq, gemini: FAKE.gemini }, label: "t" }
    );
    expect(res?.provider).toBe("groq");
    expect(res?.text).toBe("hello from groq");
    expect(constructedClients[0].opts).toMatchObject({ baseURL: "https://api.groq.com/openai/v1" });
  });

  it("fails over from groq to gemini on provider error", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("Rate limit"), { status: 429 }));
    vi.stubGlobal("fetch", geminiFetchOk("hello from gemini"));
    const res = await completeWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      { keys: { groq: FAKE.groq, gemini: FAKE.gemini }, label: "t" }
    );
    expect(res?.provider).toBe("gemini");
    expect(res?.text).toBe("hello from gemini");
  });

  it("tries the preferred provider first, then the chain", async () => {
    mockCreate.mockRejectedValueOnce(new Error("openai down"));
    openAiOk("recovered via groq");
    const res = await completeWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      {
        keys: { openai: FAKE.openai, groq: FAKE.groq },
        preferredProvider: "openai",
        label: "t",
      }
    );
    expect(res?.provider).toBe("groq");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("returns null (honest degraded) when NO key resolves", async () => {
    const res = await completeWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      { keys: {}, label: "t" }
    );
    expect(res).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("throws AllProvidersFailedError when every provider fails", async () => {
    mockCreate.mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "err" })));
    await expect(
      completeWithFallback(
        { messages: [{ role: "user", content: "hi" }] },
        { keys: { groq: FAKE.groq, gemini: FAKE.gemini }, label: "t" }
      )
    ).rejects.toThrow(AllProvidersFailedError);
  });

  it("pinned provider: attempts only that provider, throws on failure", async () => {
    mockCreate.mockRejectedValue(new Error("groq exploded"));
    await expect(
      completeWithFallback(
        { messages: [{ role: "user", content: "hi" }] },
        { keys: { groq: FAKE.groq, gemini: FAKE.gemini }, providerHint: "groq", label: "t" }
      )
    ).rejects.toMatchObject({ name: "AllProvidersFailedError", pinned: "groq" });
  });

  it("pinned provider without a key throws a no-key error (no silent switch)", async () => {
    await expect(
      completeWithFallback(
        { messages: [{ role: "user", content: "hi" }] },
        { keys: { gemini: FAKE.gemini }, providerHint: "groq", label: "t" }
      )
    ).rejects.toThrow(/no API key is configured/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("remaps a non-native model id on groq instead of sending it raw", async () => {
    openAiOk("ok");
    await completeWithProvider("groq", { groq: FAKE.groq }, {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-4o-mini", // not a groq model
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "llama-3.3-70b-versatile" }));
  });

  it("maps tool calls through gemini function calling", async () => {
    const seenBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        seenBodies.push(JSON.parse(init.body));
        return {
          ok: true,
          json: async () => ({
            candidates: [
              { content: { parts: [{ functionCall: { name: "get_customer_history", args: { a: 1 } } }] } },
            ],
          }),
        };
      })
    );
    const res = await completeWithProvider("gemini", { gemini: FAKE.gemini }, {
      messages: [{ role: "user", content: "history?" }],
      tools: [{ type: "function", function: { name: "get_customer_history", description: "d", parameters: { type: "object", properties: {} } } }],
    });
    expect(res.provider).toBe("gemini");
    expect(res.toolCalls?.[0]?.function.name).toBe("get_customer_history");
    expect(JSON.stringify(seenBodies[0])).toContain("functionDeclarations");
  });
});

/* ------------------------------------------------------------------ */

describe("key hygiene — keys never leak into client-safe payloads", () => {
  it("publicProviderStatus exposes booleans only", () => {
    const keys: ProviderKeys = { groq: FAKE.groq, gemini: FAKE.gemini, openai: FAKE.openai };
    const status = publicProviderStatus(keys);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(FAKE.groq);
    expect(serialized).not.toContain(FAKE.gemini);
    expect(serialized).not.toContain(FAKE.openai);
    expect(status.providers).toEqual({ openai: true, groq: true, gemini: true, openrouter: false });
  });

  it("maskSettingsSecrets deep-masks aiKeys without exposing material", () => {
    const masked = maskSettingsSecrets({
      businessName: "Biz",
      aiApiKey: "sk-legacy-secret",
      aiKeys: { groq: FAKE.groq, gemini: "", openai: null },
      smtpPass: "smtp-secret",
    });
    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain(FAKE.groq);
    expect(serialized).not.toContain("sk-legacy-secret");
    expect(serialized).not.toContain("smtp-secret");
    expect(masked).toMatchObject({
      businessName: "Biz",
      aiApiKey: "***",
      aiKeys: { groq: "***", gemini: "", openai: "" },
      smtpPass: "***",
    });
  });

  it("AllProvidersFailedError reasons never contain key material", async () => {
    mockCreate.mockRejectedValue(new Error("nope"));
    const keys: ProviderKeys = { groq: FAKE.groq };
    try {
      await completeWithFallback({ messages: [{ role: "user", content: "hi" }] }, { keys, label: "t" });
      expect.unreachable();
    } catch (err) {
      const e = err as AllProvidersFailedError;
      expect(JSON.stringify(e.attempts)).not.toContain(FAKE.groq);
    }
  });
});
