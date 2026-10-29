import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { prisma, runWithBusiness, withBusinessId } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Reply feedback endpoint (widget media+feedback batch, 2026-10-29).
 *
 * The widget POSTs one tap per AI reply — no form, no comment field:
 *   { siteKey, visitorId, conversationId, value: "like" | "dislike",
 *     replyText: string }
 *
 * Auth: the business's public `siteKey` (same as the widget chat and
 * vision routes — it identifies the business, grants no admin powers).
 * The conversation must belong to the same visitor, or the tap is
 * rejected: one visitor cannot vote on another visitor's thread.
 *
 * Identity rule (deliberately stricter than the voice route): a
 * missing or reserved ("anonymous") visitorId is REJECTED (400),
 * never minted into a fresh id — a minted id would break the
 * one-feedback-per-visitor-per-reply dedupe and let one tap count
 * many times. The widget always sends its persisted visitorId
 * (localStorage, generated once at init), so a real tap always has one.
 *
 * Dedupe: one record per (business, conversation, replyHash, visitor).
 * A changed mind (like -> dislike or the reverse) UPDATES the same
 * record instead of stacking rows, so admin counts stay honest.
 * replyHash is a SHA-256 of the reply text: the widget never sends a
 * server message id (chat/vision/voice responses carry none), and the
 * text itself is what the owner reads in the admin view.
 *
 * No subscription gate: feedback is not LLM spend, and a dislike on a
 * reply that arrived before a pause must still be recordable.
 * Rate limit: 30 taps/minute per (siteKey + visitor), in-memory.
 *
 * Storage: `chatFeedback` collection via the Firestore-backed prisma
 * shim (Admin SDK server-side). The collection's client-rules text is
 * supplied in the batch REPORT for the ONE final rules build — this
 * route does not need a rules deploy to work, and none is included
 * in the pairs.
 */
const FEEDBACK_RATE_LIMIT = { maxRequests: 30, windowMs: 60 * 1000 };
const MAX_REPLY_TEXT = 2000;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteKey, visitorId, conversationId, value, replyText } = body as {
      siteKey?: string;
      visitorId?: string;
      conversationId?: string;
      value?: string;
      replyText?: string;
    };

    if (!siteKey || typeof siteKey !== "string") {
      return NextResponse.json({ error: "siteKey is required" }, { status: 401 });
    }
    if (value !== "like" && value !== "dislike") {
      return NextResponse.json({ error: "value must be like or dislike" }, { status: 400 });
    }
    if (typeof replyText !== "string" || replyText.trim().length === 0) {
      return NextResponse.json({ error: "replyText is required" }, { status: 400 });
    }
    const cleanReply = replyText.trim().slice(0, MAX_REPLY_TEXT);
    const suppliedVisitor =
      typeof visitorId === "string" ? visitorId.trim().slice(0, 64) : "";
    if (!suppliedVisitor || suppliedVisitor.toLowerCase() === "anonymous") {
      return NextResponse.json({ error: "visitorId is required" }, { status: 400 });
    }
    if (typeof conversationId !== "string" || !conversationId) {
      return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
    }

    const business = await getBusinessBySiteKey(siteKey);
    if (!business) {
      return NextResponse.json({ error: "Invalid site key" }, { status: 401 });
    }

    const rl = checkRateLimit(
      `feedback:${siteKey}:${suppliedVisitor}`,
      FEEDBACK_RATE_LIMIT
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many feedback taps. Please wait a moment and try again." },
        { status: 429 }
      );
    }

    const replyHash = createHash("sha256").update(cleanReply).digest("hex");

    return await runWithBusiness(business.id, async () => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!conv || conv.customerContact !== suppliedVisitor) {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }

      const record = await prisma.chatFeedback.upsert({
        where: {
          businessId: business.id,
          conversationId,
          replyHash,
          visitorId: suppliedVisitor,
        },
        update: {
          value,
          replyText: cleanReply,
        },
        create: withBusinessId({
          conversationId,
          visitorId: suppliedVisitor,
          value,
          replyText: cleanReply,
          replyHash,
        }),
      });

      return NextResponse.json({
        ok: true,
        value: (record as { value?: string }).value ?? value,
      });
    });
  } catch (error) {
    logger.error("Feedback endpoint failed:", error);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
