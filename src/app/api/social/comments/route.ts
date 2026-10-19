import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

/**
 * Phase 5 (user decision 6): the comment approval queue for the inbox.
 *
 * GET /api/social/comments?status=pending
 *   status=pending (default): kind=comment, replied=false, newest first.
 *   status=all: every comment interaction.
 *
 * Each item carries the AI-drafted reply (`draftReply`) for the business
 * to approve/send/edit from the inbox Comments tab.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const status = searchParams.get("status") || "pending";

      const where: Record<string, unknown> = { kind: "comment" };
      if (status === "pending") {
        where.replied = false;
      }

      const comments = await prisma.socialInteraction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          platform: true,
          externalId: true,
          parentRef: true,
          customerRef: true,
          content: true,
          likes: true,
          replied: true,
          repliedAt: true,
          replyRef: true,
          draftReply: true,
          createdAt: true,
        },
      });

      return NextResponse.json({
        comments,
        pending: comments.filter((c) => !c.replied).length,
      });
    } catch (error) {
      logger.error("Failed to list comment queue:", error);
      return NextResponse.json(
        { error: "Failed to list comment queue" },
        { status: 500 }
      );
    }
  });
}
