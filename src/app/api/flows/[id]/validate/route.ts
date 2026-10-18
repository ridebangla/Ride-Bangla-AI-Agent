import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { validateFlow, type Flow } from "@/lib/flow-builder";
import { logger } from "@/lib/logger";

export async function POST(
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

      const result = validateFlow(flow as unknown as Flow);

      return NextResponse.json(result);
    } catch (error) {
      logger.error("Failed to validate flow:", error);
      return NextResponse.json(
        { error: "Failed to validate flow" },
        { status: 500 }
      );
    }

  });
}
