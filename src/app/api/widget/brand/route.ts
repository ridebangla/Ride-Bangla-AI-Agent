import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/admin-db";
import { logger } from "@/lib/logger";

/**
 * GET /api/widget/brand — public agent-brand record for the canonical embed.
 *
 * The agent character (bust still, idle clip, working clip, completion
 * clip) is a PLATFORM
 * asset the owner swaps from the Admin Panel (Super Admin only). The panel
 * writes Firestore `agent_brand/current`; this route serves the URLs
 * plus the record `version` so the canonical embed
 * (public/widget/ride-bangla-chat.js) and the platform's own surfaces can
 * resolve them at load time and auto-propagate a panel swap with no
 * redeploy.
 *
 * Reads server-side via the firebase-admin SDK (rules-exempt) — no client
 * Firestore reads anywhere in this path. The panel's WRITE leg still waits
 * on the owner's one-time Firestore-rules deploy for the `agent_brand`
 * collection; this serve leg works regardless of rules state.
 *
 * Fail-soft by contract: an absent doc/fields, a misconfigured Admin SDK,
 * or any Firestore error returns the seeded platform defaults, so a dead
 * record changes NOTHING for the widget.
 *
 * CORS: the embed is mounted on every company surface, so cross-origin
 * GETs are answered for the company's own origins ONLY (allowlist
 * below, mirroring the `corsHeaders` pattern in src/app/api/contact).
 * An allowlisted Origin is echoed in Access-Control-Allow-Origin; any
 * other Origin gets NO CORS header, so browsers block the read. The
 * payload itself is the public platform brand record — the allowlist
 * still applies as defence-in-depth and to keep the surface explicit.
 */
export const dynamic = "force-dynamic";

const DEFAULTS = {
  logoUrl: "https://ai.ridebangla.bd/agent-avatar.png",
  idleVideoUrl: "https://ai.ridebangla.bd/agent-idle.mp4",
  workingVideoUrl: "https://ai.ridebangla.bd/agent-working.mp4",
  // Completion clip (voice/video round 2026-10-22): additive field —
  // older records simply omit it and every consumer falls back to
  // this platform default, exactly like the other URLs.
  completionVideoUrl: "https://ai.ridebangla.bd/agent-done.mp4",
  version: 0,
};

// Short in-memory cache so every widget load doesn't burn a Firestore read.
const CACHE_MS = 60_000;
let cachedBody: typeof DEFAULTS | null = null;
let cachedAt = 0;

function safeUrl(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048
    ? value
    : fallback;
}

// ---------------------------------------------------------------------------
// CORS — company origins only (pattern mirrors src/app/api/contact/route.ts).
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  "https://ridebangla.bd",
  "https://www.ridebangla.bd",
  "https://tools.ridebangla.bd",
  "https://studio.ridebangla.bd",
  "https://it.ridebangla.bd",
  "https://ai.ridebangla.bd",
  "https://customer.ridebangla.bd",
  "https://partner.ridebangla.bd",
  "https://rider.ridebangla.bd",
  "https://agent.ridebangla.bd",
  // Local development, mirroring the contact route's SELF_ORIGINS entry.
  "http://localhost:3000",
]);

function corsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    // Same-origin / server-to-server (no Origin) needs no CORS headers;
    // a foreign Origin gets NO Access-Control-Allow-Origin, so the
    // browser blocks the cross-origin read.
    return { Vary: "Origin" };
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json(
      { error: "Origin not allowed." },
      { status: 403, headers: { Vary: "Origin" } }
    );
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

function brandResponse(body: typeof DEFAULTS, request: NextRequest) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "public, max-age=60",
      ...corsHeaders(request),
    },
  });
}

export async function GET(request: NextRequest) {
  const now = Date.now();
  if (cachedBody && now - cachedAt < CACHE_MS) {
    return brandResponse(cachedBody, request);
  }

  try {
    const db = getAdminDb();
    const snap = await db.collection("agent_brand").doc("current").get();
    const data = snap.exists ? snap.data() : undefined;
    cachedBody = {
      logoUrl: safeUrl(data?.logoUrl, DEFAULTS.logoUrl),
      idleVideoUrl: safeUrl(data?.idleVideoUrl, DEFAULTS.idleVideoUrl),
      workingVideoUrl: safeUrl(data?.workingVideoUrl, DEFAULTS.workingVideoUrl),
      completionVideoUrl: safeUrl(
        data?.completionVideoUrl,
        DEFAULTS.completionVideoUrl
      ),
      version:
        typeof data?.version === "number" && Number.isFinite(data.version)
          ? data.version
          : DEFAULTS.version,
    };
  } catch (error) {
    // Fail-soft: serve the seeded defaults, never an error payload.
    logger.warn("Agent brand lookup failed; serving defaults:", {
      error: error instanceof Error ? error.message : String(error),
    });
    cachedBody = { ...DEFAULTS };
  }

  cachedAt = now;
  return brandResponse(cachedBody, request);
}
