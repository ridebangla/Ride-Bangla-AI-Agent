import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { resolveChannelBusiness } from "@/lib/tenant";
import { logger } from "@/lib/logger";
import {
  verifyMetaSubscription,
  verifyMetaSignature,
  handleMetaWebhook,
} from "@/lib/channels/meta";

// Node.js runtime: we need the raw body for X-Hub-Signature-256.
export const runtime = "nodejs";

/**
 * Meta webhook subscription handshake.
 * GET /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 * Public (Meta calls it, not the dashboard) — authenticated by the verify
 * token, never by JWT. Add ?business=<slug> for multi-business deployments.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (verifyMetaSubscription(mode, token) && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  logger.warn("[Meta webhook] subscription verification failed");
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

/**
 * Meta webhook events (messaging + feed). Signature-verified, fail-closed.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyMetaSignature(rawBody, signature)) {
    logger.warn("[Meta webhook] bad or missing signature — event rejected");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { object?: string; entry?: unknown[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.object !== "page" && payload.object !== "instagram") {
    return NextResponse.json({ error: "Unsupported object" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  let businessId: string;
  try {
    businessId = await resolveChannelBusiness(searchParams.get("business"));
  } catch (err) {
    logger.warn("[Meta webhook] business resolution failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Unknown business" }, { status: 400 });
  }

  try {
    const counts = await runWithBusiness(businessId, () =>
      handleMetaWebhook(
        payload as Parameters<typeof handleMetaWebhook>[0],
        businessId
      )
    );
    // Meta requires a fast 200 — always acknowledge receipt.
    return NextResponse.json({ received: true, ...counts });
  } catch (err) {
    logger.error("[Meta webhook] handler failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ received: true, error: "handler_failed" });
  }
}
