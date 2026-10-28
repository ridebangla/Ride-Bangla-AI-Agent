/**
 * /api/payments/[id]/mark-received — LEG C (staged): the team action
 * "Payment received".
 *
 * POST — mark one `checking` payment as `received`.
 * Permission: payments:write. The team member's id (auth.userId) is
 * recorded in the payment's audit trail with the timestamp, in the
 * same transaction as the status change.
 *
 * MANUAL CHECK ONLY: this endpoint is the ONLY thing that may move a
 * payment to `received`, and it is pressed by a human who has checked
 * the money themselves outside this system. No gateway callback, no
 * automatic verification, no agent path reaches this transition — the
 * agent tools can only record `checking` payments, never mark one
 * received. The endpoint never confirms, locks, or unlocks any order
 * or booking, and never changes any order total.
 *
 * Fail-closed responses: another tenant's payment id and an unknown
 * id both return 404; an already-received payment returns 409.
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "payments:write");
  if (!isAuthenticated(auth)) return auth;
  const businessId = auth.businessId;
  if (!businessId) {
    return NextResponse.json({ error: "Business context required" }, { status: 403 });
  }

  return runWithBusiness(businessId, async () => {
    try {
      const { id } = await context.params;
      const { markPaymentReceived } = await import("@/lib/advance-payments");
      const result = await markPaymentReceived({
        businessId,
        paymentId: id,
        markedByUserId: auth.userId,
      });
      if (!result.ok) {
        if (result.error === "payment_not_found") {
          return NextResponse.json({ error: "Payment not found" }, { status: 404 });
        }
        return NextResponse.json(
          { error: "Payment already marked received" },
          { status: 409 }
        );
      }
      return NextResponse.json({ payment: result.payment });
    } catch (error) {
      logger.error("Failed to mark payment received:", error);
      return NextResponse.json({ error: "Failed to mark payment received" }, { status: 500 });
    }
  });
}
