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
    logger.error("GET /api/public/firebase-config failed", {
      error: (e as Error).message,
    });
    return NextResponse.json(
      { error: "Configuration is not available." },
      { status: 500 }
    );
  }
}
