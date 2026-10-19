import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { dismissComment } from "@/lib/social/comments";

/**
 * Phase 5 (user decision 6): dismiss a comment ticket without replying.
 * The record stays for the audit trail; it leaves the pending queue.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { id } = await params;
      await dismissComment(id);
      return NextResponse.json({ ok: true });
    } catch (error) {
      logger.error("Failed to dismiss comment:", error);
      return NextResponse.json(
        { error: "Failed to dismiss comment" },
        { status: 500 }
      );
    }
  });
}
