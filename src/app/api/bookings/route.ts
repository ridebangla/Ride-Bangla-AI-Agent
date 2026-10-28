/**
 * /api/bookings — Leg A (STAGED ONLY): tenant-scoped booking requests.
 * GET  — latest 100 bookings, newest first. Permission: bookings:read.
 *        ?status=<one of the booking states> filters; an unknown status
 *        value is a 400 (never a silent unfiltered list).
 * POST — dashboard manual creation of a booking REQUEST (a human creating
 *        a request on a customer's behalf). Permission: bookings:write.
 *        The created record is ALWAYS status `requested`: creation can
 *        never confirm. Confirmation happens only via PATCH /api/bookings/[id].
 *        Required booking questions are enforced the same way as the agent
 *        path (missing list returned, nothing created).
 * Super Admin (businessId null) gets 403: bookings are tenant records.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  createBooking,
  getBookingQuestions,
  getMissingBookingAnswers,
  BOOKING_STATUSES,
} from "@/lib/bookings";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "bookings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "Bookings belong to a business." }, { status: 403 });
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const status = request.nextUrl.searchParams.get("status");
      if (status && status !== "all" && !(BOOKING_STATUSES as string[]).includes(status)) {
        return NextResponse.json(
          { error: `status must be one of: ${(BOOKING_STATUSES as string[]).join(", ")}.` },
          { status: 400 }
        );
      }
      const where: Record<string, unknown> = {};
      if (status && status !== "all") where.status = status;
      const bookings = await prisma.booking.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return NextResponse.json({ bookings });
    } catch (error) {
      logger.error("Failed to fetch bookings:", error);
      return NextResponse.json({ error: "Failed to fetch bookings" }, { status: 500 });
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "bookings:write");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "Bookings belong to a business." }, { status: 403 });
  }
  // Capture after the guard: TS resets property narrowing inside the
  // runWithBusiness callback, so the callback must use this const.
  const businessId = auth.businessId;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const service = String(body.service ?? "").trim();
      const requestedSlot = String(body.requestedSlot ?? "").trim();
      if (!service || !requestedSlot) {
        return NextResponse.json(
          { error: "service and requestedSlot are required." },
          { status: 400 }
        );
      }
      const questions = Array.isArray(body.questions) ? body.questions : [];
      let defined: Awaited<ReturnType<typeof getBookingQuestions>> = [];
      try {
        defined = await getBookingQuestions(businessId);
      } catch {
        defined = [];
      }
      const missing = getMissingBookingAnswers(defined, questions);
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: "Required booking questions are unanswered.",
            needsQuestions: missing,
          },
          { status: 400 }
        );
      }
      const result = await createBooking({
        service,
        requestedSlot,
        requestedDate: body.requestedDate ?? null,
        requestedTime: body.requestedTime ?? null,
        place: body.place ?? null,
        whatToBring: body.whatToBring ?? null,
        questions,
        customerName: body.customerName ?? null,
        customerPhone: body.customerPhone ?? null,
        advanceAmount: body.advanceAmount ?? null,
        advanceCurrency: body.advanceCurrency ?? null,
        reminders: Array.isArray(body.reminders) ? body.reminders : [],
        summary: body.summary ?? undefined,
      });
      return NextResponse.json({ booking: result }, { status: 201 });
    } catch (error) {
      logger.error("Failed to create booking:", error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create booking" },
        { status: 400 }
      );
    }
  });
}
