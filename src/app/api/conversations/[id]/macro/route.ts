import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { executeMacro } from "@/lib/conversation-engine";
import { logger } from "@/lib/logger";
import { runWithBusiness } from "@/lib/prisma";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { actions } = body;

      if (!actions || !Array.isArray(actions)) {
        return NextResponse.json(
          { error: "actions array is required" },
          { status: 400 }
        );
      }

      const result = await executeMacro(id, actions, auth.name);

      return NextResponse.json(result);
    } catch (error) {
      logger.error("Failed to execute macro:", error);
      return NextResponse.json(
        { error: "Failed to execute macro" },
        { status: 500 }
      );
    }

  });
}
