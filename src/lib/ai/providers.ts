/**
 * providers.ts — multi-provider LLM layer for the AI Agent SaaS.
 *
 * One seam for every AI call in the product: chat engine, landing-copy
 * refinement, vision pre-read, transcription, and the first-party
 * `/api/public/ai/generate` endpoint used by sibling sites (Tools, …).
 *
 * Providers:
 *  - groq   — OpenAI-compatible API (https://api.groq.com/openai/v1),
 *             env GROQ_API_KEY. Fast + generous free tier.
 *  - gemini — Google AI REST (v1beta generateContent), env GEMINI_API_KEY.
 *             Implemented over plain fetch (no extra SDK dependency).
 *  - openai — legacy path, env OPENAI_API_KEY.
 *
 * Priority: env AI_PROVIDER_PRIORITY (comma-separated, allowlisted),
 * default "groq,gemini,openai". Groq first because it is the fastest
 * OpenAI-compatible drop-in (same tool-calling semantics as the legacy
 * OpenAI path); Gemini second as the high-quality fallback with native
 * vision + audio; OpenAI last to preserve the legacy configuration.
 *
 * Keys are resolved per site by resolveSiteKeys(): a business's own
 * dedicated keys (Firestore `settings.aiKeys`, Admin-SDK read — never
 * client-readable) win per provider; anything missing falls back to the
 * shared env keys. Keys live server-side only — never logged, never
 * returned to clients.
 */

import OpenAI, { toFile } from "openai";
import { prisma, getUnscopedPrisma } from "@/lib/prisma";
import { logger } from "../logger";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Providers the platform can call. `claude`/`ollama` are legacy setup-UI
 *  values that were never wired to a real implementation; they resolve to
 *  `auto` (the priority chain) everywhere below. */
export type AIProviderName = "openai" | "groq" | "gemini" | "claude" | "ollama";

/** Providers with a real implementation behind them. */
export type RealProvider = "openai" | "groq" | "gemini" | "openrouter";
export const REAL_PROVIDERS: readonly RealProvider[] = ["openai", "groq", "gemini", "openrouter"];

/** Resolved keys for one site. Absent/empty string = not configured. */
export interface ProviderKeys {
  openai?: string | null;
  groq?: string | null;
  gemini?: string | null;
  openrouter?: string | null;
}

export interface ProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  /** Preferred model; remapped per provider when it is not a native model id. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** OpenAI-style tool definitions (function calling). */
  tools?: unknown[];
  /** Ask the model for a strict JSON object (landing-copy refinement). */
  jsonMode?: boolean;
}

export interface ChatCompletionResult {
  provider: RealProvider;
  model: string;
  text: string;
  toolCalls?: ProviderToolCall[];
}

/** Thrown when every attempted provider failed (or a pinned provider failed). */
export class AllProvidersFailedError extends Error {
  attempts: Array<{ provider: string; reason: string }>;
  pinned?: string;
  constructor(message: string, attempts: Array<{ provider: string; reason: string }>, pinned?: string) {
    super(message);
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
    this.pinned = pinned;
  }
}

/* ------------------------------------------------------------------ */
/* Priority                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_PROVIDER_PRIORITY: RealProvider[] = ["groq", "gemini", "openai"];

export function providerEnvName(p: RealProvider): string {
  return p === "groq"
    ? "GROQ_API_KEY"
    : p === "gemini"
      ? "GEMINI_API_KEY"
      : p === "openrouter"
        ? "OPENROUTER_API_KEY"
        : "OPENAI_API_KEY";
}

/**
 * Parse AI_PROVIDER_PRIORITY (e.g. "gemini,groq,openai"). Unknown names are
 * dropped; duplicates collapsed; empty/missing → the default. Never throws.
 */
export function getProviderPriority(rawEnv?: string): RealProvider[] {
  const raw = rawEnv ?? process.env.AI_PROVIDER_PRIORITY ?? "";
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is RealProvider => (REAL_PROVIDERS as readonly string[]).includes(s));
  const deduped = [...new Set(parsed)];
  return deduped.length > 0 ? deduped : [...DEFAULT_PROVIDER_PRIORITY];
}

