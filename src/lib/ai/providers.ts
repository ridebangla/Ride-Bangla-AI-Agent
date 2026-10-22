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
 *
 * Latency structure (2026-10-22): a per-instance circuit breaker stops
 * every message from re-paying a dead provider's failed attempt (see
 * the breaker section below), chat completions run under a chat-sized
 * time budget instead of the 30s media budget, and streamWithFallback()
 * streams tokens to the widget so a reply starts rendering as it is
 * generated. Reply texts and prompts are untouched by all of this.
 */

import OpenAI, { toFile } from "openai";
import { createHash } from "node:crypto";
import { prisma, getUnscopedPrisma, getBusinessId } from "@/lib/prisma";
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
 * 0. Internal (company) businesses resolve the platform env keys ONLY
 *    (B7 — see the early return in the function body).
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
/**
 * B7 (owner standard 2026-10-22): is this resolve for an internal
 * (company) business? Identity is the SERVER-side business record
 * behind the explicit businessId argument — or, for the tenant-context
 * callers (the chat engine), the ambient tenant business id. Never a
 * client-supplied value. Strict boolean true only; any read error
 * degrades to "not internal" (the ordinary resolution below), never
 * to internal.
 */
async function isInternalBusinessForKeys(
  businessId?: string | null
): Promise<boolean> {
  try {
    let id: string | null = businessId ?? null;
    if (!id) {
      const ambient = getBusinessId();
      id = typeof ambient === "string" && ambient ? ambient : null;
    }
    if (!id) return false;
    const biz = (await getUnscopedPrisma().business.findUnique({
      where: { id },
      select: { isInternalAccount: true },
    })) as unknown as { isInternalAccount?: unknown } | null;
    return biz?.isInternalAccount === true;
  } catch {
    return false;
  }
}

