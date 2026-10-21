/**
 * ai-provider-latency.test.ts — timed harness for the agent-reply
 * latency fix (2026-10-22). All providers are mocked with artificial
 * delays, so timings measure the STRUCTURE of the reply path (attempt
 * order, circuit breaker, streaming), never a real network.
 *
 * Scenarios (mirrors the before/after measurements in
 * final-verification/agent-reply-latency.md):
 *  (i)   healthy provider — non-stream total + streaming time-to-first-token
 *  (ii)  dead first provider (credit-exhausted) — the tax is paid ONCE,
 *        then the breaker skips the dead provider instantly
 *  (iii) all providers down — credential-class: the fallback path is
 *        fast from the second call; transient-class: three strikes,
 *        then fast
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  __resetProviderBreakers,
  classifyProviderError,
  completeWithFallback,
  streamWithFallback,
  type ProviderKeys,
} from "@/lib/ai/providers";

const KEYS: ProviderKeys = {
  openai: "sk-dead-openai-key",
  groq: "gsk-live-groq-key",
  gemini: "AIza-live-gemini-key",
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lastKey(): string {
  const c = constructedClients[constructedClients.length - 1];
  return String(c?.opts?.apiKey ?? "");
}

function attemptsFor(key: string): number {
  return constructedClients.filter((c) => c.opts?.apiKey === key).length;
}

function okPayload(text: string) {
  return { choices: [{ message: { content: text } }] };
}

async function* chunkStream(
  pieces: Array<{ content?: string; toolCall?: { name: string; arguments: string } }>,
  stepMs: number,
  failAtEnd = false
) {
  for (const p of pieces) {
    await delay(stepMs);
    if (p.toolCall) {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: { name: p.toolCall.name, arguments: p.toolCall.arguments },
                },
              ],
            },
          },
        ],
      };
    } else {
      yield { choices: [{ delta: { content: p.content ?? "" } }] };
    }
  }
  if (failAtEnd) throw new Error("stream broke mid-flight");
}

function creditError() {
  return Object.assign(new Error("429 credit_balance_exhausted"), {
    status: 429,
    code: "credit_balance_exhausted",
  });
}

beforeEach(() => {
  mockCreate.mockReset();
  constructedClients.length = 0;
  vi.unstubAllGlobals();
  __resetProviderBreakers();
});

describe("classifyProviderError", () => {
  it("sorts failures into credential / rate / transient", () => {
    expect(classifyProviderError(Object.assign(new Error("nope"), { status: 401 }))).toBe("credential");
    expect(classifyProviderError(Object.assign(new Error("nope"), { status: 403 }))).toBe("credential");
    expect(classifyProviderError(creditError())).toBe("credential");
    expect(
      classifyProviderError(Object.assign(new Error("Rate limit"), { status: 429 }))
    ).toBe("rate");
    expect(classifyProviderError(new Error("boom-500"))).toBe("transient");
  });
});

describe("latency structure — after", () => {
  it("(i) healthy provider: streaming TTFT beats total time", async () => {
    mockCreate.mockImplementation(async () =>
      chunkStream([{ content: "Hel" }, { content: "lo " }, { content: "world" }], 100)
    );
    const tokens: string[] = [];
    let ttft = -1;
    const t0 = performance.now();
    const res = await streamWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      {
        keys: { groq: KEYS.groq },
        label: "bench",
        stream: {
          onToken: (t) => {
            if (ttft < 0) ttft = performance.now() - t0;
            tokens.push(t);
          },
        },
      }
    );
    const total = performance.now() - t0;
    console.log(`AFTER (i) streaming ttft: ${ttft.toFixed(0)}ms total: ${total.toFixed(0)}ms`);
    expect(res?.text).toBe("Hello world");
    expect(tokens.join("")).toBe("Hello world");
    expect(ttft).toBeGreaterThanOrEqual(90);
    expect(ttft).toBeLessThan(total);
    expect(total).toBeGreaterThanOrEqual(290);
  });

  it("(ii) dead first provider: tax paid once, then the breaker skips it", async () => {
    mockCreate.mockImplementation(async () => {
      if (lastKey() === KEYS.openai) {
        await delay(800);
        throw creditError();
      }
      await delay(300);
      return okPayload("from groq");
    });
    const times: number[] = [];
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      const res = await completeWithFallback(
        { messages: [{ role: "user", content: "hi" }] },
        { keys: KEYS, preferredProvider: "openai", label: "bench" }
      );
      times.push(performance.now() - t0);
      expect(res?.text).toBe("from groq");
    }
    console.log(`AFTER (ii) dead-first call1: ${times[0].toFixed(0)}ms call2: ${times[1].toFixed(0)}ms`);
    expect(times[0]).toBeGreaterThanOrEqual(1000); // 800 dead + 300 live
    expect(times[1]).toBeLessThan(600); // breaker open: straight to groq
    expect(attemptsFor(KEYS.openai!)).toBe(1); // dead provider attempted ONCE
  });

  it("(iii-a) all down (credential class): fallback is fast from call 2", async () => {
    mockCreate.mockImplementation(async () => {
      await delay(300);
      throw Object.assign(new Error("401 invalid api key"), { status: 401 });
    });
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls++;
        await delay(300);
        return { ok: false, status: 403, text: async () => "forbidden" };
      })
    );
    const t0 = performance.now();
    await expect(
      completeWithFallback(
        { messages: [{ role: "user", content: "hi" }] },
        { keys: KEYS, label: "bench" }
      )
    ).rejects.toThrow(/All configured AI providers failed/);
    const call1 = performance.now() - t0;
    const createsAfterCall1 = mockCreate.mock.calls.length;
    const fetchAfterCall1 = fetchCalls;

    const t1 = performance.now();
    await expect(
      completeWithFallback(
        { messages: [{ role: "user", content: "hi" }] },
        { keys: KEYS, label: "bench" }
      )
    ).rejects.toThrow(/All configured AI providers failed/);
    const call2 = performance.now() - t1;
    console.log(`AFTER (iii-a) all-down call1: ${call1.toFixed(0)}ms call2: ${call2.toFixed(0)}ms`);
    expect(call1).toBeGreaterThanOrEqual(850);
    expect(call2).toBeLessThan(150); // every circuit open: instant fast-fail
    expect(mockCreate.mock.calls.length).toBe(createsAfterCall1); // zero new attempts
    expect(fetchCalls).toBe(fetchAfterCall1);
  });

  it("(iii-b) all down (transient class): three strikes, then fast", async () => {
    mockCreate.mockImplementation(async () => {
      await delay(300);
      throw new Error("boom-500");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await delay(300);
        return { ok: false, status: 500, text: async () => "gemini down" };
      })
    );
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now();
      await expect(
        completeWithFallback(
          { messages: [{ role: "user", content: "hi" }] },
          { keys: KEYS, label: "bench" }
        )
      ).rejects.toThrow(/All configured AI providers failed/);
      times.push(performance.now() - t0);
    }
    console.log(
      `AFTER (iii-b) transient all-down calls: ${times.map((t) => t.toFixed(0)).join("/")}ms`
    );
    expect(times[0]).toBeGreaterThanOrEqual(850);
    expect(times[3]).toBeLessThan(150); // all circuits open after 3 strikes
  });

  it("streaming: tool-call preamble retracts forwarded tokens", async () => {
    mockCreate.mockImplementation(async () =>
      chunkStream(
        [
          { content: "Let me check " },
          { toolCall: { name: "get_customer_history", arguments: "{}" } },
        ],
        20
      )
    );
    const tokens: string[] = [];
    let retracts = 0;
    const res = await streamWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      {
        keys: { groq: KEYS.groq },
        label: "bench",
        stream: {
          onToken: (t) => tokens.push(t),
          onRetract: () => retracts++,
        },
      }
    );
    expect(tokens.join("")).toBe("Let me check ");
    expect(retracts).toBe(1);
    expect(res?.toolCalls?.[0]?.function.name).toBe("get_customer_history");
  });

  it("streaming: a mid-stream failure after tokens never fails over", async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls++;
        return { ok: true, json: async () => ({ candidates: [] }) };
      })
    );
    mockCreate.mockImplementation(async () =>
      chunkStream([{ content: "partial " }], 20, true)
    );
    const tokens: string[] = [];
    await expect(
      streamWithFallback(
        { messages: [{ role: "user", content: "hi" }] },
        {
          keys: { groq: KEYS.groq, gemini: KEYS.gemini },
          label: "bench",
          stream: { onToken: (t) => tokens.push(t) },
        }
      )
    ).rejects.toThrow(/All configured AI providers failed|mid-stream/);
    expect(tokens.join("")).toBe("partial ");
    expect(fetchCalls).toBe(0); // gemini was never tried after tokens escaped
  });

  it("streaming: gemini SSE tokens stream with an early first token", async () => {
    const sse = (text: string) =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(sse("Gem")));
            await delay(120);
            controller.enqueue(enc.encode(sse("ini reply")));
            controller.close();
          },
        });
        return { ok: true, body: stream };
      })
    );
    const tokens: string[] = [];
    let ttft = -1;
    const t0 = performance.now();
    const res = await streamWithFallback(
      { messages: [{ role: "user", content: "hi" }] },
      {
        keys: { gemini: KEYS.gemini },
        label: "bench",
        stream: {
          onToken: (t) => {
            if (ttft < 0) ttft = performance.now() - t0;
            tokens.push(t);
          },
        },
      }
    );
    const total = performance.now() - t0;
    console.log(`AFTER gemini streaming ttft: ${ttft.toFixed(0)}ms total: ${total.toFixed(0)}ms`);
    expect(res?.text).toBe("Gemini reply");
    expect(tokens.join("")).toBe("Gemini reply");
    expect(ttft).toBeLessThan(120);
    expect(total).toBeGreaterThanOrEqual(110);
  });
});
