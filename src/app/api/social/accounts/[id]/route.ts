import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const account = await prisma.socialAccount.findUnique({ where: { id } });
      if (!account) {
        return NextResponse.json(
          { error: "Social account not found" },
          { status: 404 }
        );
      }

      await prisma.socialAccount.delete({ where: { id } });
      return NextResponse.json({ ok: true });
    } catch (error) {
      logger.error("Failed to delete social account:", error);
      return NextResponse.json(
        { error: "Failed to delete social account" },
        { status: 500 }
      );
    }

  });
}
