import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { answerXCRChallenge, isXConfigured } from "@/lib/social/x";

export const runtime = "nodejs";

/**
 * X (Twitter) Account Activity webhook.
 *
 * GET — CRC challenge (?crc_token=...). Answered with
 * HMAC-SHA256(X_API_SECRET) only when the API secret exists; otherwise an
 * honest 503 — never a faked handshake.
 *
 * POST — DM/activity events. The full Account Activity pipeline (event
 * parsing -> unified inbox) requires an approved paid-tier X developer app;
 * until then the route acknowledges receipt honestly and logs the event
 * shape. Env-gated: no keys => no fake processing.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const crcToken = searchParams.get("crc_token");
  if (!crcToken) {
    return NextResponse.json({ error: "crc_token is required" }, { status: 400 });
  }
  const responseToken = answerXCRChallenge(crcToken);
  if (!responseToken) {
    logger.warn("[X webhook] CRC requested but X_API_SECRET is not set");
    return NextResponse.json(
      { error: "X is not connected yet — set X_API_KEY / X_API_SECRET first" },
      { status: 503 }
    );
  }
  return NextResponse.json({ response_token: responseToken });
}

export async function POST(request: NextRequest) {
  if (!isXConfigured()) {
    // Honest: without keys there is nothing to process — but still 200 so
    // X doesn't hammer the endpoint while the business finishes setup.
    return NextResponse.json({
      received: true,
      processed: false,
      reason: "x_not_connected",
    });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Phase 5 ships the webhook handshake + honest gating. Full event
  // parsing (DM -> unified inbox thread) lands with the approved paid-tier
  // X developer app in Phase 6 — the engagement sync already polls
  // mentions/replies in the meantime.
  logger.info("[X webhook] event received (stored for Phase 6 parsing)", {
    keys:
      payload && typeof payload === "object" ? Object.keys(payload) : [],
  });
  return NextResponse.json({ received: true, processed: false, reason: "phase6" });
}
