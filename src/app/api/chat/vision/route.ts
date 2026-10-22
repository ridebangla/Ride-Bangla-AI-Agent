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
import { perceiveMedia, perceiveVideoFrames, type MediaInput } from "@/lib/ai/media";
import { resolveBehaviourLang, type BehaviourLang } from "@/lib/ai/behaviour";
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
 *     image?: { mimeType, base64 }, video?: { mimeType, base64 },
 *     frames?: [{ mimeType, base64 }] }
 *
 * With a provider key: the vision model describes what it sees, the
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
 * on the message. Size limits: image 4 MB, video 10 MB, frames 3 × 4 MB.
 *
 * Video (media fix 2026-10-22): server-side frame extraction needs
 * `ffmpeg` on the host (OPERATIONS.md), which Vercel serverless does not
 * have — so the widget now extracts representative frames IN THE BROWSER
 * and posts them as `frames`, and this endpoint perceives the frames
 * directly (perceiveVideoFrames). A raw `video` upload still takes the
 * ffmpeg path for hosts that have it (and degrades gracefully where
 * they don't). All user-facing replies are written in the conversation's
 * language (business setting, else the customer's own recent language).
 */
const VISION_RATE_LIMIT = { maxRequests: 10, windowMs: 60 * 1000 };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_FRAMES = 3;

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

/** User-facing strings for this endpoint, in the conversation's language.
 *  Functional state/error text only — mirrors the English source strings. */
function visionStrings(lang: BehaviourLang, kind: "image" | "video") {
  if (lang === "bn") {
    return {
      intro:
        kind === "image"
          ? "আপনার ছবিতে যা দেখতে পাচ্ছি:"
          : "আপনার ভিডিও থেকে যা বুঝতে পেরেছি:",
      outro: "আমাদের ক্যাটালগ থেকে এগুলো সবচেয়ে কাছাকাছি মিল মনে হচ্ছে:",
      noKey:
        kind === "image"
          ? "আমি এখনো ছবি দেখতে পারছি না — এআই ব্রেইন সংযুক্ত হয়নি। ব্যবসার মালিককে Settings-এ এআই API key যোগ করতে হবে। অনুগ্রহ করে আপনি যা খুঁজছেন তা লিখে বর্ণনা করুন।"
          : "আমি এখনো ভিডিও দেখতে পারছি না — এআই ব্রেইন সংযুক্ত হয়নি। ব্যবসার মালিককে Settings-এ এআই API key যোগ করতে হবে। অনুগ্রহ করে আপনি যা খুঁজছেন তা লিখে বর্ণনা করুন।",
      failed:
        kind === "image"
          ? "আমি এই মুহূর্তে ছবিটা দেখতে পারলাম না। আপনি যা খুঁজছেন তা লিখে বর্ণনা করবেন কি?"
          : "আমি ভিডিওটা দেখতে পারলাম না। আপনি যা প্রয়োজন তা লিখে বর্ণনা করুন, অথবা একটি ছবি পাঠিয়ে দেখুন।",
    };
  }
  return {
    intro:
      kind === "image"
        ? "Here's what I can see in your photo:"
        : "Here's what I understood from your video:",
    outro: "These look like the closest matches from our catalog:",
    noKey:
      `I can't view ${kind === "image" ? "photos" : "videos"} yet — the AI brain isn't connected. ` +
      `The business owner still needs to add the AI API key in Settings. ` +
      `Please describe what you're looking for in words instead.`,
    failed:
      kind === "video"
        ? "I couldn't watch that video on this server yet. Could you describe what you need in words, or send a photo instead?"
        : "I couldn't view that photo right now. Could you describe what you're looking for in words?",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteKey, visitorId, conversationId, image, video, frames } = body as {
      siteKey?: string;
      visitorId?: string;
      conversationId?: string;
      image?: Attachment;
      video?: Attachment;
      frames?: Attachment[];
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
    // Feature scope (B6 follow-up): a grant scoped away from "chat"
    // blocks with the same 402 shape. Unscoped accounts pass unchanged.
    if (sub.scopeAllowsChat === false) {
      logger.warn(
        `[billing] blocked vision upload for business ${business.id}: grant scope excludes chat`
      );
      return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
    }

    // Same identity rule as the widget chat route: "anonymous" is a
    // public constant, not an ownership proof — a missing/reserved
    // visitorId gets a server-generated unguessable identity.
    const suppliedVisitor =
      typeof visitorId === "string" ? visitorId.trim().slice(0, 64) : "";
    const visitor =
      suppliedVisitor && suppliedVisitor.toLowerCase() !== "anonymous"
        ? suppliedVisitor
        : `anon-${crypto.randomUUID()}`;
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
    const frameList = Array.isArray(frames)
      ? frames.filter((f) => !!f?.base64).slice(0, MAX_VIDEO_FRAMES)
      : [];
    const hasFrames = frameList.length > 0;
    const modeCount = [hasImage, hasVideo, hasFrames].filter(Boolean).length;
    if (modeCount !== 1) {
      return NextResponse.json(
        { error: "Provide exactly one of image, video or frames" },
        { status: 400 }
      );
    }

    // Validate + decode the attachment.
    let media: MediaInput | null = null;
    let frameInputs: Array<{ bytes: Buffer; mimeType: string }> = [];
    let mediaKind: "image" | "video" = "image";
    if (hasImage) {
      mediaKind = "image";
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
    } else if (hasFrames) {
      // Browser-extracted video frames (media fix 2026-10-22): each frame
      // is a plain image; the perception kind is "video".
      mediaKind = "video";
      for (const f of frameList) {
        const mimeType = typeof f.mimeType === "string" ? f.mimeType : "image/jpeg";
        if (!mimeType.startsWith("image/")) {
          return NextResponse.json({ error: "Video frames must be images" }, { status: 400 });
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(f.base64 as string, "base64");
        } catch {
          return NextResponse.json({ error: "Invalid frame data" }, { status: 400 });
        }
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
          return NextResponse.json({ error: "Video frame too large (max 4 MB)" }, { status: 400 });
        }
        frameInputs.push({ bytes, mimeType });
      }
    } else {
      mediaKind = "video";
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

      const config = await getAIConfig();

      // Conversation language for the user-facing replies below: the
      // business setting wins; under "auto", the customer's own most
      // recent message in this thread decides (media fix 2026-10-22 —
      // these replies used to be hardcoded English in every language).
      let lang: BehaviourLang = resolveBehaviourLang(config.language, "");
      try {
        const lastCustomer = await prisma.message.findFirst({
          where: { conversationId: convId, role: "customer" },
          orderBy: { createdAt: "desc" },
        });
        if (lastCustomer?.content) {
          lang = resolveBehaviourLang(config.language, lastCustomer.content);
        }
      } catch {
        /* language detection is best-effort */
      }
      const strings = visionStrings(lang, mediaKind);

      const customerNote = mediaKind === "image" ? "(sent a photo)" : "(sent a video)";
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

      const keys = await resolveSiteKeys();

      if (!hasAnyProviderKey(keys)) {
        // Graceful: the AI brain isn't connected — honest message, no crash.
        const reply = strings.noKey;
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
        const perception = hasFrames
          ? await perceiveVideoFrames(keys, config.model, frameInputs, catalogHint || undefined)
          : await perceiveMedia(keys, config.model, media as MediaInput, catalogHint || undefined);
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

        const intro = strings.intro;
        const outro = products.length > 0 ? strings.outro : "";
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
        // Includes the no-ffmpeg raw-video fallback: describeVideo()
        // throws a clear error when ffmpeg is missing (serverless) —
        // graceful reply in the conversation's language, never a 500.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn("[vision] perception failed", { kind: mediaKind, reason });
        const reply = strings.failed;
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
