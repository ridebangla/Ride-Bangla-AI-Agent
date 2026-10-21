import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { cronAuth } from "@/lib/social/cron-auth";
import { processCommandQueue } from "@/lib/social/commands";
import { getSubscription } from "@/lib/subscription";
import { runWithBusiness } from "@/lib/prisma";

/**
 * Process one queued admin command.
 *   POST /api/agent/commands/process
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
      const result = await processCommandQueue();
      return NextResponse.json(result);
    } catch (error) {
      logger.error("Command queue processing failed:", error);
      return NextResponse.json(
        { error: "Failed to process command queue" },
        { status: 500 }
      );
    }
  });
}
