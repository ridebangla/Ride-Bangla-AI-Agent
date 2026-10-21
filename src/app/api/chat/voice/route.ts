import { NextRequest, NextResponse } from "next/server";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { getSubscription } from "@/lib/subscription";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma, runWithBusiness, withBusinessId } from "@/lib/prisma";
import { chat } from "@/lib/ai/engine";
import {
  hasAnyProviderKey,
  resolveSiteKeys,
} from "@/lib/ai/providers";
import { transcribeAudio } from "@/lib/ai/media";
import { logger } from "@/lib/logger";
import { checkMessageLimitExceeded } from "@/lib/billing-usage";
import { parseActivityToken, bindActivityToken } from "@/lib/ai/activity";

/**
 * Phase 3 — voice message endpoint (user decision 14).
 *
 * The widget POSTs a recorded voice note here:
 *   { siteKey, visitorId?, conversationId?, audio: { mimeType, base64 } }
 *
 * With an OpenAI key: the audio is transcribed with Whisper and the
 * transcript is fed into the normal chat pipeline as the customer's text —
 * same brain, same tools, same product cards, same order flow.
 *
 * Without a key: graceful "I can't listen yet" — stored, no crash.
 *
 * Upload lifecycle: audio arrives as base64, is decoded to an in-memory
 * Buffer, transcribed, and never persisted anywhere. Only the transcript
 * (or a "(sent a voice message)" note when transcription isn't possible) is
 * stored on the message. Size limit: 10 MB.
 */
const VOICE_RATE_LIMIT = { maxRequests: 10, windowMs: 60 * 1000 };
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteKey, visitorId, conversationId, audio } = body as {
      siteKey?: string;
      visitorId?: string;
      conversationId?: string;
      audio?: { mimeType?: string; base64?: string };
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

    // Subscription hard-stop BEFORE any Whisper/LLM spend (user decision 16).
    const sub = await getSubscription(business.id);
    if (!sub.isActive) {
      logger.warn(
        `[billing] blocked voice upload for business ${business.id}: subscription inactive`
      );
      return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
    }

    if (await checkMessageLimitExceeded(business.id)) {
      return NextResponse.json({ error: "message_limit_reached" }, { status: 402 });
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
    const rl = checkRateLimit(`voice:${siteKey}:${visitor}`, VOICE_RATE_LIMIT);
    const rlIp = checkRateLimit(`voice-ip:${siteKey}:${clientIp}`, { maxRequests: 30, windowMs: 60 * 1000 });
    if (!rl.allowed || !rlIp.allowed) {
      return NextResponse.json(
        { error: "Too many voice messages. Please wait a moment and try again." },
        { status: 429 }
      );
    }

    if (!audio?.base64) {
      return NextResponse.json({ error: "audio is required" }, { status: 400 });
    }
    const mimeType =
      typeof audio.mimeType === "string" && audio.mimeType
        ? audio.mimeType
        : "audio/webm";
    if (!mimeType.startsWith("audio/")) {
      return NextResponse.json({ error: "Only audio uploads are supported here" }, { status: 400 });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(audio.base64, "base64");
    } catch {
      return NextResponse.json({ error: "Invalid audio data" }, { status: 400 });
    }
    if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        { error: "Audio too large (max 10 MB)" },
        { status: 400 }
      );
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

      // Human takeover (user decision 17): store the note and stay silent.
      if (takeover) {
        await prisma.message.create({
          data: withBusinessId({
            conversationId: convId,
            role: "customer",
            content: "(sent a voice message)",
          }),
        });
        return NextResponse.json({
          conversationId: convId,
          response: "",
          products: [],
          silent: true,
        });
      }

      const keys = await resolveSiteKeys();

      if (!hasAnyProviderKey(keys)) {
        // Graceful: no Whisper without a key. The chat pipeline stores the
        // customer note and returns the honest message (never a fake reply).
        const result = await chat(convId, "(sent a voice message)");
        return NextResponse.json({
          conversationId: convId,
          response:
            "I can't listen to voice messages yet — the AI brain isn't connected. " +
            "The business owner still needs to add the AI API key in Settings. " +
            "Please type your message instead.",
          products: result.products,
          silent: result.silent,
        });
      }

      let transcript: string;
      try {
        transcript = await transcribeAudio(keys, bytes, mimeType);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn("[voice] transcription failed", { reason });
        const reply =
          "I couldn't understand that voice message. Could you try recording again, or type it instead?";
        await prisma.message.create({
          data: withBusinessId({
            conversationId: convId,
            role: "customer",
            content: "(sent a voice message — transcription failed)",
          }),
        });
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

      // Feed the transcript into the normal chat pipeline as the customer's
      // text — same brain, tools, product cards, and order flow.
      const result = await chat(convId, transcript);
      return NextResponse.json({
        conversationId: convId,
        response: result.response,
        products: result.products,
        silent: result.silent,
        transcript,
      });
    });
  } catch (error) {
    logger.error("Voice endpoint failed:", error);
    return NextResponse.json({ error: "Failed to process audio" }, { status: 500 });
  }
}