/** Normalize the legacy settings.aiProvider / endpoint provider hint. */
export function normalizePreferredProvider(value: unknown): RealProvider | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (REAL_PROVIDERS as readonly string[]).includes(v) ? (v as RealProvider) : null;
}

/**
 * Normalize the endpoint `provider` hint. Allowlisted: auto | groq | gemini
 * | openai. Anything else is rejected loudly (never silently mapped).
 */
export function normalizeProviderHint(value: unknown): "auto" | RealProvider {
  if (value === undefined || value === null || value === "") return "auto";
  if (typeof value !== "string") throw new Error("Invalid provider hint: must be a string");
  const v = value.trim().toLowerCase();
  if (v === "auto") return "auto";
  const p = normalizePreferredProvider(v);
  if (!p) throw new Error(`Invalid provider hint "${value}" — allowed: auto, groq, gemini, openai, openrouter`);
  return p;
}

/* ------------------------------------------------------------------ */
/* Key resolution — per-site first, shared env fallback                */
/* ------------------------------------------------------------------ */

function envKey(p: RealProvider): string | null {
  const v = process.env[providerEnvName(p)];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function cleanKey(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

interface SettingsLike {
  aiKeys?: unknown;
  aiApiKey?: unknown;
  aiProvider?: unknown;
}

function readSiteKeys(doc: SettingsLike | null | undefined): ProviderKeys {
  const out: ProviderKeys = {};
  if (!doc || typeof doc !== "object") return out;
  const raw = doc.aiKeys;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    out.groq = cleanKey(r.groq);
    out.gemini = cleanKey(r.gemini);
    out.openai = cleanKey(r.openai);
    out.openrouter = cleanKey(r.openrouter);
  }
  return out;
}

/**
 * Resolve the AI keys for one site.
 *
 * 1. The site's own dedicated keys from Firestore `settings.aiKeys`
 *    ({ groq?, gemini?, openai? }) — read with the Admin SDK, server-only.
 *    `businessId` given → that business; omitted → the current tenant's
 *    settings doc (same doc getAIConfig() reads).
 * 2. Per provider, anything missing falls back to the shared env key
 *    (GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY).
 * 3. Legacy single-key setups keep working: settings.aiApiKey is merged in
 *    under settings.aiProvider when it names a real provider.
 *
 * Never throws on Firestore errors (falls back to env keys) and never
 * logs key material.
 */
export async function resolveSiteKeys(businessId?: string | null): Promise<ProviderKeys> {
  const keys: ProviderKeys = {
    groq: envKey("groq"),
    gemini: envKey("gemini"),
    openai: envKey("openai"),
    openrouter: envKey("openrouter"),
  };

  let doc: SettingsLike | null = null;
  try {
    if (businessId) {
      doc = (await getUnscopedPrisma().settings.findFirst({
        where: { businessId },
      })) as unknown as SettingsLike | null;
    } else {
      doc = (await prisma.settings.findFirst()) as unknown as SettingsLike | null;
    }
  } catch (err) {
    logger.warn("[providers] settings read failed; using env keys only", {
      reason: err instanceof Error ? err.message : String(err),
    });
    doc = null;
  }

  // Per-site dedicated keys win over the shared env keys, per provider.
  const site = readSiteKeys(doc);
  for (const p of REAL_PROVIDERS) {
    if (site[p]) keys[p] = site[p];
  }

  // Legacy: one dashboard-entered key for the configured provider.
  if (doc) {
    const legacyKey = cleanKey(doc.aiApiKey);
    const legacyProvider = normalizePreferredProvider(doc.aiProvider);
    if (legacyKey && legacyProvider && !keys[legacyProvider]) {
      keys[legacyProvider] = legacyKey;
    }
  }

  return keys;
}

export function hasAnyProviderKey(keys: ProviderKeys | null | undefined): boolean {
  if (!keys) return false;
  return REAL_PROVIDERS.some((p) => !!keys[p]);
}

/** Providers that actually have a key, in priority order. */
export function keyedProviders(keys: ProviderKeys, priority?: RealProvider[]): RealProvider[] {
  const order = priority ?? getProviderPriority();
  return order.filter((p) => !!keys[p]);
}

/**
 * Client-safe provider status: booleans only. Key material never leaves
 * the server — use this (or maskSettingsSecrets) for anything the browser
 * can see.
 */
export function publicProviderStatus(keys: ProviderKeys): {
  providers: Record<RealProvider, boolean>;
  priority: RealProvider[];
} {
  return {
    providers: {
      openai: !!keys.openai,
      groq: !!keys.groq,
      gemini: !!keys.gemini,
      openrouter: !!keys.openrouter,
    },
    priority: getProviderPriority(),
  };
}

/* ------------------------------------------------------------------ */
/* Model selection                                                     */
/* ------------------------------------------------------------------ */

export function defaultModelFor(p: RealProvider): string {
  switch (p) {
    case "groq":
      return "llama-3.3-70b-versatile";
    case "gemini":
      return "gemini-2.0-flash";
    case "openai":
      return "gpt-4o-mini";
    case "openrouter":
      // OpenRouter model slugs are namespaced ("vendor/model") and are
      // configurable via OPENROUTER_MODEL — never hardcode an OpenAI id.
      return process.env.OPENROUTER_MODEL?.trim() || "openai/gpt-4o-mini";
  }
}

/** A configured non-native model id must not be sent to Groq/Gemini raw —
 *  remap to the provider default so failover keeps working when the
 *  business configured e.g. "gpt-4o-mini" but only a Groq key exists. */
function modelFor(p: RealProvider, requested?: string): string {
  const r = (requested ?? "").trim();
  if (p === "groq") {
    if (r && /^(llama|meta-llama|mixtral|gemma|qwen|whisper|deepseek|moonshot)/i.test(r)) return r;
    return defaultModelFor("groq");
  }
  if (p === "gemini") {
    if (r && /^gemini-/i.test(r)) return r;
    return defaultModelFor("gemini");
  }
  if (p === "openrouter") {
    // Any namespaced OpenRouter slug the business configured is valid.
    return r || defaultModelFor("openrouter");
  }
  return r || defaultModelFor("openai");
}

function visionModelFor(p: RealProvider, requested?: string): string {
  if (p === "openrouter") {
    const r = (requested ?? "").trim();
    return r || "openai/gpt-4o-mini";
  }
  if (p === "groq") {
    const r = (requested ?? "").trim();
    if (r && /llama-?4/i.test(r)) return r;
    return "meta-llama/llama-4-scout-17b-16e-instruct";
  }
  if (p === "gemini") return modelFor("gemini", requested);
  // OpenAI: the business's own model when it can see, else a cheap default.
  const r = (requested ?? "").trim();
  if (/^(gpt-4o|gpt-4\.1|o1|o3|gpt-5)/.test(r)) return r;
  return "gpt-4o-mini";
}

/* ------------------------------------------------------------------ */
/* Single-provider completion                                          */
/* ------------------------------------------------------------------ */

const PROVIDER_TIMEOUT_MS = 30000;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function openAiClientFor(p: "openai" | "groq" | "openrouter", apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    ...(p === "groq" ? { baseURL: "https://api.groq.com/openai/v1" } : {}),
    ...(p === "openrouter"
      ? {
          baseURL: OPENROUTER_BASE_URL,
          defaultHeaders: {
            "HTTP-Referer": "https://ai.ridebangla.bd",
            "X-Title": "Ride Bangla AI Agent",
          },
        }
      : {}),
    timeout: PROVIDER_TIMEOUT_MS,
    maxRetries: 0, // failover across providers is handled here, not in-SDK
  });
}

