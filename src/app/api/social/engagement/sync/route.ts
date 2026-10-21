import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { cronAuth } from "@/lib/social/cron-auth";
import { syncEngagement } from "@/lib/social/engagement";
import { getSubscription } from "@/lib/subscription";
import { runWithBusiness } from "@/lib/prisma";

/**
 * Cron/sync endpoint: pull new comments and messages from all connected
 * social accounts and reply to every one of them.
 *   POST /api/social/engagement/sync
 *     Authorization: Bearer <CRON_SECRET>
 *     ?business=<slug>
 */
export async function POST(request: NextRequest) {
  const auth = await cronAuth(request, "automation:create");
  if (auth instanceof NextResponse) return auth;
  // Subscription hard-stop (user decision 16 + owner rule 2026-10-22):
  // this processor spends AI tokens, so a genuinely inactive business
  // (suspended / canceled / past_due) is stopped here too. Internal,
  // in-trial, free-tier and paid-active businesses all pass
  // getSubscription().isActive — only inactive states stop.
  const sub = await getSubscription(auth.businessId);
  if (!sub.isActive) {
    return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const result = await syncEngagement();
      return NextResponse.json(result);
    } catch (error) {
      logger.error("Engagement sync failed:", error);
      return NextResponse.json(
        { error: "Failed to sync engagement" },
        { status: 500 }
      );
    }
  });
}
