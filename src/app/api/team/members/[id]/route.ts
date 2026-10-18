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
      const { name, email, phone, role, expertise, departmentId, isAvailable } =
        body;

      if (!name || !name.trim()) {
        return NextResponse.json(
          { error: "Member name is required" },
          { status: 400 }
        );
      }

      if (!email || !email.trim()) {
        return NextResponse.json(
          { error: "Member email is required" },
          { status: 400 }
        );
      }

      if (!departmentId) {
        return NextResponse.json(
          { error: "Department is required" },
          { status: 400 }
        );
      }

      const member = await prisma.teamMember.update({
        where: { id },
        data: {
          name: name.trim(),
          email: email.trim(),
          phone: phone?.trim() || "",
          role: role?.trim() || "member",
          expertise: expertise?.trim() || "",
          departmentId,
          ...(typeof isAvailable === "boolean" ? { isAvailable } : {}),
        },
        include: {
          department: {
            select: { id: true, name: true },
          },
        },
      });

      return NextResponse.json(member);
    } catch (error) {
      logger.error("Failed to update member:", error);
      return NextResponse.json(
        { error: "Failed to update member" },
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

      await prisma.teamMember.delete({
        where: { id },
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete member:", error);
      return NextResponse.json(
        { error: "Failed to delete member" },
        { status: 500 }
      );
    }

  });
}
