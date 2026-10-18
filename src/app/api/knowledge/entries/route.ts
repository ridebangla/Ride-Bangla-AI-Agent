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
      const categoryId = searchParams.get("categoryId");

      const where = categoryId ? { categoryId } : {};

      const [entries, total] = await Promise.all([
        prisma.knowledgeEntry.findMany({
          where,
          orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
          skip,
          take,
          include: {
            category: {
              select: { id: true, name: true, color: true, icon: true },
            },
          },
        }),
        prisma.knowledgeEntry.count({ where }),
      ]);

      return NextResponse.json(paginatedResponse(entries, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch entries:", error);
      return NextResponse.json(
        { error: "Failed to fetch entries" },
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
      const { categoryId, title, content, priority } = body;

      if (!categoryId) {
        return NextResponse.json(
          { error: "Category ID is required" },
          { status: 400 }
        );
      }

      if (!title || typeof title !== "string" || title.trim().length === 0) {
        return NextResponse.json(
          { error: "Title is required" },
          { status: 400 }
        );
      }

      const category = await prisma.category.findUnique({
        where: { id: categoryId },
      });
      if (!category) {
        return NextResponse.json(
          { error: "Category not found" },
          { status: 404 }
        );
      }

      const entry = await prisma.knowledgeEntry.create({
        data: withBusinessId({
          categoryId,
          title: title.trim(),
          content: content?.trim() || "",
          priority: typeof priority === "number" ? priority : 0,
        }),
        include: {
          category: {
            select: { id: true, name: true, color: true, icon: true },
          },
        },
      });

      return NextResponse.json(entry, { status: 201 });
    } catch (error) {
      logger.error("Failed to create entry:", error);
      return NextResponse.json(
        { error: "Failed to create entry" },
        { status: 500 }
      );
    }

  });
}
