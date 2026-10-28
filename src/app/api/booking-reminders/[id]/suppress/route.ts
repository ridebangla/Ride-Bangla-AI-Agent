/**
 * POST /api/booking-reminders/[id]/suppress — LEG D (booking batch), STAGED ONLY.
 * Repo path when applied: src/app/api/booking-reminders/[id]/suppress/route.ts
 *
 * Setter for the "AI deems it unneeded" suppression: marks one
 * booking-reminder record suppressed (terminal — it will never
 * deliver) and records why. This is how a staff member — and, once
 * a future leg wires it, an agent tool — exercises the AI-unneeded
 * rule without editing Firestore by hand. Permission:
 * `conversations:update`. Tenant-scoped via runWithBusiness: another
 * tenant's record id fails closed as "not found", exactly like the
 * orders PATCH route's P2025 handling.
 *
 * Only kind === "booking_reminder" records in status "pending" may
 * be suppressed here; anything else is a 400 (generic follow-ups
 * keep their own lifecycle, and an already-sent record is history).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { id } = await context.params;
      const body = await request.json().catch(() => ({}));
      const reason =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 200)
          : "ai_unneeded";
      const record = await prisma.followUp.findUnique({ where: { id } });
      if (!record) {
        return NextResponse.json({ error: "Reminder not found." }, { status: 404 });
      }
      const rec = record as { kind?: string; status?: string };
      if (rec.kind !== "booking_reminder" || rec.status !== "pending") {
        return NextResponse.json(
          { error: "Only a pending booking reminder can be suppressed." },
          { status: 400 }
        );
      }
      const updated = await prisma.followUp.update({
        where: { id },
        data: {
          status: "suppressed",
          suppressReason: reason,
          aiSuppressed: true,
        },
      });
      return NextResponse.json({ success: true, reminder: updated });
    } catch (error) {
      logger.error("Booking-reminder suppress failed:", error);
      return NextResponse.json(
        { error: "Failed to suppress booking reminder" },
        { status: 500 }
      );
    }
  });
}
