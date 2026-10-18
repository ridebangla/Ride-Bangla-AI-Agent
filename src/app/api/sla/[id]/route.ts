import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "sla:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { name, description, channel, priority, firstResponseMins, resolutionMins, isActive } = body;

      const existing = await prisma.sLARule.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "SLA rule not found" },
          { status: 404 }
        );
      }

      const rule = await prisma.sLARule.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(description !== undefined && { description: description.trim() }),
          ...(channel !== undefined && { channel }),
          ...(priority !== undefined && { priority }),
          ...(firstResponseMins !== undefined && { firstResponseMins }),
          ...(resolutionMins !== undefined && { resolutionMins }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      return NextResponse.json(rule);
    } catch (error) {
      logger.error("Failed to update SLA rule:", error);
      return NextResponse.json(
        { error: "Failed to update SLA rule" },
        { status: 500 }
      );
    }

  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "sla:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const existing = await prisma.sLARule.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "SLA rule not found" },
          { status: 404 }
        );
      }

      await prisma.sLARule.delete({ where: { id } });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete SLA rule:", error);
      return NextResponse.json(
        { error: "Failed to delete SLA rule" },
        { status: 500 }
      );
    }

  });
}
