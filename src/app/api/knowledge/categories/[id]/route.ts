import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "knowledge:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { name, description, icon, color, sortOrder } = body;

      const existing = await prisma.category.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Category not found" },
          { status: 404 }
        );
      }

      const category = await prisma.category.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(description !== undefined && { description: description.trim() }),
          ...(icon !== undefined && { icon }),
          ...(color !== undefined && { color }),
          ...(sortOrder !== undefined && { sortOrder }),
        },
        include: {
          _count: {
            select: { entries: true },
          },
        },
      });

      return NextResponse.json(category);
    } catch (error) {
      logger.error("Failed to update category:", error);
      return NextResponse.json(
        { error: "Failed to update category" },
        { status: 500 }
      );
    }

  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "knowledge:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const existing = await prisma.category.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Category not found" },
          { status: 404 }
        );
      }

      await prisma.category.delete({ where: { id } });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete category:", error);
      return NextResponse.json(
        { error: "Failed to delete category" },
        { status: 500 }
      );
    }

  });
}
