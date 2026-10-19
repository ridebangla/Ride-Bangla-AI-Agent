import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { approveCommentReply } from "@/lib/social/comments";

/**
 * Phase 5 (user decision 6): approve + send a drafted comment reply.
 *
 * POST /api/social/comments/[id]/approve  { text?: string }
 *   text: the reply to post — the business's own wording, or the AI draft
 *   (edited or as-is). Posts through the real platform API; only a
 *   platform-returned ID marks the comment replied.
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
      const body = await request.json().catch(() => ({}));
      const text = typeof body.text === "string" ? body.text.trim() : "";

      if (!text) {
        return NextResponse.json(
          { error: "Reply text is required" },
          { status: 400 }
        );
      }
      if (text.length > 2000) {
        return NextResponse.json(
          { error: "Reply text exceeds 2000 characters" },
          { status: 400 }
        );
      }

      const { replyId } = await approveCommentReply(id, text);
      return NextResponse.json({ ok: true, replyId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send reply";
      logger.error("Failed to approve comment reply:", error);
      const status = /not found|already replied/i.test(message) ? 404 : 502;
      return NextResponse.json({ error: message }, { status });
    }
  });
}
