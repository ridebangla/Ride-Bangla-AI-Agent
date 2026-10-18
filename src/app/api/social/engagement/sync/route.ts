import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { cronAuth } from "@/lib/social/cron-auth";
import { syncEngagement } from "@/lib/social/engagement";

/**
 * Cron/sync endpoint: pull new comments and messages from all connected
 * social accounts and reply to every one of them.
 *   POST /api/social/engagement/sync
 *     Authorization: Bearer <CRON_SECRET>
 *     ?business=<slug>
 */
export async function POST(request: NextRequest) {
  const auth = await cronAuth(request, "automation:create");
  if (auth !== true) return auth;

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
}
