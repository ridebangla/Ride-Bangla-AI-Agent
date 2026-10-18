import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { retryDelivery } from "@/lib/webhook-delivery";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "webhooks:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const status = searchParams.get("status");

      const where: Record<string, unknown> = { webhookId: id };
      if (status && status !== "all") {
        where.status = status;
      }

      const [deliveries, total] = await Promise.all([
        prisma.webhookDelivery.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.webhookDelivery.count({ where }),
      ]);

      return NextResponse.json(paginatedResponse(deliveries, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch webhook deliveries:", error);
      return NextResponse.json(
        { error: "Failed to fetch deliveries" },
        { status: 500 }
      );
    }

  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "webhooks:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { deliveryId } = body;

      if (!deliveryId) {
        return NextResponse.json(
          { error: "deliveryId is required" },
          { status: 400 }
        );
      }

      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: deliveryId, webhookId: id },
      });

      if (!delivery) {
        return NextResponse.json(
          { error: "Delivery not found" },
          { status: 404 }
        );
      }

      const success = await retryDelivery(deliveryId);

      return NextResponse.json({ success, deliveryId });
    } catch (error) {
      logger.error("Failed to retry webhook delivery:", error);
      return NextResponse.json(
        { error: "Failed to retry delivery" },
        { status: 500 }
      );
    }

  });
}
