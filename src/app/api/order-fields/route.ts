/**
 * /api/order-fields — Phase 2: the per-business order-flow builder.
 *
 * GET — { orderFields: OrderField[] } for the tenant.
 * PUT — { orderFields: OrderField[] } replaces the definition set
 *       (validated by validateOrderFields in @/lib/orders).
 *
 * Stored on `businesses.orderFields`. Permission: settings:read /
 * settings:update (business-level config, admin only). Updated via the
 * UNSCOPED client with an explicit `where: { id: auth.businessId }` —
 * fail-closed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { validateOrderFields, DEFAULT_ORDER_FIELDS } from "@/lib/orders";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

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
        select: { orderFields: true },
      })) as { orderFields?: unknown } | null;
      let orderFields: unknown[] = [];
      try {
        orderFields = validateOrderFields(business?.orderFields ?? []);
      } catch {
        orderFields = [];
      }
      return NextResponse.json({ orderFields, defaults: DEFAULT_ORDER_FIELDS });
    } catch (error) {
      logger.error("Failed to fetch order fields:", error);
      return NextResponse.json(
        { error: "Failed to fetch order fields" },
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

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      let cleaned;
      try {
        cleaned = validateOrderFields(body.orderFields ?? []);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Invalid order fields." },
          { status: 400 }
        );
      }

      const updated = await getUnscopedPrisma().business.update({
        where: { id: auth.businessId },
        data: { orderFields: cleaned },
        select: { orderFields: true },
      });

      return NextResponse.json({
        orderFields: (updated as { orderFields: unknown }).orderFields ?? [],
      });
    } catch (error) {
      logger.error("Failed to update order fields:", error);
      return NextResponse.json(
        { error: "Failed to update order fields" },
        { status: 500 }
      );
    }
  });
}
