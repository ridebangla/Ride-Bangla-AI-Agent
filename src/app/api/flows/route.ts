import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const isActive = searchParams.get("isActive");

    const where: Record<string, unknown> = {};

    if (isActive !== null) {
      where.isActive = isActive === "true";
    }

    const [flows, total] = await Promise.all([
      prisma.flow.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.flow.count({ where }),
    ]);

    return NextResponse.json(paginatedResponse(flows, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch flows:", error);
    return NextResponse.json(
      { error: "Failed to fetch flows" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { name, description, startNodeId, nodes, isActive } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const flow = await prisma.flow.create({
      data: withBusinessId({
        name: name.trim(),
        description: description?.trim() || "",
        startNodeId: startNodeId || "",
        nodes: nodes || [],
        isActive: isActive ?? false,
      }),
    });

    return NextResponse.json(flow, { status: 201 });
  } catch (error) {
    logger.error("Failed to create flow:", error);
    return NextResponse.json(
      { error: "Failed to create flow" },
      { status: 500 }
    );
  }
}
