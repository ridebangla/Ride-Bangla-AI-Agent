import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "team:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { name, description, email } = body;

      if (!name || !name.trim()) {
        return NextResponse.json(
          { error: "Department name is required" },
          { status: 400 }
        );
      }

      const department = await prisma.department.update({
        where: { id },
        data: {
          name: name.trim(),
          description: description?.trim() || "",
          email: email?.trim() || "",
        },
        include: {
          _count: {
            select: { members: true },
          },
        },
      });

      return NextResponse.json(department);
    } catch (error) {
      logger.error("Failed to update department:", error);
      return NextResponse.json(
        { error: "Failed to update department" },
        { status: 500 }
      );
    }

  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "team:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      await prisma.department.delete({
        where: { id },
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete department:", error);
      return NextResponse.json(
        { error: "Failed to delete department" },
        { status: 500 }
      );
    }

  });
}