export async function resolveSiteKeys(businessId?: string | null): Promise<ProviderKeys> {
  const keys: ProviderKeys = {
    groq: envKey("groq"),
    gemini: envKey("gemini"),
    openai: envKey("openai"),
    openrouter: envKey("openrouter"),
  };

  // B7: an internal (company) business is OUTSIDE the key machinery —
  // it resolves the PLATFORM (env) keys only. A per-business key is
  // never REQUIRED for it (a missing tenant key can no longer produce
  // aiConfigured:false while platform keys exist), and a per-business
  // key present on its settings doc does not override the platform
  // keys: the company runs on the platform's own keys, full stop
  // (audit B7 wording: "platform-key-only path").
  if (await isInternalBusinessForKeys(businessId)) {
    return keys;
  }

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
/* Circuit breaker — stop paying the dead-provider tax                 */
/* ------------------------------------------------------------------ */

/**
 * When a provider fails with an auth/credit-class error it stays broken
 * for minutes-to-forever, yet the fallback chain used to pay that failed
 * attempt on EVERY message — the production case was a credit-exhausted
 * platform OpenAI key sitting first in the chain (settings.aiProvider
 * default), so every reply waited on its rejection before failover, and
 * the all-down fallback took the full chain every time too.
 *
 * This breaker remembers recent failures per (provider, key
 * fingerprint) inside the server instance: once a class-specific count
 * of CONSECUTIVE failures is reached, the provider is skipped instantly
 * until its cooldown passes (doubling per re-trip, capped), so working
 * providers lead the chain meanwhile. A success clears the record.
 * In-memory per instance on purpose: a fresh instance re-probes, and a
 * provider that recovers is picked back up after one cooldown.
 *
 * Thresholds are deliberately conservative for the non-credential
 * classes: a single transient blip must never sideline a provider.
 *   credential (401/403, credit/quota-exhausted, invalid key): 1
 *   rate       (plain 429 / rate-limit text):                  2
 *   transient  (5xx, timeout, network, anything else):         3
 */
export type ProviderErrorClass = "credential" | "rate" | "transient";

const CREDENTIAL_MARKERS =
  /credit_balance|insufficient_quota|insufficient[ _-]?funds|billing|payment required|invalid api key|invalid_api_key|api key not valid/i;

export function classifyProviderError(err: unknown): ProviderErrorClass {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (status === 401 || status === 403) return "credential";
  if (CREDENTIAL_MARKERS.test(message)) return "credential";
  if (status === 429 || /rate limit|too many requests/i.test(message)) return "rate";
  return "transient";
}

const BREAKER_THRESHOLDS: Record<ProviderErrorClass, number> = {
  credential: 1,
  rate: 2,
  transient: 3,
};

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function breakerBaseCooldownMs(cls: ProviderErrorClass): number {
  switch (cls) {
    case "credential":
      return envMs("AI_CB_CREDENTIAL_COOLDOWN_MS", 60_000);
    case "rate":
      return envMs("AI_CB_RATE_COOLDOWN_MS", 20_000);
    default:
      return envMs("AI_CB_TRANSIENT_COOLDOWN_MS", 30_000);
  }
}

interface BreakerEntry {
  cls: ProviderErrorClass;
  failures: number;
  trips: number;
  openUntil: number;
}

const providerBreakers = new Map<string, BreakerEntry>();

function breakerId(provider: RealProvider, apiKey: string): string {
  // Fingerprint, never the key itself — state ids must stay log-safe and
  // a key rotation (or a per-business key) gets its own fresh record.
  return `${provider}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`;
}

function providerCircuitOpen(provider: RealProvider, apiKey: string): boolean {
  const entry = providerBreakers.get(breakerId(provider, apiKey));
  return !!entry && entry.openUntil > Date.now();
}

function recordProviderSuccess(provider: RealProvider, apiKey: string): void {
  providerBreakers.delete(breakerId(provider, apiKey));
}

function recordProviderFailure(provider: RealProvider, apiKey: string, err: unknown): void {
  const cls = classifyProviderError(err);
  const id = breakerId(provider, apiKey);
  const now = Date.now();
  const prev = providerBreakers.get(id);
  const entry: BreakerEntry =
    prev && prev.cls === cls && prev.openUntil <= now
      ? prev
      : { cls, failures: 0, trips: prev?.trips ?? 0, openUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= BREAKER_THRESHOLDS[cls]) {
    entry.trips += 1;
    const backoff = breakerBaseCooldownMs(cls) * 2 ** Math.min(entry.trips - 1, 4);
    entry.openUntil = now + Math.min(backoff, envMs("AI_CB_MAX_COOLDOWN_MS", 600_000));
    entry.failures = 0;
  }
  providerBreakers.set(id, entry);
}

/** Test-only: clear all circuit-breaker state between cases. */
export function __resetProviderBreakers(): void {
  providerBreakers.clear();
}

/* ------------------------------------------------------------------ */
/* Model selection                                                     */
/* ------------------------------------------------------------------ */

export function defaultModelFor(p: RealProvider): string {
  switch (p) {
    case "groq":
      // "llama-3.3-70b-versatile" was retired by Groq — live probes on
      // 2026-10-21 returned HTTP 404 model_not_found for it, while
      // "openai/gpt-oss-120b" answered HTTP 200 (Tools proxy evidence).
      return "openai/gpt-oss-120b";
    case "gemini":
      // "gemini-2.0-flash" was retired by Google — its own error message
      // (live probe, 2026-10-21) names gemini-3.8-flash as the update.
      return "gemini-3.8-flash";
    case "openai":
      return "gpt-4o-mini";
    case "openrouter":
      // OpenRouter model slugs are namespaced ("vendor/model") and are
      // configurable via OPENROUTER_MODEL — never hardcode an OpenAI id.
      return process.env.OPENROUTER_MODEL?.trim() || "openai/gpt-4o-mini";
  }
}

/** Groq catalogue order for model_not_found fallover in
 *  completeWithProvider — the same list the Tools proxy runs live
 *  (HTTP 200s on 2026-10-21). Fallover happens ONLY when Groq answers
 *  404 model_not_found; auth/quota/timeout errors surface immediately. */
export const GROQ_MODEL_CHAIN: string[] = [
  "openai/gpt-oss-120b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.1-8b-instant",
];

/** Model ids proven retired by live 404 model_not_found probes on
 *  2026-10-21. A business may still have one stored as its configured
 *  model (the old setup wizard offered both) — never send it raw;
 *  remap to the provider's current default instead. */
const RETIRED_MODEL_IDS: Record<string, RealProvider> = {
  "llama-3.3-70b-versatile": "groq",
  "gemini-2.0-flash": "gemini",
};

/** A configured non-native model id must not be sent to Groq/Gemini raw —
 *  remap to the provider default so failover keeps working when the
 *  business configured e.g. "gpt-4o-mini" but only a Groq key exists. */
function modelFor(p: RealProvider, requested?: string): string {
  const r = (requested ?? "").trim();
  if (r && RETIRED_MODEL_IDS[r] === p) return defaultModelFor(p);
  if (p === "groq") {
    if (r && /^(llama|meta-llama|mixtral|gemma|qwen|whisper|deepseek|moonshot|openai\/)/i.test(r)) return r;
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

/**
 * Groq vision catalogue order for describeImageOneProvider (media fix
 * 2026-10-22). Groq's current vision documentation
 * (console.groq.com/docs/vision, checked 2026-10-22) lists
 * `qwen/qwen3.8-27b` as the generally available multimodal model — the
 * Llama 4 ids that used to be the documented vision models no longer
 * appear there, which is why the single hardcoded Scout id left every
 * photo unanswered once Groq stopped serving it for vision. The chain
 * keeps the Llama 4 ids as fallovers: fallover happens ONLY on a
 * model-unavailable error (see isModelUnavailableError), so whichever
 * of these Groq actually serves answers the photo, and auth/quota/
 * timeout errors still surface immediately, exactly like the chat
 * chain's GROQ_MODEL_CHAIN discipline.
 */
export const GROQ_VISION_MODEL_CHAIN: string[] = [
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];

function visionModelFor(p: RealProvider, requested?: string): string {
  if (p === "openrouter") {
    const r = (requested ?? "").trim();
    return r || "openai/gpt-4o-mini";
  }
  if (p === "groq") {
    const r = (requested ?? "").trim();
    if (r && GROQ_VISION_MODEL_CHAIN.includes(r)) return r;
    return GROQ_VISION_MODEL_CHAIN[0];
  }
  if (p === "gemini") return modelFor("gemini", requested);
  // OpenAI: the business's own model when it can see, else a cheap default.
  const r = (requested ?? "").trim();
  if (/^(gpt-4o|gpt-4\.1|o1|o3|gpt-5)/.test(r)) return r;
  return "gpt-4o-mini";
}

/** Vision model candidates for one provider, most-preferred first.
 *  A business-configured vision-capable id (e.g. a Llama 4 id for Groq)
 *  leads; the documented catalogue follows. Non-Groq providers have a
 *  single candidate — their visionModelFor result. */
function visionModelCandidates(p: RealProvider, requested?: string): string[] {
  if (p !== "groq") return [visionModelFor(p, requested)];
  const primary = visionModelFor("groq", requested);
  return [primary, ...GROQ_VISION_MODEL_CHAIN.filter((m) => m !== primary)];
}

/* ------------------------------------------------------------------ */
/* Single-provider completion                                          */
/* ------------------------------------------------------------------ */

const PROVIDER_TIMEOUT_MS = 30000;

/** Chat completions get a chat-sized budget, not the 30s media budget:
 *  a wedged provider must fail over in seconds, not half a minute.
 *  Vision/transcription keep PROVIDER_TIMEOUT_MS (media is slower). */
function chatTimeoutMs(): number {
  return envMs("AI_CHAT_TIMEOUT_MS", 15_000);
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function openAiClientFor(
  p: "openai" | "groq" | "openrouter",
  apiKey: string,
  timeoutMs: number = PROVIDER_TIMEOUT_MS
): OpenAI {
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
    timeout: timeoutMs,
    maxRetries: 0, // failover across providers is handled here, not in-SDK
  });
}

/**
 * Defense-in-depth (attack-test 2026-10-21): provider/proxy error bodies are
 * untrusted text — a gateway that echoes the presented credential would
 * otherwise carry the key into logs, stored chat messages, and API error
 * responses. Strip the exact key value from any error text before it
 * leaves a provider call.
 */
export function scrubKeyMaterial(text: string, apiKey?: string | null): string {
  if (!apiKey || apiKey.length < 8) return text;
  return text.split(apiKey).join("[redacted]");
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

/** The OpenAI-family create() params for one completion — shared by the
 *  blocking and streaming paths so the two can never drift apart. */
function openAiCreateParams(
  req: ChatCompletionRequest,
  model: string
): Record<string, unknown> {
  return {
    model,
    messages: req.messages.map((m) => {
      const base: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) base.tool_calls = m.tool_calls;
      if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
      if (m.name) base.name = m.name;
      return base;
    }),
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    ...(typeof req.maxTokens === "number" ? { max_tokens: req.maxTokens } : {}),
    ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
    ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };
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

function geminiRequestBody(req: ChatCompletionRequest): Record<string, unknown> {
  const { systemInstruction, contents } = toGeminiContents(req.messages);
  return {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    generationConfig: {
      ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
      ...(typeof req.maxTokens === "number" ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
    ...(toGeminiTools(req.tools) ? { tools: toGeminiTools(req.tools) } : {}),
  };
}

async function geminiComplete(
  apiKey: string,
  req: ChatCompletionRequest,
  timeoutMs: number = PROVIDER_TIMEOUT_MS
): Promise<ChatCompletionResult> {
  const model = modelFor("gemini", req.model);
  const body = geminiRequestBody(req);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(
      scrubKeyMaterial(`gemini: request failed (${err instanceof Error ? err.message : String(err)})`, apiKey)
    );
  }
  if (!res.ok) {
    const snippet = scrubKeyMaterial((await res.text().catch(() => "")).slice(0, 300), apiKey);
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

/** True only for a provider's "this model id does not exist" failure —
 *  the one case where trying the next catalogue id can help. Matches the
 *  OpenAI SDK error shape (status 404 + code "model_not_found") and the
 *  raw message text as a belt-and-braces fallback. */
function isModelNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "model_not_found") return true;
  const status = (err as { status?: number }).status;
  return status === 404 && /model_not_found|does not exist/i.test(err.message ?? "");
}

/** Wider than isModelNotFoundError, for the MEDIA paths: a provider can
 *  also refuse a model with a 400 ("model does not support image
 *  input", "model has been decommissioned") when an id still exists
 *  for text but not for the media capability. Trying the next media
 *  catalogue id is safe in exactly those cases — and ONLY those: any
 *  other failure (auth, quota, rate limit, timeout) must surface at
 *  once so the provider failover / breaker semantics stay honest. */
function isModelUnavailableError(err: unknown): boolean {
  if (isModelNotFoundError(err)) return true;
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number }).status;
  const msg = err.message ?? "";
  if (/model[_\s-]?(not[_\s-]?found|unavailable|decommissioned|retired)|model.*does not exist|model.*not supported|does not support (image|vision|audio)/i.test(msg)) {
    return true;
  }
  return status === 400 && /model/i.test(msg) && /not|unsupported|invalid|unavailable/i.test(msg);
}

/**
 * One chat completion against ONE provider. Throws on any failure
 * (transport, auth, rate limit, timeout) — the caller decides failover.
 * Empty text is returned as-is (legacy "could not generate a response"
 * behavior). Never logs or returns key material.
 *
 * Deliberately breaker-free: circuit-breaker recording/skipping lives in
 * the fallback wrappers, so a caller that explicitly names a provider
 * here always gets a real attempt.
 */
export async function completeWithProvider(
  provider: RealProvider,
  keys: ProviderKeys,
  req: ChatCompletionRequest,
  opts: { timeoutMs?: number } = {}
): Promise<ChatCompletionResult> {
  const apiKey = keys[provider];
  if (!apiKey) throw new Error(`${provider}: no API key configured`);

  if (provider === "gemini") {
    return geminiComplete(apiKey, req, opts.timeoutMs);
  }

  const client = openAiClientFor(provider, apiKey, opts.timeoutMs);
  const primaryModel = modelFor(provider, req.model);
  // Groq retires model ids over time: on a 404 model_not_found, fall
  // through GROQ_MODEL_CHAIN (mirrors the Tools proxy, proven live
  // 2026-10-21). Any other failure — auth, quota, timeout — throws
  // immediately, exactly as before. Other providers: a single attempt.
  const candidates =
    provider === "groq"
      ? [primaryModel, ...GROQ_MODEL_CHAIN.filter((m) => m !== primaryModel)]
      : [primaryModel];
  let response;
  let model = primaryModel;
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      response = await client.chat.completions.create(
        openAiCreateParams(req, candidate) as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming
      );
      model = candidate;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isModelNotFoundError(err)) break;
    }
  }
  if (lastErr) {
    throw new Error(scrubKeyMaterial(describeProviderError(provider, lastErr), apiKey));
  }
  if (!response) {
    // Unreachable in practice — the loop either assigns a response or
    // records an error — but keeps the invariant explicit.
    throw new Error(`${provider}: no response`);
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

/** Attempt order for the auto chain: priority order, with the business's
 *  preferred provider (settings.aiProvider) moved to the front. Shared by
 *  the blocking and streaming wrappers. */
function autoAttemptOrder(keys: ProviderKeys, preferredProvider?: RealProvider | null): RealProvider[] {
  let order = keyedProviders(keys);
  if (preferredProvider && keys[preferredProvider]) {
    order = [preferredProvider, ...order.filter((p) => p !== preferredProvider)];
  }
  return order;
}

/**
 * Run one chat completion with provider failover.
 *
 * - `providerHint: "auto"` (default): try the keyed providers in priority
 *   order (preferredProvider first); skip providers without keys; fail over
 *   on error / rate limit / timeout to the next. A provider whose circuit
 *   breaker is open (recent credential/rate/transient failures — see the
 *   breaker section) is skipped instantly instead of re-taxing the call.
 * - `providerHint: "groq"|"gemini"|"openai"`: attempt ONLY that provider.
 *   Failure throws AllProvidersFailedError — no silent switch, because the
 *   caller explicitly pinned the provider. (A pinned attempt is always
 *   made, breaker or not: the caller asked for that provider by name.)
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
      const result = await completeWithProvider(hint, keys, req, { timeoutMs: chatTimeoutMs() });
      recordProviderSuccess(hint, keys[hint]!);
      return result;
    } catch (err) {
      recordProviderFailure(hint, keys[hint]!, err);
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[providers:${label}] pinned provider failed`, { provider: hint, reason });
      throw new AllProvidersFailedError(
        `Provider "${hint}" failed: ${reason}`,
        [{ provider: hint, reason }],
        hint
      );
    }
  }

  const order = autoAttemptOrder(keys, opts.preferredProvider);
  if (order.length === 0) return null; // honest-degraded path

  const failures: Array<{ provider: string; reason: string }> = [];
  for (const provider of order) {
    const apiKey = keys[provider]!;
    if (providerCircuitOpen(provider, apiKey)) {
      logger.warn(`[providers:${label}] provider circuit open, skipping`, { provider });
      failures.push({ provider, reason: "circuit-open" });
      continue;
    }
    try {
      const result = await completeWithProvider(provider, keys, req, { timeoutMs: chatTimeoutMs() });
      recordProviderSuccess(provider, apiKey);
      if (provider !== order[0]) {
        logger.info(`[providers:${label}] failover succeeded`, { provider });
      }
      return result;
    } catch (err) {
      recordProviderFailure(provider, apiKey, err);
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
/* Streaming completions (widget chat)                                 */
/* ------------------------------------------------------------------ */

/**
 * Token-streaming twins of the wrappers above, with identical failover,
 * pinning and breaker semantics. The widget chat path uses these so a
 * reply starts rendering as it is generated — the typing indicator only
 * has to cover the wait for the FIRST token, not the whole completion.
 *
 * Forwarding rule: onToken fires only while the completion is producing
 * plain text. The moment a tool-call delta appears, forwarding stops
 * (the text was preamble to a tool round, not the reply); if tokens had
 * already escaped when tool calls materialize, onRetract fires once at
 * the end of that completion so the client discards the partial bubble.
 * Provider failover is only possible while ZERO tokens were forwarded —
 * after that, a stream failure throws (the caller's final `done`
 * payload carries the authoritative text either way).
 */
export interface StreamCallbacks {
  onToken?: (text: string) => void;
  onRetract?: () => void;
}

function firstTokenTimeoutMs(): number {
  return envMs("AI_FIRST_TOKEN_TIMEOUT_MS", 12_000);
}

function streamIdleTimeoutMs(): number {
  return envMs("AI_STREAM_IDLE_TIMEOUT_MS", 20_000);
}

/** Marker the stream consumers set when a failure happened AFTER tokens
 *  were forwarded — failover must not restart the answer elsewhere. */
function markForwarded(err: unknown, forwarded: boolean): void {
  if (err && typeof err === "object") {
    (err as { forwardedTokens?: boolean }).forwardedTokens = forwarded;
  }
}

function errForwardedTokens(err: unknown): boolean {
  return !!(err as { forwardedTokens?: boolean } | null)?.forwardedTokens;
}

async function consumeOpenAiStream(
  client: OpenAI,
  provider: "openai" | "groq" | "openrouter",
  model: string,
  req: ChatCompletionRequest,
  cb: StreamCallbacks
): Promise<ChatCompletionResult> {
  const controller = new AbortController();
  let forwarded = false;
  let sawToolDelta = false;
  let text = "";
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(),
    firstTokenTimeoutMs()
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), streamIdleTimeoutMs());
  };
  try {
    const stream = await client.chat.completions.create(
      { ...openAiCreateParams(req, model), stream: true } as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: controller.signal }
    );
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta as
        | {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          }
        | undefined;
      if (!delta) continue;
      if (firstTimer) {
        clearTimeout(firstTimer);
        firstTimer = undefined;
      }
      armIdle();
      const toolDeltas = delta.tool_calls ?? [];
      if (toolDeltas.length > 0) sawToolDelta = true;
      for (const td of toolDeltas) {
        const idx = typeof td.index === "number" ? td.index : 0;
        const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
        if (td.id) acc.id = td.id;
        if (td.function?.name) acc.name = td.function.name;
        if (td.function?.arguments) acc.args += td.function.arguments;
        toolAcc.set(idx, acc);
      }
      const piece = typeof delta.content === "string" ? delta.content : "";
      if (piece) {
        text += piece;
        if (!sawToolDelta && cb.onToken) {
          cb.onToken(piece);
          forwarded = true;
        }
      }
    }
  } catch (err) {
    markForwarded(err, forwarded);
    throw err;
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
  const toolCalls: ProviderToolCall[] = [...toolAcc.values()]
    .filter((t) => t.name)
    .map((t, i) => ({
      id: t.id || `${provider}-call-${i}-${Date.now()}`,
      type: "function" as const,
      function: { name: t.name, arguments: t.args || "{}" },
    }));
  if (forwarded && toolCalls.length > 0) cb.onRetract?.();
  return {
    provider,
    model,
    text: text.trim(),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

async function streamOpenAiFamily(
  provider: "openai" | "groq" | "openrouter",
  apiKey: string,
  req: ChatCompletionRequest,
  cb: StreamCallbacks
): Promise<ChatCompletionResult> {
  const client = openAiClientFor(provider, apiKey, chatTimeoutMs());
  const primaryModel = modelFor(provider, req.model);
  const candidates =
    provider === "groq"
      ? [primaryModel, ...GROQ_MODEL_CHAIN.filter((m) => m !== primaryModel)]
      : [primaryModel];
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      return await consumeOpenAiStream(client, provider, candidate, req, cb);
    } catch (err) {
      lastErr = err;
      // Model fallover only before anything reached the user, and only
      // for the retired-model case — the same rule as the blocking path.
      if (!isModelNotFoundError(err) || errForwardedTokens(err)) break;
    }
  }
  throw new Error(scrubKeyMaterial(describeProviderError(provider, lastErr), apiKey));
}

