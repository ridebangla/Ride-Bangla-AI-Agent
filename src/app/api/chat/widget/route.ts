import { NextRequest, NextResponse } from "next/server";
import { chat } from "@/lib/ai/engine";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBusinessBySiteKey, enterBusinessContext } from "@/lib/tenant";
import { getSubscription } from "@/lib/subscription";
import { prisma, withBusinessId } from "@/lib/prisma";
import { checkMessageLimitExceeded } from "@/lib/billing-usage";
import { parseActivityToken, bindActivityToken } from "@/lib/ai/activity";
import type { MediaInput } from "@/lib/ai/media";

/**
 * Public website-widget chat endpoint.
 *
 * Auth: the business's public `siteKey` (issued at seed/setup, shown in the
 * dashboard widget page). The site key identifies the business but grants no
 * admin powers — it can only chat as a website visitor.
 *
 * Strict rate limit: 20 requests/minute per (siteKey + visitor). Body size
 * is capped by Next.js defaults; base64 images are limited to ~4 MB.
 */
const WIDGET_RATE_LIMIT = { maxRequests: 20, windowMs: 60 * 1000 };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteKey, message, visitorId, conversationId, image } = body as {
      siteKey?: string;
      message?: string;
      visitorId?: string;
      conversationId?: string;
      image?: { mimeType?: string; base64?: string };
    };
    // Live-activity caption channel (see lib/ai/activity.ts): the embed
    // polls /api/chat/activity with this token while a reply is pending.
    const activityToken = parseActivityToken(
      (body as { activityToken?: unknown }).activityToken
    );

    if (!siteKey || typeof siteKey !== "string") {
      return NextResponse.json({ error: "siteKey is required" }, { status: 401 });
    }

    const business = await getBusinessBySiteKey(siteKey);
    if (!business) {
      return NextResponse.json({ error: "Invalid site key" }, { status: 401 });
    }
    // PHASE 3 (user decision 16 — airtight): subscription hard-stop BEFORE
    // any LLM tokens are spent, conversations are created, or media is
    // processed. Inactive trial/subscription => HTTP 402 +
    // { error: "subscription_paused" }; the widget renders a beautiful
    // "Subscription paused" state and sends nothing further.
    const sub = await getSubscription(business.id);
    if (!sub.isActive) {
      logger.warn(
        `[billing] blocked widget chat for business ${business.id}: subscription inactive`
      );
      return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
    }
    if (await checkMessageLimitExceeded(business.id)) {
      return NextResponse.json({ error: "message_limit_reached" }, { status: 402 });
    }
    enterBusinessContext(business.id);

    const visitor = typeof visitorId === "string" && visitorId.trim() ? visitorId.trim().slice(0, 64) : "anonymous";
    // visitorId is client-supplied and rotatable — a second bucket keyed by
    // (siteKey + IP) caps total abuse per network regardless of rotation.
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const rl = checkRateLimit(`widget:${siteKey}:${visitor}`, WIDGET_RATE_LIMIT);
    const rlIp = checkRateLimit(`widget-ip:${siteKey}:${clientIp}`, { maxRequests: 60, windowMs: 60 * 1000 });
    if (!rl.allowed || !rlIp.allowed) {
      return NextResponse.json(
        { error: "Too many messages. Please wait a moment and try again." },
        { status: 429 }
      );
    }

    const text = typeof message === "string" ? message.trim() : "";
    if (!text && !image?.base64) {
      return NextResponse.json({ error: "Message or image is required" }, { status: 400 });
    }
    if (text.length > 5000) {
      return NextResponse.json({ error: "Message too long" }, { status: 400 });
    }

    // Optional photo attachment from the widget.
    let media: MediaInput | undefined;
    if (image?.base64) {
      const mimeType = typeof image.mimeType === "string" ? image.mimeType : "image/jpeg";
      if (!mimeType.startsWith("image/")) {
        return NextResponse.json({ error: "Only image attachments are supported" }, { status: 400 });
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(image.base64, "base64");
      } catch {
        return NextResponse.json({ error: "Invalid image data" }, { status: 400 });
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "Image too large (max 4 MB)" }, { status: 400 });
      }
      media = { kind: "image", mimeType, bytes };
    }

    // Find or create the visitor's conversation.
    let convId = typeof conversationId === "string" ? conversationId : "";
    if (convId) {
      const existing = await prisma.conversation.findUnique({ where: { id: convId } });
      // Scoped to this business by the tenant proxy; also require the same
      // visitor so one visitor cannot read another's thread.
      if (!existing || existing.customerContact !== visitor) {
        convId = "";
      } else if (activityToken) {
        await bindActivityToken(convId, activityToken, existing.activityToken);
      }
    }
    if (!convId) {
      // Multi-site identity (A-to-Z audit 2026-10-20): when ONE business's
      // widget is embedded on several of the owner's sites, the Origin /
      // Referer host is the only reliable per-site signal — record it on
      // the conversation so the Inbox can tell which site a chat came
      // from. An explicit body.source (sanitized) wins when provided.
      const explicitSource =
        typeof (body as { source?: unknown }).source === "string"
          ? (body as { source: string }).source.trim().slice(0, 60)
          : "";
      let sourceSite = explicitSource;
      if (!sourceSite) {
        const originHost =
          request.headers.get("origin") || request.headers.get("referer") || "";
        try {
          sourceSite = new URL(originHost).hostname.slice(0, 60);
        } catch {
          sourceSite = "";
        }
      }
      const conv = await prisma.conversation.create({
        data: withBusinessId({
          channel: "widget",
          customerName: "Website Visitor",
          customerContact: visitor,
          status: "open",
          ...(activityToken ? { activityToken } : {}),
          ...(sourceSite ? { metadata: { sourceSite } } : {}),
          // Phase 3 (user decision 17): AI replies ON by default; the Phase
          // 5 dashboard switch flips this to false for human takeover.
          aiEnabled: true,
        }),
      });
      convId = conv.id;
    }

    const result = await chat(convId, text || "(sent a photo)", { media });

    return NextResponse.json({
      conversationId: convId,
      response: result.response,
      products: result.products,
      silent: result.silent,
      // Help-Center adapter support (2026-10-20): false only when the
      // business has no AI provider key configured (engine fallback path),
      // so server-side consumers can render their own honest degradation
      // instead of the widget-oriented fallback text. True otherwise.
      aiConfigured: result.aiConfigured !== false,
    });
  } catch (error) {
    logger.error("Widget chat failed:", error);
    return NextResponse.json({ error: "Failed to process message" }, { status: 500 });
  }
}


