import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

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
      const { rating } = body;

      if (!rating || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        return NextResponse.json(
          { error: "Rating must be an integer between 1 and 5" },
          { status: 400 }
        );
      }

      const existing = await prisma.conversation.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }

      const conversation = await prisma.conversation.update({
        where: { id },
        data: { satisfaction: rating },
      });

      return NextResponse.json({
        success: true,
        satisfaction: conversation.satisfaction,
      });
    } catch (error) {
      logger.error("Failed to update satisfaction:", error);
      return NextResponse.json(
        { error: "Failed to update satisfaction" },
        { status: 500 }
      );
    }

  });
}