async function streamGemini(
  apiKey: string,
  req: ChatCompletionRequest,
  cb: StreamCallbacks
): Promise<ChatCompletionResult> {
  const model = modelFor("gemini", req.model);
  const body = geminiRequestBody(req);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const controller = new AbortController();
  // The client-level chat budget bounds the whole stream; the per-read
  // watchdogs below bound time-to-first-token and mid-stream stalls.
  const totalTimer = setTimeout(() => controller.abort(), chatTimeoutMs());
  let forwarded = false;
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        scrubKeyMaterial(`gemini: request failed (${err instanceof Error ? err.message : String(err)})`, apiKey)
      );
    }
    if (!res.ok || !res.body) {
      const snippet = scrubKeyMaterial((await res.text().catch(() => "")).slice(0, 300), apiKey);
      const err = new Error(`gemini: HTTP ${res.status} ${snippet}`);
      (err as { status?: number }).status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let sawToolPart = false;
    const toolCalls: ProviderToolCall[] = [];
    let firstChunk = true;

    const readWithWatchdog = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      const budget = firstChunk ? firstTokenTimeoutMs() : streamIdleTimeoutMs();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("gemini: stream stalled"));
            }, budget);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const handleData = (jsonText: string) => {
      let data: { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };
      try {
        data = JSON.parse(jsonText) as typeof data;
      } catch {
        return;
      }
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (p.functionCall) {
          sawToolPart = true;
          toolCalls.push({
            id: `gemini-call-${toolCalls.length}-${Date.now()}`,
            type: "function",
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
          });
        }
        if (typeof p.text === "string" && p.text) {
          text += p.text;
          if (!sawToolPart && cb.onToken) {
            cb.onToken(p.text);
            forwarded = true;
          }
        }
      }
    };

    for (;;) {
      const { done, value } = await readWithWatchdog();
      if (done) break;
      firstChunk = false;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) handleData(line.slice(5).trim());
        nl = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) handleData(tail.slice(5).trim());
    if (forwarded && toolCalls.length > 0) cb.onRetract?.();
    return {
      provider: "gemini",
      model,
      text: text.trim(),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  } catch (err) {
    markForwarded(err, forwarded);
    throw err;
  } finally {
    clearTimeout(totalTimer);
  }
}

