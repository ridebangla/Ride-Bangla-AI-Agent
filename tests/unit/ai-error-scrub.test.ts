/**
 * ai-error-scrub.test.ts — regression tests for the attack-test 2026-10-21
 * error-path leakage fix:
 *  - provider error text must never carry the presented API key into
 *    AllProvidersFailedError reasons (logs / stored messages / responses),
 *    even if a provider or proxy echoes the credential in its error body;
 *  - ordinary provider errors keep their useful shape (status + code),
 *    only key material is stripped.
 * Mocks only; fake keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
      audio = { transcriptions: { create: vi.fn() } };
      constructor(_opts: Record<string, unknown>) {}
    },
    toFile: vi.fn(async (bytes: Buffer, name: string) => ({ bytes, name })),
  };
});

import {
  AllProvidersFailedError,
  completeWithFallback,
  scrubKeyMaterial,
  type ProviderKeys,
} from "@/lib/ai/providers";

const FAKE_OPENAI = "sk-FAKE-OPENAI-KEY-for-scrub-test";
const FAKE_GEMINI = "AIza-FAKE-GEMINI-KEY-for-scrub-test";
const REQ = { messages: [{ role: "user" as const, content: "hi" }] };

function sdkError(message: string, status?: number, code?: string) {
  const e = new Error(message) as Error & { status?: number; code?: string };
  if (status !== undefined) e.status = status;
  if (code !== undefined) e.code = code;
  return e;
}

beforeEach(() => {
  mockCreate.mockReset();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scrubKeyMaterial", () => {
  it("removes every occurrence of the key", () => {
    expect(scrubKeyMaterial(`bad key ${FAKE_OPENAI} and again ${FAKE_OPENAI}`, FAKE_OPENAI)).toBe(
      "bad key [redacted] and again [redacted]"
    );
  });
  it("leaves text untouched when no/empty/short key", () => {
    expect(scrubKeyMaterial("hello", null)).toBe("hello");
    expect(scrubKeyMaterial("hello", "")).toBe("hello");
    expect(scrubKeyMaterial("hello", "short")).toBe("hello");
  });
});

describe("provider error scrubbing (attack regression)", () => {
  it("openai-style error echoing the key: attempts reason is scrubbed, status/code kept", async () => {
    mockCreate.mockRejectedValue(
      sdkError(`401 invalid key presented: ${FAKE_OPENAI}`, 401, "invalid_api_key")
    );
    const keys: ProviderKeys = { openai: FAKE_OPENAI };
    const err = await completeWithFallback(REQ, { keys, label: "scrub-test" }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const reason = (err as AllProvidersFailedError).attempts[0].reason;
    expect(reason).not.toContain(FAKE_OPENAI);
    expect(reason).toContain("[redacted]");
    expect(reason).toContain("HTTP 401");
    expect(reason).toContain("invalid_api_key");
  });

  it("gemini error body echoing the key: attempts reason is scrubbed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => `{"error":{"message":"API key not valid: ${FAKE_GEMINI}"}}`,
        json: async () => ({}),
      }))
    );
    const keys: ProviderKeys = { gemini: FAKE_GEMINI };
    const err = await completeWithFallback(REQ, { keys, label: "scrub-test" }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const reason = (err as AllProvidersFailedError).attempts[0].reason;
    expect(reason).not.toContain(FAKE_GEMINI);
    expect(reason).toContain("[redacted]");
    expect(reason).toContain("HTTP 400");
  });

  it("ordinary provider errors are unchanged apart from scrubbing (no echo -> identical text)", async () => {
    mockCreate.mockRejectedValue(
      sdkError("429 You have no credits remaining.", 429, "credit_balance_exhausted")
    );
    const keys: ProviderKeys = { openai: FAKE_OPENAI };
    const err = await completeWithFallback(REQ, { keys, label: "scrub-test" }).catch(
      (e: unknown) => e
    );
    const reason = (err as AllProvidersFailedError).attempts[0].reason;
    expect(reason).toContain("HTTP 429");
    expect(reason).toContain("credit_balance_exhausted");
    expect(reason).toContain("You have no credits remaining.");
  });
});
