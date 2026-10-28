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
    // Leg I: delivered-order review scan (fail-soft — a scan failure
    // never fails the cron response; see processDeliveredReviewScan
    // below). Additive `reviewScan` field; existing fields unchanged.
    let reviewScan = null;
    try {
      reviewScan = await processDeliveredReviewScan();
    } catch (err) {
      logger.warn("[followups] delivered-review scan failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
      reviewScan = { scanned: 0, queued: 0, skipped: 0, reasons: {} };
    }
    return NextResponse.json({ success: true, ...result, reviewScan });
  } catch (error) {
    logger.error("Follow-up processing failed:", error);
    return NextResponse.json({ error: "Failed to process follow-ups" }, { status: 500 });
  }
}

/**
 * Leg I: scan every active business for confirmed, chat-linked orders
 * whose courier phase is exactly "delivered", and queue ONE review
 * follow-up per such order due 24h after this first observation
 * (see scanBusinessDeliveredReviews in @/lib/order-rating-requests).
 * The scan itself is per-business tenant-scoped (runWithBusiness),
 * mirroring processDueFollowUps; one business's failure never stops
 * the others. Dynamic imports follow this file's existing precedent
 * (the GET handler below) so no top-level import changes are needed.
 */
async function processDeliveredReviewScan(): Promise<{
  scanned: number;
  queued: number;
  skipped: number;
  reasons: Record<string, number>;
}> {
  const { prisma, withBusinessId, getUnscopedPrisma, runWithBusiness } = await import("@/lib/prisma");
  const { prismaRatingStore, scanBusinessDeliveredReviews } = await import("@/lib/order-rating-requests");
  const { getCourierDeliveryStatus } = await import("@/lib/courier-bridge");
  const raw = getUnscopedPrisma();
  const businesses = await raw.business.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  const totals = { scanned: 0, queued: 0, skipped: 0, reasons: {} as Record<string, number> };
  for (const b of businesses) {
    try {
      const r = await runWithBusiness(b.id, async () => {
        const store = {
          ...prismaRatingStore(prisma, withBusinessId),
          readCourierPhase: async (orderId: string) => {
            try {
              const s = await getCourierDeliveryStatus(orderId);
              return s?.phase ?? null;
            } catch {
              return null;
            }
          },
        };
        return scanBusinessDeliveredReviews(store);
      });
      totals.scanned += r.scanned;
      totals.queued += r.queued;
      totals.skipped += r.skipped;
      for (const [reason, count] of Object.entries(r.reasons)) {
        totals.reasons[reason] = (totals.reasons[reason] ?? 0) + count;
      }
    } catch (err) {
      logger.warn("[followups] delivered-review scan business failed", {
        businessId: b.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return totals;
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
