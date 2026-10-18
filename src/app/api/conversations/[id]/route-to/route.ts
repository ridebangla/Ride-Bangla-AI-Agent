import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { routeConversation } from "@/lib/conversation-engine";
import { logger } from "@/lib/logger";
import { runWithBusiness } from "@/lib/prisma";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:assign");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { strategy, expertise, departmentId } = body;

      const result = await routeConversation(
        id,
        strategy || "skill_based",
        expertise,
        departmentId
      );

      if (!result) {
        return NextResponse.json(
          { error: "No available agents" },
          { status: 404 }
        );
      }

      return NextResponse.json(result);
    } catch (error) {
      logger.error("Failed to route conversation:", error);
      return NextResponse.json(
        { error: "Failed to route conversation" },
        { status: 500 }
      );
    }

  });
}
