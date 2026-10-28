/**
 * /api/payments — LEG C (staged): advance-payment administration API.
 *
 * GET  — list this tenant's payments for one record
 *        (?recordKind=order|booking&recordId=...). Permission:
 *        payments:read. Used by the dashboard to render receipts:
 *        the response's `receipt` is `computeReceiptBreakdown` over the
 *        listed payments, so the advance deduction is shown from
 *        stored docs, never from chat amounts.
 * POST — a TEAM MEMBER records a transaction ID manually (e.g. the
 *        customer phoned it in instead of chatting it).
 *        Permission: payments:write. 409 on a duplicate transaction
 *        ID for this business; 400 on an invalid ID, an unconfigured
 *        or non-applicable advance, or an unknown record.
 *        Booking-kind records are refused with
 *        `booking_store_not_wired` until Leg A wires a booking lookup
 *        (see src/lib/advance-payments.ts header).
 *
 * MANUAL CHECK ONLY: nothing here verifies money. A recorded payment
 * stays `checking` until a team member presses "Payment received"
 * (POST /api/payments/[id]/mark-received). No gateway, no provider
 * link, no automatic verification of any kind.
 *
 * Tenant scoping: every operation runs inside runWithBusiness with
 * the authenticated businessId, and every store call filters by that
 * same businessId. One tenant's payments are never listed, recorded
 * over, or marked by another tenant. All responses are English
 * (admin panel English-only doctrine). Payments are NOT gated by any
 * usage limit (limit-model doctrine: order data, not a metered AI
 * feature).
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "payments:read");
  if (!isAuthenticated(auth)) return auth;
  const businessId = auth.businessId;
  if (!businessId) {
    return NextResponse.json({ error: "Business context required" }, { status: 403 });
  }
  const recordKind = request.nextUrl.searchParams.get("recordKind");
  const recordId = request.nextUrl.searchParams.get("recordId");
  if (recordKind !== "order" && recordKind !== "booking") {
    return NextResponse.json(
      { error: 'recordKind must be "order" or "booking".' },
      { status: 400 }
    );
  }
  if (!recordId) {
    return NextResponse.json({ error: "recordId is required." }, { status: 400 });
  }

  return runWithBusiness(businessId, async () => {
    try {
      const {
        listPaymentsForRecord,
        computeReceiptBreakdown,
      } = await import("@/lib/advance-payments");
      const { getUnscopedPrisma } = await import("@/lib/prisma");
      // Record-existence + tenancy check for orders (same fail-closed
      // shape as the take_order conversation check: another tenant's
      // id and an unknown id fail the same way).
      let orderTotal: number | null = null;
      if (recordKind === "order") {
        const order = (await getUnscopedPrisma().order.findUnique({
          where: { id: recordId },
          select: { id: true, businessId: true, total: true },
        })) as {
          id?: string;
          businessId?: string;
          total?: number | null;
        } | null;
        if (!order || order.businessId !== businessId) {
          return NextResponse.json({ error: "Order not found" }, { status: 404 });
        }
        orderTotal = order.total ?? null;
      }
      const payments = await listPaymentsForRecord(businessId, recordKind, recordId);
      const receipt = computeReceiptBreakdown({ orderTotal, payments });
      return NextResponse.json({ payments, receipt });
    } catch (error) {
      logger.error("Failed to fetch payments:", error);
      return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "payments:write");
  if (!isAuthenticated(auth)) return auth;
  const businessId = auth.businessId;
  if (!businessId) {
    return NextResponse.json({ error: "Business context required" }, { status: 403 });
  }

  return runWithBusiness(businessId, async () => {
    try {
      const body = await request.json();
      const recordKind = String(body.recordKind ?? "");
      const recordId = String(body.recordId ?? "");
      const transactionId = String(body.transactionId ?? "");
      if (recordKind !== "order" && recordKind !== "booking") {
        return NextResponse.json(
          { error: 'recordKind must be "order" or "booking".' },
          { status: 400 }
        );
      }
      if (!recordId) {
        return NextResponse.json({ error: "recordId is required." }, { status: 400 });
      }
      if (recordKind === "booking") {
        // Distinct booking store belongs to Leg A (still in flight).
        return NextResponse.json(
          { error: "booking_store_not_wired" },
          { status: 400 }
        );
      }
      const {
        getAdvanceConfig,
        isAdvanceApplicable,
        normalizeTransactionId,
        refuseSensitivePaymentInput,
        recordAdvancePayment,
      } = await import("@/lib/advance-payments");
      const refusal = refuseSensitivePaymentInput({ transactionId });
      if (refusal) {
        return NextResponse.json({ error: refusal }, { status: 400 });
      }
      const normalized = normalizeTransactionId(transactionId);
      if (!normalized) {
        return NextResponse.json(
          { error: "invalid_transaction_id" },
          { status: 400 }
        );
      }
      const { getUnscopedPrisma } = await import("@/lib/prisma");
      const order = (await getUnscopedPrisma().order.findUnique({
        where: { id: recordId },
        select: { id: true, businessId: true },
      })) as { id?: string; businessId?: string } | null;
      if (!order || order.businessId !== businessId) {
        return NextResponse.json({ error: "Order not found" }, { status: 404 });
      }
      const config = await getAdvanceConfig(businessId);
      if (!config) {
        return NextResponse.json(
          { error: "advance_not_configured" },
          { status: 400 }
        );
      }
      if (!isAdvanceApplicable(config, "order")) {
        return NextResponse.json(
          { error: "advance_not_applicable" },
          { status: 400 }
        );
      }
      const result = await recordAdvancePayment({
        businessId,
        recordKind: "order",
        recordId,
        transactionId: normalized,
        amount: config.advanceAmount,
        recordedBy: { type: "team", userId: auth.userId },
      });
      if (!result.ok) {
        return NextResponse.json(
          {
            error: result.error,
            existingPaymentId: result.existingPaymentId,
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ payment: result.payment }, { status: 201 });
    } catch (error) {
      logger.error("Failed to record payment:", error);
      return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
    }
  });
}
