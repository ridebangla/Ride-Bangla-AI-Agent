import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "sla:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const [rules, total] = await Promise.all([
      prisma.sLARule.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.sLARule.count(),
    ]);

    return NextResponse.json(paginatedResponse(rules, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch SLA rules:", error);
    return NextResponse.json(
      { error: "Failed to fetch SLA rules" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "sla:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { name, description, channel, priority, firstResponseMins, resolutionMins, isActive } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Rule name is required" },
        { status: 400 }
      );
    }

    const rule = await prisma.sLARule.create({
      data: withBusinessId({
        name: name.trim(),
        description: description?.trim() || "",
        channel: channel || "all",
        priority: priority || "all",
        firstResponseMins: firstResponseMins ?? 30,
        resolutionMins: resolutionMins ?? 480,
        isActive: isActive ?? true,
      }),
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    logger.error("Failed to create SLA rule:", error);
    return NextResponse.json(
      { error: "Failed to create SLA rule" },
      { status: 500 }
    );
  }
}
