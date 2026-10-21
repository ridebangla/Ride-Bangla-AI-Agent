import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBusinessBySiteKey, enterBusinessContext } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";

/**
 * Public widget thread-read endpoint.
 *
 * The embed polls this while its panel is open so a conversation can
 * continue in the SAME thread when a human takes over: staff replies
 * written from the dashboard Inbox are stored on the conversation
 * (deliver.ts: for widget/api channels the reply is "stored — visible
 * in the website chat"), but until this endpoint existed the embed had
 * no way to read them back — it only ever rendered the direct response
 * of its own POST. This route is that read path.
 *
 * Auth model (identical to the other public embed endpoints): the
 * business's public `siteKey` identifies the tenant, and the caller
 * must prove it owns the thread with the same (conversationId +
 * visitorId) pair the chat endpoint requires — the conversation's
 * `customerContact` must equal the supplied visitorId. A thread the
 * caller cannot prove ownership of returns an empty message list, not
 * an error, so the endpoint leaks nothing about other visitors'
 * conversations (not even whether an id exists).
 *
 * Response: the thread's latest messages (oldest first), with roles
 * mapped to the embed's two sides, plus the conversation's `aiEnabled`
 * flag so the embed can tell the visitor a human is handling the
 * thread when the owner has taken over.
 */
const THREAD_RATE_LIMIT = { maxRequests: 120, windowMs: 60 * 1000 };
const MAX_MESSAGES = 100;

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const siteKey = params.get("siteKey") || "";
    const conversationId = params.get("conversationId") || "";
    const visitorId = params.get("visitorId") || "";

    if (!siteKey) {
      return NextResponse.json({ error: "siteKey is required" }, { status: 401 });
    }
    const business = await getBusinessBySiteKey(siteKey);
    if (!business) {
      return NextResponse.json({ error: "Invalid site key" }, { status: 401 });
    }

    if (!conversationId || !visitorId) {
      return NextResponse.json(
        { error: "conversationId and visitorId are required" },
        { status: 400 }
      );
    }

    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const rl = checkRateLimit(
      `widget-thread:${siteKey}:${visitorId || clientIp}`,
      THREAD_RATE_LIMIT
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a moment." },
        { status: 429 }
      );
    }

    enterBusinessContext(business.id);

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (
      !conversation ||
      conversation.channel !== "widget" ||
      conversation.customerContact !== visitorId
    ) {
      // Unknown / not-owned / not-a-widget thread: an empty thread.
      return NextResponse.json({ messages: [], aiEnabled: true });
    }

    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: MAX_MESSAGES,
    });

    const messages = rows
      .reverse()
      .map((message: { id: string; role: string; content: string; createdAt: Date }) => ({
        id: message.id,
        role: message.role === "customer" ? "customer" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
      }));

    return NextResponse.json({
      messages,
      aiEnabled: conversation.aiEnabled !== false,
    });
  } catch (error) {
    logger.error("Widget thread lookup failed:", error);
    return NextResponse.json({ messages: [], aiEnabled: true });
  }
}
