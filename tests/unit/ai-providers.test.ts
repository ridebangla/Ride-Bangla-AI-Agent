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
  isRequestSizeError,
  keyedProviders,
  normalizePreferredProvider,
  normalizeProviderHint,
  publicProviderStatus,
  resolveSiteKeys,
  __resetProviderBreakers,
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
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/gpt-oss-120b" }));
  });

  it("remaps a stored retired groq model id to the current default", async () => {
    openAiOk("ok");
    await completeWithProvider("groq", { groq: FAKE.groq }, {
      messages: [{ role: "user", content: "hi" }],
      model: "llama-3.3-70b-versatile", // retired by Groq (live 404, 2026-10-21)
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/gpt-oss-120b" }));
  });

  it("groq falls over to the next catalogue model ONLY on model_not_found", async () => {
    const notFound = Object.assign(
      new Error("404 The model `openai/gpt-oss-120b` does not exist or you do not have access to it."),
      { status: 404, code: "model_not_found" }
    );
    mockCreate
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ choices: [{ message: { content: "ok from scout" } }] });
    const res = await completeWithProvider("groq", { groq: FAKE.groq }, {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.provider).toBe("groq");
    expect(res.model).toBe("meta-llama/llama-4-scout-17b-16e-instruct");
    expect(res.text).toBe("ok from scout");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: "openai/gpt-oss-120b" }));
    expect(mockCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: "meta-llama/llama-4-scout-17b-16e-instruct" }));
  });

  it("groq does NOT fall over on non-model errors (auth surfaces immediately)", async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error("401 invalid api key"), { status: 401 }));
    await expect(
      completeWithProvider("groq", { groq: FAKE.groq }, {
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toThrow(/401/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("remaps a stored retired gemini model id to the current default", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seenUrls.push(String(url));
        return {
          ok: true,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }),
        };
      })
    );
    const res = await completeWithProvider("gemini", { gemini: FAKE.gemini }, {
      messages: [{ role: "user", content: "hi" }],
      model: "gemini-2.0-flash", // retired by Google (live 404, 2026-10-21)
    });
    expect(res.model).toBe("gemini-3.8-flash");
    expect(seenUrls[0]).toContain("gemini-3.8-flash");
    expect(seenUrls[0]).not.toContain("gemini-2.0-flash");
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

/* ------------------------------------------------------------------ */
/* Re-audit #2 (2026-10-22): request-size rejections + Gemini leg.    */
/* Production evidence: Groq answered oversized requests with HTTP    */
/* 413 "[rate_limit_exceeded] Request too large … Limit 8000,          */
/* Requested 9081–10521" — and the old classification let two of      */
/* those trip the rate breaker and sideline the only working          */
/* provider for every smaller, healthy request behind them.           */
/* ------------------------------------------------------------------ */
describe("re-audit #2 — request-size rejections", () => {
  beforeEach(() => {
    __resetProviderBreakers();
  });

  it("isRequestSizeError recognises the production 413 shape", () => {
    expect(
      isRequestSizeError(
        new Error(
          "groq: HTTP 413 [rate_limit_exceeded] 413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` on tokens per minute (TPM): Limit 8000, Requested 9081, please reduce your message size and try again."
        )
      )
    ).toBe(true);
    expect(
      isRequestSizeError(Object.assign(new Error("x"), { status: 413 }))
    ).toBe(true);
    expect(
      isRequestSizeError(
        new Error("groq: HTTP 429 [rate_limit_exceeded] Rate limit reached for model")
      )
    ).toBe(false);
    expect(isRequestSizeError(new Error("openai: HTTP 500 boom"))).toBe(false);
  });

  it("size rejections never trip the circuit breaker", async () => {
    const keys: ProviderKeys = { groq: FAKE.groq };
    const sizeErr = Object.assign(
      new Error(
        "413 Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 10521, please reduce your message size"
      ),
      { status: 413 }
    );
    mockCreate.mockRejectedValue(sizeErr);
    await expect(
      completeWithFallback({ messages: [{ role: "user", content: "hi" }] }, { keys })
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
    await expect(
      completeWithFallback({ messages: [{ role: "user", content: "hi" }] }, { keys })
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
    // Third call: groq must STILL be attempted (breaker stayed closed
    // for size rejections) — and now it answers.
    openAiOk("small answer");
    const res = await completeWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      { keys }
    );
    expect(res?.text).toBe("small answer");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("fails over to Gemini when it holds a key (F2 leg)", async () => {
    const keys: ProviderKeys = { groq: FAKE.groq, gemini: FAKE.gemini };
    mockCreate.mockRejectedValue(
      Object.assign(new Error("429 Rate limit reached for model"), {
        status: 429,
      })
    );
    vi.stubGlobal("fetch", geminiFetchOk("gemini answer"));
    const res = await completeWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      { keys }
    );
    expect(res?.provider).toBe("gemini");
    expect(res?.text).toBe("gemini answer");
  });

  it("keyedProviders includes gemini in priority order when it holds a key", () => {
    expect(keyedProviders({ gemini: FAKE.gemini })).toEqual(["gemini"]);
    expect(
      keyedProviders({
        groq: FAKE.groq,
        gemini: FAKE.gemini,
        openai: FAKE.openai,
      })
    ).toEqual(["groq", "gemini", "openai"]);
  });
});