function describeProviderError(provider: string, err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: string }).code;
    const base = err.message?.slice(0, 300) || String(err);
    return `${provider}: ${status ? `HTTP ${status} ` : ""}${code ? `[${code}] ` : ""}${base}`;
  }
  return `${provider}: ${String(err).slice(0, 300)}`;
}

/* ---------------- Gemini REST adapter ---------------- */

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
}

function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
} {
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }
  let systemText = "";
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemText += (systemText ? "\n\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") {
      const name = (m.name || toolNameById.get(m.tool_call_id ?? "") || "unknown_tool").slice(0, 64);
      const last = contents[contents.length - 1];
      const part: GeminiPart = {
        functionResponse: { name, response: { result: m.content.slice(0, 20000) } },
      };
      // Gemini requires functionResponse parts on a "user" turn.
      if (last && last.role === "user") last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        args = { _raw: tc.function.arguments.slice(0, 4000) };
      }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role && parts.every((p) => p.text !== undefined)) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
  };
}

function toGeminiTools(tools: unknown[] | undefined): Array<{ functionDeclarations: unknown[] }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const decls: unknown[] = [];
  for (const t of tools) {
    const fn = (t as { function?: { name?: string; description?: string; parameters?: unknown } })?.function;
    if (fn?.name) {
      decls.push({
        name: fn.name,
        description: (fn.description ?? "").slice(0, 1024),
        parameters: fn.parameters ?? { type: "object", properties: {} },
      });
    }
  }
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

