/**
 * az-audit-fixes.test.ts — regression tests for the 2026-10-20 A-to-Z
 * audit fixes: signed Meta OAuth state + OpenRouter as a first-class
 * provider (mocked SDK; no real keys anywhere).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  createMetaOAuthState,
  verifyMetaOAuthState,
} from "@/lib/meta-oauth-state";
import {
  completeWithProvider,
  defaultModelFor,
  normalizePreferredProvider,
  normalizeProviderHint,
  OPENROUTER_BASE_URL,
} from "@/lib/ai/providers";

describe("meta oauth state (signed)", () => {
  const saved = process.env.META_APP_SECRET;
  beforeEach(() => {
    process.env.META_APP_SECRET = "test-secret-for-state-signing";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = saved;
  });

  it("round-trips a minted state", () => {
    const state = createMetaOAuthState("biz-123");
    expect(state).toBeTruthy();
    expect(verifyMetaOAuthState(state!)?.businessId).toBe("biz-123");
  });

  it("rejects the OLD unsigned base64 state format", () => {
    const legacy = Buffer.from(
      JSON.stringify({ businessId: "victim-biz", nonce: Date.now() })
    ).toString("base64url");
    expect(verifyMetaOAuthState(legacy)).toBeNull();
  });

  it("rejects a tampered businessId", () => {
    const state = createMetaOAuthState("biz-123")!;
    const [payload, sig] = state.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ businessId: "victim-biz", iat: Date.now(), nonce: "x" })
    ).toString("base64url");
    expect(verifyMetaOAuthState(`${forgedPayload}.${sig}`)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it("rejects a stale state", () => {
    const state = createMetaOAuthState("biz-123")!;
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60 * 1000;
    try {
      expect(verifyMetaOAuthState(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("openrouter provider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    constructedClients.length = 0;
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: { role: "assistant", content: "hello from openrouter" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
  });

  it("is a recognized provider everywhere", () => {
    expect(normalizePreferredProvider("openrouter")).toBe("openrouter");
    expect(normalizeProviderHint("openrouter")).toBe("openrouter");
  });

  it("constructs the OpenAI client against the OpenRouter base URL", async () => {
    const result = await completeWithProvider(
      "openrouter",
      { openrouter: "sk-or-test-fake" },
      { messages: [{ role: "user", content: "hi" }] }
    );
    expect(result.text).toBe("hello from openrouter");
    expect(constructedClients).toHaveLength(1);
    expect(constructedClients[0].opts.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(constructedClients[0].opts.baseURL).toBe(
      "https://openrouter.ai/api/v1"
    );
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.model).toBe(defaultModelFor("openrouter"));
  });

  it("passes a configured namespaced model through unchanged", async () => {
    await completeWithProvider(
      "openrouter",
      { openrouter: "sk-or-test-fake" },
      {
        messages: [{ role: "user", content: "hi" }],
        model: "anthropic/claude-sonnet-4",
      }
    );
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.model).toBe("anthropic/claude-sonnet-4");
  });
});
