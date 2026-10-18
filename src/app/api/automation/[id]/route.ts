import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { name, description, type, isActive, conditions, actions, priority } =
        body;

      const existing = await prisma.automationRule.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Automation rule not found" },
          { status: 404 }
        );
      }

      const validTypes = ["auto_route", "auto_tag", "auto_reply", "keyword_alert"];
      if (type !== undefined && !validTypes.includes(type)) {
        return NextResponse.json(
          { error: "Invalid rule type" },
          { status: 400 }
        );
      }

      const rule = await prisma.automationRule.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(description !== undefined && { description: description.trim() }),
          ...(type !== undefined && { type }),
          ...(isActive !== undefined && { isActive }),
          ...(conditions !== undefined && { conditions }),
          ...(actions !== undefined && { actions }),
          ...(priority !== undefined && { priority }),
        },
      });

      return NextResponse.json(rule);
    } catch (error) {
      logger.error("Failed to update automation rule:", error);
      return NextResponse.json(
        { error: "Failed to update automation rule" },
        { status: 500 }
      );
    }

  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const existing = await prisma.automationRule.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Automation rule not found" },
          { status: 404 }
        );
      }

      await prisma.automationRule.delete({ where: { id } });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete automation rule:", error);
      return NextResponse.json(
        { error: "Failed to delete automation rule" },
        { status: 500 }
      );
    }

  });
}
