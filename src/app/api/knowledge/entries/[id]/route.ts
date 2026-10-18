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
      const { title, content, priority, isActive, categoryId } = body;

      const existing = await prisma.knowledgeEntry.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Entry not found" },
          { status: 404 }
        );
      }

      const entry = await prisma.knowledgeEntry.update({
        where: { id },
        data: {
          ...(title !== undefined && { title: title.trim() }),
          ...(content !== undefined && { content: content.trim() }),
          ...(priority !== undefined && { priority }),
          ...(isActive !== undefined && { isActive }),
          ...(categoryId !== undefined && { categoryId }),
          version: { increment: 1 },
        },
        include: {
          category: {
            select: { id: true, name: true, color: true, icon: true },
          },
        },
      });

      return NextResponse.json(entry);
    } catch (error) {
      logger.error("Failed to update entry:", error);
      return NextResponse.json(
        { error: "Failed to update entry" },
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

      const existing = await prisma.knowledgeEntry.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Entry not found" },
          { status: 404 }
        );
      }

      await prisma.knowledgeEntry.delete({ where: { id } });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete entry:", error);
      return NextResponse.json(
        { error: "Failed to delete entry" },
        { status: 500 }
      );
    }

  });
}
