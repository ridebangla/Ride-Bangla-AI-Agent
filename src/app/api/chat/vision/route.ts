import { NextRequest, NextResponse } from "next/server";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { getSubscription } from "@/lib/subscription";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma, runWithBusiness, withBusinessId } from "@/lib/prisma";
import { getAIConfig, type ProductCard } from "@/lib/ai/engine";
import {
  hasAnyProviderKey,
  resolveSiteKeys,
} from "@/lib/ai/providers";
import { perceiveMedia, type MediaInput } from "@/lib/ai/media";
import {
  getCatalogBrief,
  matchProductsInMessage,
  type CatalogProduct,
} from "@/lib/catalog";
import { logger } from "@/lib/logger";
import { parseActivityToken, bindActivityToken } from "@/lib/ai/activity";

/**
 * Phase 3 — photo/video understanding endpoint (user decisions 14 + 15).
 *
 * The widget POSTs a customer photo or short video here:
 *   { siteKey, visitorId?, conversationId?,
 *     image?: { mimeType, base64 }, video?: { mimeType, base64 } }
 *
 * With an OpenAI key: the vision model describes what it sees, the
 * description is matched (deterministic text similarity, no new deps)
 * against the tenant's catalog, and the top 3 matches come back as product
 * cards rendered in the chat.
 *
 * Without a key: graceful "I can't view images yet" — stored, no crash,
 * no faked understanding.
 *
 * Upload lifecycle: media arrives as base64, is decoded to an in-memory
 * Buffer, processed, and never persisted — video frame extraction writes
 * temp files under os.tmpdir() and deletes them in a finally block
 * (see src/lib/ai/media.ts). Only a text note ("(sent a photo)") is stored
 * on the message. Size limits: image 4 MB, video 10 MB.
 *
 * Video fallback (documented): frame extraction needs `ffmpeg` on the host
 * (OPERATIONS.md). Vercel serverless has no ffmpeg, so describeVideo()
 * throws a clear error there and this endpoint returns a graceful
 * "couldn't watch the video" reply instead of a 500.
 */
const VISION_RATE_LIMIT = { maxRequests: 10, windowMs: 60 * 1000 };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;

type Attachment = { mimeType?: string; base64?: string };

