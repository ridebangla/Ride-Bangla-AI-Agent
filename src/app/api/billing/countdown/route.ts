import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { logger } from "@/lib/logger";
import { getBillingCountdown } from "@/lib/billing-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/billing/countdown — subscription + usage countdown for the tenant.
 *
 * Success: 200 {
 *   plan, daysRemaining, messagesRemaining, messagesLimit, percentUsed,
 *   notices: [{ type: 'days'|'usage', threshold, ... }]  // breached only
 *   adminNotice: { message, createdAt, createdBy } | null,
 *   subscriptionEndsAt
 * }
 * Thresholds: days 7/3/1, usage 80/100 — only breached ones are included,
 * so an empty `notices` array means "nothing to warn about".
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;

  if (!auth.businessId) {
    return NextResponse.json(
      {
        error: "no_billing_account",
        message: "Platform administrators are never billed.",
      },
      { status: 400 }
    );
  }

  try {
    const countdown = await getBillingCountdown(auth.businessId);
    if (!countdown) {
      return NextResponse.json(
        { error: "unknown_business", message: "Business not found." },
        { status: 404 }
      );
    }
    return NextResponse.json({
      ...countdown,
      subscriptionEndsAt: countdown.subscriptionEndsAt
        ? countdown.subscriptionEndsAt.toISOString()
        : null,
      adminNotice: countdown.adminNotice
        ? {
            ...countdown.adminNotice,
            createdAt: countdown.adminNotice.createdAt
              ? countdown.adminNotice.createdAt.toISOString()
              : null,
          }
        : null,
    });
  } catch (err) {
    logger.error("billing countdown failed", {
      businessId: auth.businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: "countdown_unavailable",
        message: "We could not load your billing status right now.",
      },
      { status: 500 }
    );
  }
}
