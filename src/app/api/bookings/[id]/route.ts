/**
 * /api/bookings/[id] — Leg A (STAGED ONLY): human booking decisions.
 * GET   — one booking. Permission: bookings:read.
 * PATCH — move the booking state machine (confirm / propose another time /
 *         return / cancel). Permission: bookings:update — a HUMAN dashboard
 *         role. No agent tool calls this route, which is what makes
 *         "the agent never confirms" enforceable: the only path into
 *         `confirmed` is this human-authenticated PATCH.
 *         Body: { status, proposedSlot?, proposedDate?, proposedTime?,
 *                 reason?, note? }.
 *         Illegal transitions -> 409 with a machine code; missing
 *         reason/slot or bad date/time shape -> 400; unknown id (or
 *         another tenant's id — the read is tenant-scoped, so both fail
 *         closed the same way) -> 404.
 * LOCK NOTE: this route performs no locking and writes no audit record.
 * Leg B (lock) attaches its guard + audit trail at the `confirmed`
 * transition in setBookingStatus — see src/lib/bookings.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getBookingById, setBookingStatus } from "@/lib/bookings";
import type { BookingStatus } from "@/lib/bookings";

type RouteContext = { params: Promise<{ id: string }> };

const VALIDATION_CODES = new Set([
  "invalid_status",
  "proposed_slot_required",
  "reason_required",
  "bad_date_shape",
  "bad_time_shape",
]);

export async function GET(_request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(_request, "bookings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "Bookings belong to a business." }, { status: 403 });
  }
  return runWithBusiness(auth.businessId, async () => {
    try {
      const { id } = await context.params;
      const booking = await getBookingById(id);
      return NextResponse.json({ booking });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "P2025") {
        return NextResponse.json({ error: "Booking not found" }, { status: 404 });
      }
      logger.error("Failed to fetch booking:", error);
      return NextResponse.json({ error: "Failed to fetch booking" }, { status: 500 });
    }
  });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "bookings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "Bookings belong to a business." }, { status: 403 });
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { id } = await context.params;
      const body = await request.json();
      const status = String(body.status ?? "") as BookingStatus;
      const booking = await setBookingStatus(id, {
        to: status,
        proposedSlot: body.proposedSlot ?? null,
        proposedDate: body.proposedDate ?? null,
        proposedTime: body.proposedTime ?? null,
        reason: body.reason ?? null,
        note: body.note ?? null,
      });
      return NextResponse.json({ booking });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "P2025") {
        return NextResponse.json({ error: "Booking not found" }, { status: 404 });
      }
      if (code && VALIDATION_CODES.has(code)) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Invalid booking change", code },
          { status: 400 }
        );
      }
      if (code === "booking_terminal" || code === "transition_not_allowed") {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Booking change not allowed", code },
          { status: 409 }
        );
      }
      logger.error("Failed to update booking:", error);
      return NextResponse.json({ error: "Failed to update booking" }, { status: 500 });
    }
  });
}
