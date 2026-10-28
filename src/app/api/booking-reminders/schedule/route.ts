/**
 * POST /api/booking-reminders/schedule — LEG D (booking batch), STAGED ONLY.
 * Repo path when applied: src/app/api/booking-reminders/schedule/route.ts
 *
 * Cron endpoint: scan confirmed orders and schedule any missing
 * booking-reminder records (idempotent — see booking-reminder-
 * scheduler.ts). Auth mirrors POST /api/followups/process exactly:
 * `Authorization: Bearer <CRON_SECRET>` or an admin session with
 * `conversations:update`. No GET: the dashboard already lists
 * follow-up records via GET /api/followups/process, and these
 * records (kind "booking_reminder") appear there with no new UI.
 *
 * This route schedules; it does not send. Sending stays in the
 * follow-ups processor, so reminders share one delivery loop, one
 * tenant context, and one set of channel rules.
 */

import { NextRequest, NextResponse } from "next/server";
import { scanAndScheduleConfirmedBookings } from "@/lib/booking-reminder-scheduler";
import { logger } from "@/lib/logger";

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
    const result = await scanAndScheduleConfirmedBookings();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    logger.error("Booking-reminder scheduling failed:", error);
    return NextResponse.json(
      { error: "Failed to schedule booking reminders" },
      { status: 500 }
    );
  }
}
