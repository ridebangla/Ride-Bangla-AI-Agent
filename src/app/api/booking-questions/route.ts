/**
 * /api/booking-questions — Leg A (STAGED ONLY): the per-business booking
 * question builder. Mirrors /api/order-fields, but for bookings only.
 *
 * GET — { bookingQuestions: BookingQuestion[] } for the tenant.
 * PUT — { bookingQuestions: BookingQuestion[] } replaces the definition
 *       set (validated by validateBookingQuestions in @/lib/booking-state).
 *
 * Stored on `businesses.bookingQuestions`. Permission: settings:read /
 * settings:update (business-level config, admin only — same audience as
 * order-fields). Updated via the UNSCOPED client with an explicit
 * `where: { id: auth.businessId }` — fail-closed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  validateBookingQuestions,
} from "@/lib/booking-state";
import {
  DEFAULT_BOOKING_QUESTIONS,
} from "@/lib/bookings";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const business = (await getUnscopedPrisma().business.findUnique({
        where: { id: auth.businessId },
        select: { bookingQuestions: true },
      })) as { bookingQuestions?: unknown } | null;
      let bookingQuestions: unknown[] = [];
      try {
        bookingQuestions = validateBookingQuestions(business?.bookingQuestions ?? []);
      } catch {
        bookingQuestions = [];
      }
      return NextResponse.json({
        bookingQuestions,
        defaults: DEFAULT_BOOKING_QUESTIONS,
      });
    } catch (error) {
      logger.error("Failed to fetch booking questions:", error);
      return NextResponse.json(
        { error: "Failed to fetch booking questions" },
        { status: 500 }
      );
    }
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }
  // Capture after the guard: TS resets property narrowing inside the
  // runWithBusiness callback, so the callback must use this const.
  const businessId = auth.businessId;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const { setBookingQuestions } = await import("@/lib/bookings");
      const bookingQuestions = await setBookingQuestions(
        businessId,
        body.bookingQuestions ?? []
      );
      return NextResponse.json({ bookingQuestions });
    } catch (error) {
      logger.error("Failed to save booking questions:", error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to save booking questions" },
        { status: 400 }
      );
    }
  });
}