async function geminiComplete(
  apiKey: string,
  req: ChatCompletionRequest
): Promise<ChatCompletionResult> {
  const model = modelFor("gemini", req.model);
  const { systemInstruction, contents } = toGeminiContents(req.messages);
  const body: Record<string, unknown> = {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    generationConfig: {
      ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
      ...(typeof req.maxTokens === "number" ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
    ...(toGeminiTools(req.tools) ? { tools: toGeminiTools(req.tools) } : {}),
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`gemini: request failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    const err = new Error(`gemini: HTTP ${res.status} ${snippet}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  const blocked = data.promptFeedback?.blockReason;
  if (blocked) throw new Error(`gemini: prompt blocked (${blocked})`);
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const texts: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  parts.forEach((p, i) => {
    if (typeof p.text === "string" && p.text) texts.push(p.text);
    if (p.functionCall) {
      toolCalls.push({
        id: `gemini-call-${i}-${Date.now()}`,
        type: "function",
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
      });
    }
  });
  const text = texts.join("").trim();
  // NOTE: empty text is returned (not thrown) so callers keep the legacy
  // "could not generate a response" behavior instead of triggering failover.
  return { provider: "gemini", model, text, ...(toolCalls.length ? { toolCalls } : {}) };
}

/**
 * One chat completion against ONE provider. Throws on any failure
 * (transport, auth, rate limit, timeout) — the caller decides failover.
 * Empty text is returned as-is (legacy "could not generate a response"
 * behavior). Never logs or returns key material.
 */
export async function completeWithProvider(
  provider: RealProvider,
  keys: ProviderKeys,
  req: ChatCompletionRequest
): Promise<ChatCompletionResult> {
  const apiKey = keys[provider];
  if (!apiKey) throw new Error(`${provider}: no API key configured`);

  if (provider === "gemini") {
    return geminiComplete(apiKey, req);
  }

  const client = openAiClientFor(provider, apiKey);
  const model = modelFor(provider, req.model);
  let response;
  try {
    response = await client.chat.completions.create({
      model,
      messages: req.messages.map((m) => {
        const base: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) base.tool_calls = m.tool_calls;
        if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
        if (m.name) base.name = m.name;
        return base;
      }) as unknown as OpenAI.ChatCompletionMessageParam[],
      ...(req.tools && req.tools.length
        ? { tools: req.tools as OpenAI.ChatCompletionTool[] }
        : {}),
      ...(typeof req.maxTokens === "number" ? { max_tokens: req.maxTokens } : {}),
      ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
      ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
  } catch (err) {
    throw new Error(describeProviderError(provider, err));
  }

  const choice = response.choices[0];
  const msg = choice?.message;
  const toolCalls: ProviderToolCall[] | undefined = msg?.tool_calls?.map((tc, i) => ({
    id: tc.id || `${provider}-call-${i}-${Date.now()}`,
    type: "function" as const,
    function: {
      name: (tc as { function?: { name?: string } }).function?.name ?? "unknown",
      arguments: (tc as { function?: { arguments?: string } }).function?.arguments ?? "{}",
    },
  }));
  const text = (msg?.content ?? "").trim();
  // NOTE: empty text is returned (not thrown) so callers keep the legacy
  // "could not generate a response" behavior instead of triggering failover.
  return { provider, model, text, ...(toolCalls?.length ? { toolCalls } : {}) };
}

/* ------------------------------------------------------------------ */
/* Fallback orchestration                                              */
/* ------------------------------------------------------------------ */

export interface FallbackOptions {
  /** Resolved via resolveSiteKeys() when omitted. */
  keys?: ProviderKeys;
  /** "auto" (default) = priority chain with failover; a concrete provider = pinned attempt. */
  providerHint?: string | null;
  /** Chat-engine preference (settings.aiProvider): tried first in auto mode. */
  preferredProvider?: RealProvider | null;
  /** Log label, e.g. "chat", "landing-refine", "public-ai". No keys logged. */
  label?: string;
}

/**
 * Run one chat completion with provider failover.
 *
 * - `providerHint: "auto"` (default): try the keyed providers in priority
 *   order (preferredProvider first); skip providers without keys; fail over
 *   on error / rate limit / timeout to the next.
 * - `providerHint: "groq"|"gemini"|"openai"`: attempt ONLY that provider.
 *   Failure throws AllProvidersFailedError — no silent switch, because the
 *   caller explicitly pinned the provider.
 *
 * Returns null when NO provider key resolves at all — every caller must
 * degrade honestly (never fake output) in that case.
 */
export async function completeWithFallback(
  req: ChatCompletionRequest,
  opts: FallbackOptions = {}
): Promise<ChatCompletionResult | null> {
  const label = opts.label ?? "ai";
  const keys = opts.keys ?? (await resolveSiteKeys());
  const hint = normalizeProviderHint(opts.providerHint ?? "auto");

  if (hint !== "auto") {
    if (!keys[hint]) {
      throw new AllProvidersFailedError(
        `Provider "${hint}" was requested but no API key is configured for it (env ${providerEnvName(hint)} or the site's own key).`,
        [{ provider: hint, reason: "no-key" }],
        hint
      );
    }
    try {
      return await completeWithProvider(hint, keys, req);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[providers:${label}] pinned provider failed`, { provider: hint, reason });
      throw new AllProvidersFailedError(
        `Provider "${hint}" failed: ${reason}`,
        [{ provider: hint, reason }],
        hint
      );
    }
  }

  let order = keyedProviders(keys);
  if (opts.preferredProvider && keys[opts.preferredProvider]) {
    order = [opts.preferredProvider, ...order.filter((p) => p !== opts.preferredProvider)];
  }
  if (order.length === 0) return null; // honest-degraded path

  const failures: Array<{ provider: string; reason: string }> = [];
  for (const provider of order) {
    try {
      const result = await completeWithProvider(provider, keys, req);
      if (provider !== order[0]) {
        logger.info(`[providers:${label}] failover succeeded`, { provider });
      }
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[providers:${label}] provider failed, failing over`, { provider, reason });
      failures.push({ provider, reason });
    }
  }
  throw new AllProvidersFailedError(
    `All configured AI providers failed (${failures.map((f) => f.provider).join(", ")}).`,
    failures
  );
}

/** Plain-text completion with failover (no tools) — for synthesis helpers. */
export async function completeTextWithFallback(
  keys: ProviderKeys,
  prompt: string,
  opts: { maxTokens?: number; temperature?: number; label?: string; model?: string } = {}
): Promise<ChatCompletionResult | null> {
  return completeWithFallback(
    {
      messages: [{ role: "user", content: prompt }],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      model: opts.model,
    },
    { keys, label: opts.label ?? "text" }
  );
}

/* ------------------------------------------------------------------ */
/* Vision + transcription with failover                                */
/* ------------------------------------------------------------------ */

export interface MediaCallInput {
  bytes: Buffer;
  mimeType: string;
}

function dataUri(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function describeImageOneProvider(
  provider: RealProvider,
  apiKey: string,
  input: MediaCallInput,
  question: string,
  modelHint?: string
): Promise<string> {
  if (provider === "gemini") {
    const model = modelFor("gemini", modelHint);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: question },
              { inlineData: { mimeType: input.mimeType, data: input.bytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`gemini: HTTP ${res.status} ${snippet}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("gemini: vision returned no description");
    return text;
  }

  const client = openAiClientFor(provider, apiKey);
  const response = await client.chat.completions.create({
    model: visionModelFor(provider, modelHint),
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: dataUri(input.bytes, input.mimeType) } },
        ],
      },
    ],
  }).catch((err: unknown) => {
    throw new Error(describeProviderError(provider, err));
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error(`${provider}: vision returned no description`);
  return text;
}

/**
 * Describe one image with provider failover. Returns null when no provider
 * key resolves; throws AllProvidersFailedError when all fail.
 */
export async function describeImageWithFallback(
  keys: ProviderKeys,
  input: MediaCallInput,
  question: string,
  opts: { model?: string; label?: string } = {}
): Promise<ChatCompletionResult | null> {
  const order = keyedProviders(keys);
  if (order.length === 0) return null;
  const failures: Array<{ provider: string; reason: string }> = [];
  for (const provider of order) {
    try {
      const text = await describeImageOneProvider(provider, keys[provider]!, input, question, opts.model);
      return { provider, model: visionModelFor(provider, opts.model), text };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[providers:${opts.label ?? "vision"}] provider failed, failing over`, { provider, reason });
      failures.push({ provider, reason });
    }
  }
  throw new AllProvidersFailedError(
    `All configured AI providers failed at vision (${failures.map((f) => f.provider).join(", ")}).`,
    failures
  );
}

function audioExt(mimeType: string): string {
  if (mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("webm")) return "webm";
  return "ogg";
}

async function transcribeOneProvider(
  provider: RealProvider,
  apiKey: string,
  input: MediaCallInput
): Promise<string> {
  if (provider === "gemini") {
    // Gemini transcribes audio natively via a transcription prompt.
    const model = modelFor("gemini");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Transcribe this audio exactly, word for word. Return only the transcript, no commentary." },
              { inlineData: { mimeType: input.mimeType, data: input.bytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 2000, temperature: 0 },
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`gemini: HTTP ${res.status} ${snippet}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("gemini: transcription came back empty");
    return text;
  }

  // OpenAI Whisper + Groq's OpenAI-compatible Whisper endpoint.
  const client = openAiClientFor(provider, apiKey);
  const file = await toFile(input.bytes, `voice-${Date.now()}.${audioExt(input.mimeType)}`, {
    type: input.mimeType,
  });
  const result = await client.audio.transcriptions
    .create({ file, model: provider === "groq" ? "whisper-large-v3" : "whisper-1" })
    .catch((err: unknown) => {
      throw new Error(describeProviderError(provider, err));
    });
  const text = (result.text ?? "").trim();
  if (!text) throw new Error(`${provider}: transcription came back empty`);
  return text;
}

/**
 * Transcribe audio with provider failover. Returns null when no provider
 * key resolves; throws AllProvidersFailedError when all fail.
 */
export async function transcribeAudioWithFallback(
  keys: ProviderKeys,
  input: MediaCallInput,
  opts: { label?: string } = {}
): Promise<string | null> {
  const order = keyedProviders(keys);
  if (order.length === 0) return null;
  const failures: Array<{ provider: string; reason: string }> = [];
  for (const provider of order) {
    try {
      return await transcribeOneProvider(provider, keys[provider]!, input);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[providers:${opts.label ?? "transcribe"}] provider failed, failing over`, { provider, reason });
      failures.push({ provider, reason });
    }
  }
  throw new AllProvidersFailedError(
    `All configured AI providers failed at transcription (${failures.map((f) => f.provider).join(", ")}).`,
    failures
  );
}
