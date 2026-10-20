import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  verifyWhatsAppSubscription,
  handleWhatsAppCloudWebhook,
  resolveWebhookBusiness,
} from "@/lib/channels/whatsapp-cloud";
import { verifyMetaSignature } from "@/lib/channels/meta";

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
  // WhatsApp Cloud events are delivered by Meta and DO carry an
  // X-Hub-Signature-256 HMAC (same META_APP_SECRET as /api/webhooks/meta).
  // Previously this route accepted unsigned POSTs from anyone who knew a
  // business slug — forged inbound messages, fake conversations and
  // attacker-triggered AI spend. When the app secret is configured the
  // signature is REQUIRED (fail-closed); when it is not configured we log
  // an error-level alert and fall back to the legacy verify-token trust
  // model so an unconfigured install is not silently broken.
  const rawBody = await request.text();
  if (process.env.META_APP_SECRET) {
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyMetaSignature(rawBody, signature)) {
      logger.warn("[WhatsAppCloud webhook] bad or missing signature — event rejected");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    logger.error(
      "[WhatsAppCloud webhook] ALERT: META_APP_SECRET is NOT configured — webhook signature cannot be verified. Set META_APP_SECRET to enforce signed delivery."
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
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
