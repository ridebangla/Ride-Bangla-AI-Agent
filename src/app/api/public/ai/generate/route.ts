/**
 * POST /api/public/ai/generate — first-party AI endpoint for sibling sites
 * (Tools, Studio, …). Sibling sites MUST call AI through this backend;
 * provider API keys (GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY) never
 * leave this server.
 *
 * Auth: the business's public `siteKey` (same site key the chat widget
 * uses — identifies the business, grants no admin powers).
 *
 * Rate limit: 30 requests/minute per (siteKey + caller id).
 *
 * Request (JSON):
 *   {
 *     "siteKey": "rbsite-…",            // required
 *     "task": "chat" | "generate",      // required, allowlisted
 *     "provider": "auto"|"groq"|"gemini"|"openai", // optional, default "auto"
 *     "callerId": "tools:qr-generator", // optional, for per-tool rate limiting
 *     "input": {
 *       // task "chat":
 *       "messages": [{ "role": "user"|"assistant"|"system", "content": "…" }],
 *       // task "generate":
 *       "prompt": "…",
 *       "system": "…"                    // optional system instruction
 *     },
 *     "maxTokens": 1000,                 // optional, default 1000, max 4000
 *     "temperature": 0.7                 // optional, default 0.7
 *   }
 *
 * Success (200):
 *   { "ok": true, "aiConfigured": true, "provider": "groq",
 *     "model": "openai/gpt-oss-120b", "text": "…" }
 *
 * Honest degraded (200 — never faked output):
 *   { "ok": true, "aiConfigured": false, "provider": null, "model": null,
 *     "text": null,
 *     "message": "AI is not configured for this site yet. …" }
 *
 * Errors: 400 validation, 401 bad site key, 402 subscription_paused,
 * 429 rate limited, 502 pinned provider failed
 *   { "ok": false, "error": "…", "provider": "groq", "reason": "…" }
 *
 * Key resolution per site: the site's own dedicated keys
 * (Firestore settings.aiKeys — Admin-SDK read, never client-readable)
 * win per provider; missing providers fall back to the shared env keys.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { getSubscription } from "@/lib/subscription";
import { checkMessageLimitExceeded, recordAiMessage } from "@/lib/billing-usage";
import {
  AllProvidersFailedError,
  completeWithFallback,
  hasAnyProviderKey,
  normalizeProviderHint,
  resolveSiteKeys,
  type ChatMessage,
} from "@/lib/ai/providers";

const PUBLIC_AI_RATE_LIMIT = { maxRequests: 30, windowMs: 60 * 1000 };
const MAX_INPUT_CHARS = 20000;
const MAX_TOKENS_CAP = 4000;
const ALLOWED_TASKS = ["chat", "generate"] as const;
type Task = (typeof ALLOWED_TASKS)[number];

const DEGRADED_MESSAGE =
  "AI is not configured for this site yet — the site owner still needs to add an AI provider key (Groq, Gemini, or OpenAI). " +
  "This response was not AI-generated.";

function degraded() {
  return NextResponse.json({
    ok: true,
    aiConfigured: false,
    provider: null,
    model: null,
    text: null,
    message: DEGRADED_MESSAGE,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  // ---- Auth: site key (same seam as the chat widget) ----
  const siteKey = body.siteKey;
  if (!siteKey || typeof siteKey !== "string") {
    return NextResponse.json({ ok: false, error: "siteKey is required" }, { status: 401 });
  }
  // Q-QUOTA (2026-10-23): getBusinessBySiteKey resolves through the
  // tenant layer's 60 s in-process cache + Q-SIGNIN's equality
  // prefilter — ≤1 read cold, 0 warm (was: a full businesses scan per
  // call before Q-SIGNIN). Subscription/limit state below is NOT
  // cached and still reads fresh on every call.
  const business = await getBusinessBySiteKey(siteKey);
  if (!business) {
    return NextResponse.json({ ok: false, error: "Invalid site key" }, { status: 401 });
  }

  // ---- Billing hard-stop BEFORE any LLM tokens are spent (widget parity) ----
  const sub = await getSubscription(business.id);
  if (!sub.isActive) {
    logger.warn(`[public-ai] blocked for business ${business.id}: subscription inactive`);
    return NextResponse.json({ ok: false, error: "subscription_paused" }, { status: 402 });
  }
  // Feature scope (B6): a grant scoped away from "chat" blocks with
  // the same 402 shape. Unscoped accounts pass unchanged.
  if (sub.scopeAllowsChat === false) {
    logger.warn(`[public-ai] blocked for business ${business.id}: grant scope excludes chat`);
    return NextResponse.json({ ok: false, error: "subscription_paused" }, { status: 402 });
  }

  // Plan quota hard-stop: this endpoint spends the site owner's LLM keys
  // but was previously neither metered nor limit-checked — any holder of
  // the (public) siteKey could burn unlimited shared provider quota.
  if (await checkMessageLimitExceeded(business.id)) {
    return NextResponse.json({ ok: false, error: "message_limit_reached" }, { status: 402 });
  }

  // ---- Rate limit: per site + caller, AND per site + IP ----
  // callerId is caller-supplied, so keying on it alone let an attacker
  // rotate callerIds for a fresh bucket every request. The IP bucket
  // cannot be rotated away from the server's point of view.
  const callerId =
    typeof body.callerId === "string" && body.callerId.trim()
      ? body.callerId.trim().slice(0, 64)
      : "default";
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  // B7: verified internal (company) traffic is exempt — identity is
  // the server-resolved subscription record behind the siteKey.
  const rl: { allowed: boolean } =
    sub.isInternal === true
      ? { allowed: true }
      : checkRateLimit(`public-ai:${siteKey}:${callerId}`, PUBLIC_AI_RATE_LIMIT);
  const rlIp: { allowed: boolean } =
    sub.isInternal === true
      ? { allowed: true }
      : checkRateLimit(`public-ai-ip:${siteKey}:${clientIp}`, PUBLIC_AI_RATE_LIMIT);
  if (!rl.allowed || !rlIp.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Please wait a moment and try again." },
      { status: 429 }
    );
  }

  // ---- Validate task + input ----
  const task = body.task;
  if (typeof task !== "string" || !(ALLOWED_TASKS as readonly string[]).includes(task)) {
    return NextResponse.json(
      { ok: false, error: `task must be one of: ${ALLOWED_TASKS.join(", ")}` },
      { status: 400 }
    );
  }
  const input = body.input;
  if (!isRecord(input)) {
    return NextResponse.json({ ok: false, error: "input is required" }, { status: 400 });
  }

  let providerHint: "auto" | "groq" | "gemini" | "openai" | "openrouter";
  try {
    providerHint = normalizeProviderHint(body.provider ?? "auto");
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Invalid provider" },
      { status: 400 }
    );
  }

  let maxTokens = 1000;
  if (body.maxTokens !== undefined) {
    if (typeof body.maxTokens !== "number" || body.maxTokens < 1) {
      return NextResponse.json({ ok: false, error: "maxTokens must be a positive number" }, { status: 400 });
    }
    maxTokens = Math.min(Math.floor(body.maxTokens), MAX_TOKENS_CAP);
  }
  let temperature = 0.7;
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2) {
      return NextResponse.json({ ok: false, error: "temperature must be between 0 and 2" }, { status: 400 });
    }
    temperature = body.temperature;
  }

  const messages: ChatMessage[] = [];
  if ((task as Task) === "chat") {
    const raw = input.messages;
    if (!Array.isArray(raw) || raw.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'input.messages must be a non-empty array for task "chat"' },
        { status: 400 }
      );
    }
    if (raw.length > 50) {
      return NextResponse.json({ ok: false, error: "input.messages is limited to 50 entries" }, { status: 400 });
    }
    for (const m of raw) {
      if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant" && m.role !== "system") || typeof m.content !== "string") {
        return NextResponse.json(
          { ok: false, error: 'each message needs { role: "user"|"assistant"|"system", content: string }' },
          { status: 400 }
        );
      }
      const content = m.content.slice(0, MAX_INPUT_CHARS);
      messages.push({ role: m.role, content });
    }
  } else {
    // task "generate"
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
      return NextResponse.json(
        { ok: false, error: 'input.prompt is required for task "generate"' },
        { status: 400 }
      );
    }
    if (typeof input.system === "string" && input.system.trim()) {
      messages.push({ role: "system", content: input.system.slice(0, MAX_INPUT_CHARS) });
    }
    messages.push({ role: "user", content: input.prompt.slice(0, MAX_INPUT_CHARS) });
  }

  // ---- Resolve keys: site's own dedicated keys first, shared env fallback ----
  const keys = await resolveSiteKeys(business.id);
  if (!hasAnyProviderKey(keys)) {
    logger.info(`[public-ai] no provider key for business ${business.id} — honest degraded response`);
    return degraded();
  }

  try {
    const completion = await completeWithFallback(
      { messages, maxTokens, temperature },
      { keys, providerHint, label: "public-ai" }
    );
    if (!completion) return degraded(); // cannot happen (keys checked), kept for safety
    // Meter the spend against the site owner's plan quota (fire-and-forget,
    // same contract as the chat engine's recordAiMessage call).
    void recordAiMessage(business.id);
    return NextResponse.json({
      ok: true,
      aiConfigured: true,
      provider: completion.provider,
      model: completion.model,
      text: completion.text,
    });
  } catch (err) {
    if (err instanceof AllProvidersFailedError) {
      logger.warn(`[public-ai] providers failed for business ${business.id}`, {
        attempts: err.attempts.map((a) => `${a.provider}: ${a.reason.slice(0, 120)}`),
      });
      // Pinned provider (or whole chain) failed — honest error, never fake
      // text. The raw provider reasons stay in the server log above ONLY:
      // this route is reachable with the PUBLIC siteKey, and provider error
      // text discloses platform internals (provider identity, account
      // billing state, error codes) to any caller (attack-test 2026-10-21).
      return NextResponse.json(
        {
          ok: false,
          error: `AI provider${err.pinned ? ` "${err.pinned}"` : "s"} failed`,
          provider: err.pinned ?? null,
          reason: "The AI provider returned an error; details were logged server-side.",
        },
        { status: 502 }
      );
    }
    logger.error(`[public-ai] unexpected error for business ${business.id}`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false, error: "AI request failed" }, { status: 500 });
  }
}