/**
 * One STREAMING chat completion against ONE provider. Same contract as
 * completeWithProvider (throws on failure, empty text returned as-is),
 * plus token callbacks. Breaker-free for the same reason.
 */
export async function streamWithProvider(
  provider: RealProvider,
  keys: ProviderKeys,
  req: ChatCompletionRequest,
  cb: StreamCallbacks
): Promise<ChatCompletionResult> {
  const apiKey = keys[provider];
  if (!apiKey) throw new Error(`${provider}: no API key configured`);
  if (provider === "gemini") {
    return streamGemini(apiKey, req, cb);
  }
  return streamOpenAiFamily(provider, apiKey, req, cb);
}

/**
 * Streaming twin of completeWithFallback — same ordering, pinning and
 * honest-degradation semantics, with the circuit breaker applied and one
 * extra rule: failover stops once any token has been forwarded (a reply
 * already on the user's screen is never restarted on another provider;
 * the failure throws and the caller settles with its fallback).
 */
export async function streamWithFallback(
  req: ChatCompletionRequest,
  opts: FallbackOptions & { stream: StreamCallbacks }
): Promise<ChatCompletionResult | null> {
  const label = opts.label ?? "ai";
  const keys = opts.keys ?? (await resolveSiteKeys());
  const hint = normalizeProviderHint(opts.providerHint ?? "auto");
  const stream = opts.stream;

  if (hint !== "auto") {
    if (!keys[hint]) {
      throw new AllProvidersFailedError(
        `Provider "${hint}" was requested but no API key is configured for it (env ${providerEnvName(hint)} or the site's own key).`,
        [{ provider: hint, reason: "no-key" }],
        hint
      );
    }
    try {
      const result = await streamWithProvider(hint, keys, req, stream);
      recordProviderSuccess(hint, keys[hint]!);
      return result;
    } catch (err) {
      recordProviderFailure(hint, keys[hint]!, err);
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[providers:${label}] pinned provider failed (stream)`, { provider: hint, reason });
      throw new AllProvidersFailedError(
        `Provider "${hint}" failed: ${reason}`,
        [{ provider: hint, reason }],
        hint
      );
    }
  }

  const order = autoAttemptOrder(keys, opts.preferredProvider);
  if (order.length === 0) return null;

  const failures: Array<{ provider: string; reason: string }> = [];
  for (const provider of order) {
    const apiKey = keys[provider]!;
    if (providerCircuitOpen(provider, apiKey)) {
      logger.warn(`[providers:${label}] provider circuit open, skipping (stream)`, { provider });
      failures.push({ provider, reason: "circuit-open" });
      continue;
    }
    let forwarded = false;
    const tracking: StreamCallbacks = {
      onToken: (t) => {
        forwarded = true;
        stream.onToken?.(t);
      },
      onRetract: () => stream.onRetract?.(),
    };
    try {
      const result = await streamWithProvider(provider, keys, req, tracking);
      recordProviderSuccess(provider, apiKey);
      if (provider !== order[0]) {
        logger.info(`[providers:${label}] failover succeeded (stream)`, { provider });
      }
      return result;
    } catch (err) {
      recordProviderFailure(provider, apiKey, err);
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[providers:${label}] provider failed (stream)`, { provider, reason });
      failures.push({ provider, reason });
      if (forwarded || errForwardedTokens(err)) {
        // Tokens already reached the user — never restart the reply on
        // another provider. Surface the failure; the caller settles.
        throw new AllProvidersFailedError(
          `Provider "${provider}" failed mid-stream after tokens were sent.`,
          failures
        );
      }
    }
  }
  throw new AllProvidersFailedError(
    `All configured AI providers failed (${failures.map((f) => f.provider).join(", ")}).`,
    failures
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
  return `data:${cleanMimeType(mimeType) || mimeType};base64,${bytes.toString("base64")}`;
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
              { inlineData: { mimeType: cleanMimeType(input.mimeType) || input.mimeType, data: input.bytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const snippet = scrubKeyMaterial((await res.text().catch(() => "")).slice(0, 200), apiKey);
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

  // OpenAI-family vision (OpenAI / Groq / OpenRouter). Groq walks its
  // vision catalogue (visionModelCandidates) because Groq retires /
  // re-scopes vision ids independently of its text catalogue: a model
  // that answers text can be gone for image input, and the ONE
  // hardcoded id this used to send is exactly how every photo broke
  // (media fix 2026-10-22). Fallover only on model-unavailable errors;
  // auth/quota/timeout throw immediately.
  const client = openAiClientFor(provider, apiKey);
  const candidates = visionModelCandidates(provider, modelHint);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      const response = await client.chat.completions.create({
        model: candidate,
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
      });
      const text = response.choices[0]?.message?.content?.trim();
      if (!text) throw new Error(`${provider}: vision returned no description`);
      return text;
    } catch (err) {
      lastErr = err;
      if (!isModelUnavailableError(err)) break;
    }
  }
  throw new Error(scrubKeyMaterial(describeProviderError(provider, lastErr), apiKey));
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

/** Bare mime type without parameters — browsers hand over values like
 *  "audio/webm;codecs=opus", and strict multipart/provider validation
 *  can reject the parameterised form (media fix 2026-10-22). */
function cleanMimeType(mimeType: string): string {
  return (mimeType || "").split(";")[0].trim().toLowerCase();
}

function audioExt(mimeType: string): string {
  const m = cleanMimeType(mimeType);
  if (m.includes("mp3") || m.includes("mpeg")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("flac")) return "flac";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  return "ogg";
}

/** Whisper model candidates per provider (media fix 2026-10-22). Groq's
 *  speech-to-text documentation (console.groq.com/docs/speech-to-text,
 *  checked 2026-10-22) lists whisper-large-v3 and whisper-large-v3-turbo
 *  as the current models; try the accurate one first, fall over to the
 *  turbo on a model-unavailable error only. */
function transcriptionModelsFor(provider: RealProvider): string[] {
  if (provider === "groq") return ["whisper-large-v3", "whisper-large-v3-turbo"];
  if (provider === "openai") return ["whisper-1"];
  return ["whisper-1"];
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
              { inlineData: { mimeType: cleanMimeType(input.mimeType) || input.mimeType, data: input.bytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 2000, temperature: 0 },
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const snippet = scrubKeyMaterial((await res.text().catch(() => "")).slice(0, 200), apiKey);
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

  // OpenAI Whisper + Groq's OpenAI-compatible Whisper endpoint. The
  // uploaded file's name extension and content type must AGREE with the
  // actual recording: browsers record webm/opus (Chrome) or mp4 (Safari)
  // and report parameterised mimes ("audio/webm;codecs=opus") — sending
  // the raw mime as the file type, or an .ogg name over MP4 bytes, gets
  // the upload rejected before Whisper ever hears it (media fix
  // 2026-10-22).
  const client = openAiClientFor(provider, apiKey);
  const file = await toFile(input.bytes, `voice-${Date.now()}.${audioExt(input.mimeType)}`, {
    type: cleanMimeType(input.mimeType) || "audio/ogg",
  });
  let lastErr: unknown = null;
  for (const model of transcriptionModelsFor(provider)) {
    try {
      const result = await client.audio.transcriptions.create({ file, model });
      const text = (result.text ?? "").trim();
      if (!text) throw new Error(`${provider}: transcription came back empty`);
      return text;
    } catch (err) {
      lastErr = err;
      if (!isModelUnavailableError(err)) break;
    }
  }
  throw new Error(scrubKeyMaterial(describeProviderError(provider, lastErr), apiKey));
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
