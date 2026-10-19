/**
 * /api/orders — Phase 2: tenant-scoped order list (dashboard).
 * GET — latest 100 orders, newest first. Permission: tickets:read
 * (operational queue, same audience as tickets).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const status = request.nextUrl.searchParams.get("status");
      const where: Record<string, unknown> = {};
      if (status && ["pending", "confirmed", "cancelled"].includes(status)) {
        where.status = status;
      }
      const orders = await prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return NextResponse.json({ orders });
    } catch (error) {
      logger.error("Failed to fetch orders:", error);
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 });
    }
  });
}
