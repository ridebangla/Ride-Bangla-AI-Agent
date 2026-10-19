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
      logger.error("Failed to update order:", error);
      return NextResponse.json({ error: "Failed to update order" }, { status: 500 });
    }
  });
}
