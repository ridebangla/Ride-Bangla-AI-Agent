import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "knowledge:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);

      const [categories, total] = await Promise.all([
        prisma.category.findMany({
          orderBy: { sortOrder: "asc" },
          skip,
          take,
          include: {
            _count: {
              select: { entries: true },
            },
          },
        }),
        prisma.category.count(),
      ]);

      return NextResponse.json(paginatedResponse(categories, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch categories:", error);
      return NextResponse.json(
        { error: "Failed to fetch categories" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "knowledge:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const body = await request.json();
      const { name, description, icon, color } = body;

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
          { error: "Category name is required" },
          { status: 400 }
        );
      }

      const maxSort = await prisma.category.aggregate({
        _max: { sortOrder: true },
      });

      const category = await prisma.category.create({
        data: withBusinessId({
          name: name.trim(),
          description: description?.trim() || "",
          icon: icon || "folder",
          color: color || "#4A7C9B",
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        }),
        include: {
          _count: {
            select: { entries: true },
          },
        },
      });

      return NextResponse.json(category, { status: 201 });
    } catch (error) {
      logger.error("Failed to create category:", error);
      return NextResponse.json(
        { error: "Failed to create category" },
        { status: 500 }
      );
    }

  });
}
