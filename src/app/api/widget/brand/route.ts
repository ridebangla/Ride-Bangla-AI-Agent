import { NextResponse } from "next/server";
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
 * CORS (Team C fix 2026-11-03): the embed runs on ARBITRARY tenant
 * origins, not only company surfaces — the widget is the tenant
 * product, and its script is served from this instance while the
 * host page is the tenant's own domain. The old company-origin
 * allowlist therefore made the brand fetch fail (no CORS header,
 * browser blocks the read, silent fallback to the hardcoded
 * defaults) on every tenant site: after an owner brand change,
 * company sites showed the new mascot/logo while tenant widgets
 * stayed on the old defaults, breaking "one change reaches every
 * widget and tenant's agent". The payload is the PUBLIC platform
 * brand record (logo/video URLs + version — no secrets, no PII,
 * already fetchable server-to-server by anyone), fetched with
 * credentials: omit, so Access-Control-Allow-Origin: * is the
 * correct policy here — mirroring GET /api/widget/identity, the
 * other public widget record, which already answers `*` for
 * exactly this tenant-origin reason.
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
// CORS — public record, any origin (see header comment). The widget
// fetches with credentials: omit, so `*` is valid and sufficient.
// ---------------------------------------------------------------------------

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function brandResponse(body: typeof DEFAULTS) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "public, max-age=60",
      ...corsHeaders(),
    },
  });
}

export async function GET() {
  const now = Date.now();
  if (cachedBody && now - cachedAt < CACHE_MS) {
    return brandResponse(cachedBody);
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
  return brandResponse(cachedBody);
}
