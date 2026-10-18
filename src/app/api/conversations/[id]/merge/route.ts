import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { mergeConversations } from "@/lib/conversation-engine";
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
      const { secondaryId } = body;

      if (!secondaryId) {
        return NextResponse.json(
          { error: "secondaryId is required" },
          { status: 400 }
        );
      }

      const success = await mergeConversations(id, secondaryId);

      if (!success) {
        return NextResponse.json(
          { error: "Merge failed" },
          { status: 400 }
        );
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error("Failed to merge conversations:", error);
      return NextResponse.json(
        { error: "Failed to merge" },
        { status: 500 }
      );
    }

  });
}
