import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "canned:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const category = searchParams.get("category");

    const where: Record<string, unknown> = {};

    if (category && category !== "all") {
      where.category = category;
    }

    const [responses, total] = await Promise.all([
      prisma.cannedResponse.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.cannedResponse.count({ where }),
    ]);

    return NextResponse.json(paginatedResponse(responses, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch canned responses:", error);
    return NextResponse.json(
      { error: "Failed to fetch canned responses" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "canned:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { title, content, category, shortcut, isActive } = body;

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return NextResponse.json(
        { error: "Title is required" },
        { status: 400 }
      );
    }

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const response = await prisma.cannedResponse.create({
      data: withBusinessId({
        title: title.trim(),
        content: content.trim(),
        category: category?.trim() || "General",
        shortcut: shortcut?.trim() || "",
        isActive: isActive ?? true,
      }),
    });

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    logger.error("Failed to create canned response:", error);
    return NextResponse.json(
      { error: "Failed to create canned response" },
      { status: 500 }
    );
  }
}