function toProductCard(p: CatalogProduct): ProductCard {
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    imageUrl: p.imageUrl,
    description: p.description,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteKey, visitorId, conversationId, image, video } = body as {
      siteKey?: string;
      visitorId?: string;
      conversationId?: string;
      image?: Attachment;
      video?: Attachment;
    };
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

    // Subscription hard-stop BEFORE any vision/LLM spend (user decision 16).
    const sub = await getSubscription(business.id);
    if (!sub.isActive) {
      logger.warn(
        `[billing] blocked vision upload for business ${business.id}: subscription inactive`
      );
      return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
    }

    const visitor =
      typeof visitorId === "string" && visitorId.trim()
        ? visitorId.trim().slice(0, 64)
        : "anonymous";
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const rl = checkRateLimit(`vision:${siteKey}:${visitor}`, VISION_RATE_LIMIT);
    const rlIp = checkRateLimit(`vision-ip:${siteKey}:${clientIp}`, { maxRequests: 30, windowMs: 60 * 1000 });
    if (!rl.allowed || !rlIp.allowed) {
      return NextResponse.json(
        { error: "Too many uploads. Please wait a moment and try again." },
        { status: 429 }
      );
    }

    const hasImage = !!image?.base64;
    const hasVideo = !!video?.base64;
    if (hasImage === hasVideo) {
      return NextResponse.json(
        { error: "Provide exactly one of image or video" },
        { status: 400 }
      );
    }

    // Validate + decode the attachment.
    let media: MediaInput;
    if (hasImage) {
      const mimeType =
        typeof image!.mimeType === "string" ? image!.mimeType : "image/jpeg";
      if (!mimeType.startsWith("image/")) {
        return NextResponse.json({ error: "Only image uploads are supported here" }, { status: 400 });
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(image!.base64 as string, "base64");
      } catch {
        return NextResponse.json({ error: "Invalid image data" }, { status: 400 });
      }
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "Image too large (max 4 MB)" }, { status: 400 });
      }
      media = { kind: "image", mimeType, bytes };
    } else {
      const mimeType =
        typeof video!.mimeType === "string" ? video!.mimeType : "video/mp4";
      if (!mimeType.startsWith("video/")) {
        return NextResponse.json({ error: "Only video uploads are supported here" }, { status: 400 });
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(video!.base64 as string, "base64");
      } catch {
        return NextResponse.json({ error: "Invalid video data" }, { status: 400 });
      }
      if (bytes.length === 0 || bytes.length > MAX_VIDEO_BYTES) {
        return NextResponse.json({ error: "Video too large (max 10 MB)" }, { status: 400 });
      }
      media = { kind: "video", mimeType, bytes };
    }

    // All tenant-scoped work runs inside runWithBusiness — never rely on
    // enterWith() across await boundaries.
    return await runWithBusiness(business.id, async () => {
      // Find or create the visitor's conversation (same ownership rule as
      // the widget chat: one visitor cannot read another's thread).
      let convId = typeof conversationId === "string" ? conversationId : "";
      let takeover = false;
      if (convId) {
        const existing = await prisma.conversation.findUnique({ where: { id: convId } });
        if (!existing || existing.customerContact !== visitor) {
          convId = "";
        } else {
          // Human takeover (user decision 17): owner switched the AI off —
          // store the message below and stay silent, no AI reply of any kind.
          takeover = existing.aiEnabled === false;
          if (activityToken) {
            await bindActivityToken(convId, activityToken, existing.activityToken);
          }
        }
      }
      if (!convId) {
        const conv = await prisma.conversation.create({
          data: withBusinessId({
            channel: "widget",
            customerName: "Website Visitor",
            customerContact: visitor,
            status: "open",
            ...(activityToken ? { activityToken } : {}),
            aiEnabled: true,
          }),
        });
        convId = conv.id;
      }

      const customerNote = media.kind === "image" ? "(sent a photo)" : "(sent a video)";
      await prisma.message.create({
        data: withBusinessId({
          conversationId: convId,
          role: "customer",
          content: customerNote,
        }),
      });

      // Human takeover (user decision 17): the stored flag from the lookup
      // above — stay in pure silence, no AI-generated reply of any kind.
      if (takeover) {
        return NextResponse.json({
          conversationId: convId,
          response: "",
          products: [],
          silent: true,
        });
      }

      const config = await getAIConfig();
      const keys = await resolveSiteKeys();

      if (!hasAnyProviderKey(keys)) {
        // Graceful: the AI brain isn't connected — honest message, no crash.
        const label = media.kind === "image" ? "photos" : "videos";
        const reply =
          `I can't view ${label} yet — the AI brain isn't connected. ` +
          `The business owner still needs to add the AI API key in Settings. ` +
          `Please describe what you're looking for in words instead.`;
        await prisma.message.create({
          data: withBusinessId({
            conversationId: convId,
            role: "assistant",
            content: reply,
          }),
        });
        return NextResponse.json({
          conversationId: convId,
          response: reply,
          products: [],
          silent: false,
        });
      }

      try {
        const catalogHint = await getCatalogBrief().catch(() => "");
        const perception = await perceiveMedia(
          keys,
          config.model,
          media,
          catalogHint || undefined
        );
        const seen = perception.description.replace(/^\[(Photo|Video)\]:\s*/, "");

        // Photo-to-catalog matching (user decision 15): deterministic text
        // similarity over name/description/tags — no new dependencies.
        let products: ProductCard[] = [];
        try {
          products = (await matchProductsInMessage(perception.description, 3)).map(
            toProductCard
          );
        } catch (matchErr) {
          logger.warn("[vision] catalog matching failed", {
            reason: matchErr instanceof Error ? matchErr.message : String(matchErr),
          });
        }

        const intro =
          media.kind === "image"
            ? "Here's what I can see in your photo:"
            : "Here's what I understood from your video:";
        const outro =
          products.length > 0
            ? "These look like the closest matches from our catalog:"
            : "";
        const reply = [intro, seen, outro].filter(Boolean).join("\n\n");

        await prisma.message.create({
          data: withBusinessId({
            conversationId: convId,
            role: "assistant",
            content: reply,
          }),
        });

        return NextResponse.json({
          conversationId: convId,
          response: reply,
          products,
          silent: false,
        });
      } catch (err) {
        // Includes the no-ffmpeg video fallback: describeVideo() throws a
        // clear error when ffmpeg is missing (serverless) — graceful reply,
        // never a 500.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn("[vision] perception failed", { kind: media.kind, reason });
        const reply =
          media.kind === "video"
            ? "I couldn't watch that video on this server yet. Could you describe what you need in words, or send a photo instead?"
            : "I couldn't view that photo right now. Could you describe what you're looking for in words?";
        await prisma.message.create({
          data: withBusinessId({
            conversationId: convId,
            role: "assistant",
            content: reply,
          }),
        });
        return NextResponse.json({
          conversationId: convId,
          response: reply,
          products: [],
          silent: false,
        });
      }
    });
  } catch (error) {
    logger.error("Vision endpoint failed:", error);
    return NextResponse.json({ error: "Failed to process media" }, { status: 500 });
  }
}
