/**
 * GET /api/public/firebase-config?siteKey=<valid public site key>
 *
 * Sibling static sites (Tools) cannot hold a Firebase web config in their
 * pages. They fetch it here at runtime — these are the SAME public web
 * identifiers every Firebase web app ships in the browser (not secrets) —
 * but we only serve them to requests carrying a valid business siteKey, so
 * the config is never just handed out anonymously.
 * → { apiKey, authDomain, projectId } read from this backend's own
 *   NEXT_PUBLIC_FIREBASE_* env values.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBusinessBySiteKey } from "@/lib/tenant";

export const dynamic = "force-dynamic";

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

const RATE_LIMIT = { maxRequests: 60, windowMs: 60 * 1000 };

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const siteKey = url.searchParams.get("siteKey");
    if (!siteKey) {
      return NextResponse.json(
        { error: "Invalid site key." },
        { status: 401 }
      );
    }
    const business = await getBusinessBySiteKey(siteKey);
    if (!business) {
      return NextResponse.json(
        { error: "Invalid site key." },
        { status: 401 }
      );
    }

    const ip = clientIp(request);
    const rl = checkRateLimit(`public-firebase-config:${ip}`, RATE_LIMIT);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests — please try again soon." },
        { status: 429 }
      );
    }

    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (!apiKey || !authDomain || !projectId) {
      return NextResponse.json(
        { error: "Configuration is not available." },
        { status: 503 }
      );
    }

    return NextResponse.json({ apiKey, authDomain, projectId });
  } catch (e) {
    // Pass the error itself: logger.error's 2nd parameter IS the error —
    // wrapping it in { error: ... } made the logger String() the object,
    // which is why production logs showed "[object Object]" and this
    // failure's real cause stayed hidden (2026-10-23 root-cause round).
    logger.error("GET /api/public/firebase-config failed", e);
    // A dead data layer (Firestore quota / unavailability) is a
    // transient 503, not a 500 "configuration" fault: the config values
    // exist; the siteKey lookup behind them is what is unavailable.
    // Sibling sites treat any non-200 alike (honest unavailable state),
    // so this changes semantics only, never a success path.
    const err = e as { code?: unknown; message?: unknown };
    const msg = typeof err?.message === "string" ? err.message : "";
    if (
      err?.code === 8 ||
      err?.code === 14 ||
      msg.includes("RESOURCE_EXHAUSTED") ||
      msg.includes("UNAVAILABLE")
    ) {
      return NextResponse.json(
        { error: "Configuration is temporarily unavailable." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Configuration is not available." },
      { status: 500 }
    );
  }
}
