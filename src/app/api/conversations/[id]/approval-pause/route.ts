/**
 * LEG D (video round 2) — POST /api/conversations/[id]/approval-pause.
 * STAGED ONLY.
 *
 * Per-chat pause for approval mode: the team holds THIS chat's
 * auto-send timer without touching the tenant-wide mode or any other
 * chat. While paused, pending drafts in this conversation are HELD by
 * the sweep (decision `hold`, reason `chat_paused`) — they are not
 * sent and not deleted. Unpausing does NOT retime drafts: a draft
 * already past its autoSendAt sends on the next sweep (prompt-fire
 * rule, see src/lib/reply-approval.ts). Pausing never cancels,
 * rejects, or sends a draft, and it never changes takeover state
 * (aiEnabled) — pause and takeover are independent holds, and either
 * one alone disarms the timer.
 *
 * Permission: reply-approvals:manage (agent, supervisor, admin).
 * Missing/foreign conversation -> 404. Non-boolean body -> 400.
 * Idempotent: pausing an already-paused chat (or unpausing an
 * unpaused one) succeeds and reports alreadyInState, writing nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { parsePaused } from "@/lib/reply-approval";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "reply-approvals:manage");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "A business must be selected to pause approval for a chat" },
        { status: 400 }
      );
    }
    try {
      const { id } = await params;
      const body = await request.json().catch(() => null);
      const paused = parsePaused(body?.paused);
      if (paused === null) {
        return NextResponse.json(
          { error: "paused must be a boolean" },
          { status: 400 }
        );
      }
      const conversation = await prisma.conversation.findUnique({
        where: { id },
      });
      if (
        !conversation ||
        (conversation as unknown as Record<string, unknown>).businessId !==
          auth.businessId
      ) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const current =
        (conversation as unknown as Record<string, unknown>).approvalPaused ===
        true;
      if (current === paused) {
        return NextResponse.json({
          id,
          approvalPaused: paused,
          alreadyInState: true,
        });
      }
      const updated = await prisma.conversation.update({
        where: { id },
        data: { approvalPaused: paused },
      });
      return NextResponse.json({
        id: (updated as unknown as Record<string, unknown>).id,
        approvalPaused: paused,
        alreadyInState: false,
      });
    } catch (error) {
      logger.error("Failed to set approval pause:", error);
      return NextResponse.json(
        { error: "Failed to set approval pause" },
        { status: 500 }
      );
    }
  });
}
