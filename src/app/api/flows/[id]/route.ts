import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const flow = await prisma.flow.findUnique({ where: { id } });
      if (!flow) {
        return NextResponse.json(
          { error: "Flow not found" },
          { status: 404 }
        );
      }

      return NextResponse.json(flow);
    } catch (error) {
      logger.error("Failed to fetch flow:", error);
      return NextResponse.json(
        { error: "Failed to fetch flow" },
        { status: 500 }
      );
    }

  });
}

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
      const { name, description, startNodeId, nodes, isActive } = body;

      const existing = await prisma.flow.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Flow not found" },
          { status: 404 }
        );
      }

      const flow = await prisma.flow.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(description !== undefined && { description: description.trim() }),
          ...(startNodeId !== undefined && { startNodeId }),
          ...(nodes !== undefined && { nodes }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      return NextResponse.json(flow);
    } catch (error) {
      logger.error("Failed to update flow:", error);
      return NextResponse.json(
        { error: "Failed to update flow" },
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

      const existing = await prisma.flow.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Flow not found" },
          { status: 404 }
        );
      }

      await prisma.flow.delete({ where: { id } });

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete flow:", error);
      return NextResponse.json(
        { error: "Failed to delete flow" },
        { status: 500 }
      );
    }

  });
}
