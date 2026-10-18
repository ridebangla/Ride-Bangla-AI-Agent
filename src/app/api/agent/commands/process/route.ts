import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { cronAuth } from "@/lib/social/cron-auth";
import { processCommandQueue } from "@/lib/social/commands";
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
