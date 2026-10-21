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
import { resolveCourierDeliveryEnabled } from "@/lib/courier-bridge";
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
        select: {
          orderFields: true,
          courierDeliveryEnabled: true,
          isInternalAccount: true,
          siteKey: true,
        },
      })) as {
        orderFields?: unknown;
        courierDeliveryEnabled?: unknown;
        isInternalAccount?: unknown;
        siteKey?: unknown;
      } | null;
      let orderFields: unknown[] = [];
      try {
        orderFields = validateOrderFields(business?.orderFields ?? []);
      } catch {
        orderFields = [];
      }
      return NextResponse.json({
        orderFields,
        defaults: DEFAULT_ORDER_FIELDS,
        courierDelivery: {
          enabled: business ? resolveCourierDeliveryEnabled(business) : false,
          stored:
            typeof business?.courierDeliveryEnabled === "boolean"
              ? business.courierDeliveryEnabled
              : null,
        },
      });
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

      // Courier bridge setting (optional in the body — order-fields
      // saves that don't mention it leave it untouched).
      let courierDeliveryEnabled: boolean | undefined;
      if (body.courierDeliveryEnabled !== undefined) {
        if (typeof body.courierDeliveryEnabled !== "boolean") {
          return NextResponse.json(
            { error: "courierDeliveryEnabled must be a boolean." },
            { status: 400 }
          );
        }
        courierDeliveryEnabled = body.courierDeliveryEnabled;
      }

      const updated = await getUnscopedPrisma().business.update({
        where: { id: auth.businessId },
        data: {
          orderFields: cleaned,
          ...(courierDeliveryEnabled !== undefined
            ? { courierDeliveryEnabled }
            : {}),
        },
        select: {
          orderFields: true,
          courierDeliveryEnabled: true,
          isInternalAccount: true,
          siteKey: true,
        },
      });

      const updatedBiz = updated as {
        orderFields: unknown;
        courierDeliveryEnabled?: unknown;
        isInternalAccount?: unknown;
        siteKey?: unknown;
      };
      return NextResponse.json({
        orderFields: updatedBiz.orderFields ?? [],
        courierDelivery: {
          enabled: resolveCourierDeliveryEnabled(updatedBiz),
          stored:
            typeof updatedBiz.courierDeliveryEnabled === "boolean"
              ? updatedBiz.courierDeliveryEnabled
              : null,
        },
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
