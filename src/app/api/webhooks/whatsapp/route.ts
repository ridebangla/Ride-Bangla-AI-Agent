import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  verifyWhatsAppSubscription,
  handleWhatsAppCloudWebhook,
  resolveWebhookBusiness,
} from "@/lib/channels/whatsapp-cloud";

// Node.js runtime (consistent with the other provider webhooks).
export const runtime = "nodejs";

/**
 * WhatsApp Business Cloud API webhook.
 *
 * GET  — subscription handshake (?hub.mode=subscribe&hub.verify_token=...
 *        &hub.challenge=...), verified against WHATSAPP_VERIFY_TOKEN.
 * POST — inbound message/status events. WhatsApp Cloud webhooks are not
 *        HMAC-signed; trust comes from the TLS delivery to the registered
 *        URL after the verify handshake (documented honestly in
 *        src/lib/channels/whatsapp-cloud.ts — no fake signature check).
 *
 * Public — authenticated by the verify token + registered URL, never JWT.
 * Add ?business=<slug> for multi-business deployments.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (verifyWhatsAppSubscription(mode, token) && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  logger.warn("[WhatsAppCloud webhook] subscription verification failed");
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  let businessId: string;
  try {
    businessId = await resolveWebhookBusiness(searchParams.get("business"));
  } catch (err) {
    logger.warn("[WhatsAppCloud webhook] business resolution failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Unknown business" }, { status: 400 });
  }

  try {
    const counts = await runWithBusiness(businessId, () =>
      handleWhatsAppCloudWebhook(
        payload as Parameters<typeof handleWhatsAppCloudWebhook>[0],
        businessId
      )
    );
    // Meta requires a fast 200 — always acknowledge receipt.
    return NextResponse.json({ received: true, ...counts });
  } catch (err) {
    logger.error("[WhatsAppCloud webhook] handler failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ received: true, error: "handler_failed" });
  }
}
