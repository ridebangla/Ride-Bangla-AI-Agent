import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBusinessBySiteKey, enterBusinessContext } from "@/lib/tenant";
import { isCompanyBusiness } from "@/lib/company-identity";
import { prisma } from "@/lib/prisma";
import { parseActivityToken } from "@/lib/ai/activity";
import { isFreshActivity } from "@/lib/ai/activity-labels";

/**
 * Public widget live-activity endpoint.
 *
 * The embed polls this while a chat/vision/voice request is in flight so
 * the caption under the agent avatar can say what the agent is REALLY
 * doing ("Searching the catalog…", "Creating a support ticket…") instead
 * of a generic spinner. The value comes straight from the conversation's
 * `liveActivity` field, which the engine writes at the actual execution
 * points (see lib/ai/activity.ts) — this route only reads it back.
 *
 * Auth model (same as the other public embed endpoints): the business's
 * public `siteKey` identifies the tenant; the caller must then prove it
 * owns the conversation thread, either with the per-page-session
 * `activityToken` the chat endpoints bound to the conversation, or with
 * the same (conversationId + visitorId) pair the chat endpoint requires.
 * The response contains NOTHING but the current activity — no message
 * content, no customer data.
 *
 * Stale entries (a turn that died mid-action) are hidden by the shared
 * freshness window in activity-labels.
 */
const ACTIVITY_RATE_LIMIT = { maxRequests: 120, windowMs: 60 * 1000 };

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const siteKey = params.get("siteKey") || "";
    const conversationId = params.get("conversationId") || "";
    const visitorId = params.get("visitorId") || "";
    const token = parseActivityToken(params.get("token"));

    if (!siteKey) {
      return NextResponse.json({ error: "siteKey is required" }, { status: 401 });
    }
    const business = await getBusinessBySiteKey(siteKey);
    if (!business) {
      return NextResponse.json({ error: "Invalid site key" }, { status: 401 });
    }

    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    // B7+B9: verified company traffic is exempt — identity is the
    // server-resolved business record behind the siteKey, checked
    // through the estate-scoped company identity (projection flag OR
    // shared company_identity list), never a client value.
    const rl: { allowed: boolean } = (await isCompanyBusiness(business))
      ? { allowed: true }
      : checkRateLimit(
          `widget-activity:${siteKey}:${token || visitorId || clientIp}`,
          ACTIVITY_RATE_LIMIT
        );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a moment." },
        { status: 429 }
      );
    }

    if (!conversationId && !token) {
      return NextResponse.json(
        { error: "conversationId or token is required" },
        { status: 400 }
      );
    }

    enterBusinessContext(business.id);

    let conversation: {
      channel?: string;
      customerContact?: string;
      activityToken?: unknown;
      liveActivity?: unknown;
    } | null = null;

    if (conversationId) {
      conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });
      if (conversation) {
        // Ownership: token match OR the chat endpoint's visitor match.
        const tokenOk = !!token && conversation.activityToken === token;
        const visitorOk =
          !!visitorId && conversation.customerContact === visitorId;
        if (!tokenOk && !visitorOk) conversation = null;
      }
    }
    if (!conversation && token) {
      conversation = await prisma.conversation.findFirst({
        where: { activityToken: token },
        orderBy: { updatedAt: "desc" },
      });
    }

    if (!conversation || conversation.channel !== "widget") {
      // Unknown / not-owned / not-a-widget thread: no activity to show.
      // (Not an error — the caption simply stays generic.)
      return NextResponse.json({ activity: null });
    }

    const activity = isFreshActivity(conversation.liveActivity)
      ? {
          kind: conversation.liveActivity.kind,
          channel: conversation.liveActivity.channel ?? null,
        }
      : null;

    return NextResponse.json({ activity });
  } catch (error) {
    logger.error("Widget activity lookup failed:", error);
    return NextResponse.json({ activity: null });
  }
}
