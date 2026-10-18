import { NextRequest, NextResponse } from "next/server";
import { processDueFollowUps } from "@/lib/followups";
import { logger } from "@/lib/logger";
import { runWithBusiness } from "@/lib/prisma";

/**
 * POST /api/followups/process — cron endpoint. Delivers due follow-ups
 * (scheduled via the schedule_followup AI tool) through each conversation's
 * channel. Auth: `Authorization: Bearer <CRON_SECRET>` + `?business=<slug>`
 * is NOT needed here (the processor iterates all businesses itself), so this
 * endpoint accepts the cron secret alone or an admin session.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";
  const cronOk = !!secret && header === `Bearer ${secret}`;

  if (!cronOk) {
    // Fall back to admin auth (permission-gated).
    const { requireAuth, isAuthenticated } = await import("@/lib/route-auth");
    const auth = await requireAuth(request, "conversations:update");
    if (!isAuthenticated(auth)) return auth;
  }

  try {
    const result = await processDueFollowUps();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logger.error("Follow-up processing failed:", error);
    return NextResponse.json({ error: "Failed to process follow-ups" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const { requireAuth, isAuthenticated } = await import("@/lib/route-auth");
  const auth = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(auth)) return auth;

  const { prisma, runWithBusiness } = await import("@/lib/prisma");
  return runWithBusiness(auth.businessId, async () => {
    const items = await prisma.followUp.findMany({
      orderBy: { dueAt: "desc" },
      take: 50,
    });
    return NextResponse.json(items);
  });
}
