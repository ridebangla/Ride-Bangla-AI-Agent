/**
 * /api/orders/[id] — Phase 2: update an order's status (dashboard).
 * PATCH { status: "pending" | "confirmed" | "cancelled" }.
 * Permission: tickets:update. Tenant-scoped via runWithBusiness.
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { setOrderStatus, type OrderStatus } from "@/lib/orders";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "tickets:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { id } = await context.params;
      const body = await request.json();
      const status = String(body.status ?? "") as OrderStatus;
      if (!["pending", "confirmed", "cancelled"].includes(status)) {
        return NextResponse.json(
          { error: 'status must be "pending", "confirmed" or "cancelled".' },
          { status: 400 }
        );
      }
      // LEG B (staged): the dashboard caller is a verified human actor.
      // requireAuth above already guarantees dashboard/API-key auth (chat
      // sessions carry neither), and the actor id below is what the audit
      // trail records — agent/chat callers can never reach this route
      // with a human actor, and setOrderStatus refuses non-human actors
      // even if one did. `reason` is optional and stays null when the
      // dashboard sends none (today's buttons send none); a missing
      // reason on a post-confirmation change is flagged reasonMissing
      // in the audit entry, never invented.
      const reasonRaw =
        typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      const order = await setOrderStatus(id, status, {
        actorType: "human",
        actorId: auth.userId,
        reason: reasonRaw === "" ? null : reasonRaw,
      });
      return NextResponse.json({ order });
    } catch (error) {
      // Unknown id (or another tenant's id — the update is tenant-scoped,
      // so both fail closed the same way): the data layer throws a
      // Prisma-style P2025 "record not found". That is a 404, not a 500.
      if ((error as { code?: string } | null)?.code === "P2025") {
        return NextResponse.json({ error: "Order not found" }, { status: 404 });
      }
      logger.error("Failed to update order:", error);
      return NextResponse.json({ error: "Failed to update order" }, { status: 500 });
    }
  });
}
