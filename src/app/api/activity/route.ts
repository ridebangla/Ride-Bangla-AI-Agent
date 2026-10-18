import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "activity:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const entity = searchParams.get("entity");
      const from = searchParams.get("from");
      const to = searchParams.get("to");

      const where: Record<string, unknown> = {};

      if (entity && entity !== "all") {
        where.entity = entity;
      }

      if (from || to) {
        const createdAt: Record<string, Date> = {};
        if (from) createdAt.gte = new Date(from);
        if (to) createdAt.lte = new Date(to);
        where.createdAt = createdAt;
      }

      const [activities, total] = await Promise.all([
        prisma.activityLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.activityLog.count({ where }),
      ]);

      return NextResponse.json(paginatedResponse(activities, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch activity logs:", error);
      return NextResponse.json(
        { error: "Failed to fetch activity logs" },
        { status: 500 }
      );
    }

  });
}
