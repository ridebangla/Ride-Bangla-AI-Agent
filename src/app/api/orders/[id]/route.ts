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
      const order = await setOrderStatus(id, status);
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
