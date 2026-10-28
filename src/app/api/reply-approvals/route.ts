/**
 * LEG D (video round 2) — GET /api/reply-approvals. STAGED ONLY.
 *
 * Review-surface list: the tenant's pending drafts (default) or one
 * status filter, oldest first, each with its conversation context
 * (customer name, channel, takeover state, per-chat pause), the
 * tenant's CURRENT approval settings, and the server-computed timer
 * decision (send / hold / cancel + reason) and remaining time.
 *
 * Read-only by construction: this GET never sends, cancels, or
 * otherwise mutates a draft — auto-send happens only in the sweep
 * route. A draft whose timer decision is `send` here is simply DUE;
 * it still waits for the sweep (or a staff send-now).
 *
 * Tenant scoping: runWithBusiness + explicit businessId filter, and a
 * null businessId (Super Admin without a selected business) answers
 * 400, mirroring the settings route. A foreign draft can never appear
 * here because the query itself is tenant-scoped.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  decideDraftTimer,
  normalizeApprovalSettings,
  remainingMs,
} from "@/lib/reply-approval";

const ALLOWED_STATUSES = new Set([
  "pending",
  "sent",
  "rejected",
  "superseded",
  "cancelled",
]);

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "reply-approvals:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "A business must be selected to list reply drafts" },
        { status: 400 }
      );
    }
    try {
      const statusParam = request.nextUrl.searchParams.get("status") || "pending";
      const status = ALLOWED_STATUSES.has(statusParam) ? statusParam : "pending";

      const settings = await prisma.settings.findFirst();
      const approval = normalizeApprovalSettings({
        replyApprovalEnabled: (settings as { replyApprovalEnabled?: unknown } | null)
          ?.replyApprovalEnabled,
        replyApprovalWaitSeconds: (settings as { replyApprovalWaitSeconds?: unknown } | null)
          ?.replyApprovalWaitSeconds,
      });
      const globalAiEnabled =
        (settings as { aiEnabled?: unknown } | null)?.aiEnabled !== false;

      const drafts = await prisma.replyDraft.findMany({
        where: { businessId: auth.businessId, status },
        orderBy: { createdAt: "asc" },
        take: 100,
      });

      const nowMs = Date.now();
      const rows = [];
      for (const draft of drafts as Array<Record<string, unknown>>) {
        const conversation = await prisma.conversation.findUnique({
          where: { id: draft.conversationId as string },
        });
        const conv = (conversation || {}) as Record<string, unknown>;
        const timer = decideDraftTimer({
          status: draft.status as string,
          conversationStatus:
            typeof conv.status === "string" ? conv.status : null,
          conversationAiEnabled: conv.aiEnabled !== false,
          approvalEnabled: approval.enabled,
          globalAiEnabled,
          chatPaused: conv.approvalPaused === true,
          autoSendAt: draft.autoSendAt as string | null,
          nowMs,
        });
        rows.push({
          id: draft.id,
          conversationId: draft.conversationId,
          customerName:
            typeof conv.customerName === "string" ? conv.customerName : "Unknown",
          channel: typeof conv.channel === "string" ? conv.channel : "",
          customerMessage:
            typeof draft.customerMessage === "string" ? draft.customerMessage : "",
          draftText: draft.draftText,
          editedText: draft.editedText ?? null,
          status: draft.status,
          autoSendAt: draft.autoSendAt,
          remainingMs: remainingMs(draft.autoSendAt as string | null, nowMs),
          timerDecision: timer.decision,
          timerReason: timer.reason,
          chatPaused: conv.approvalPaused === true,
          takeoverActive: conv.aiEnabled === false,
          createdAt: draft.createdAt,
          editedByName: draft.editedByName ?? null,
          editedAt: draft.editedAt ?? null,
          sentVia: draft.sentVia ?? null,
          cancelReason: draft.cancelReason ?? null,
          supersedeReason: draft.supersedeReason ?? null,
        });
      }

      return NextResponse.json({
        drafts: rows,
        settings: {
          replyApprovalEnabled: approval.enabled,
          replyApprovalWaitSeconds: approval.waitSeconds,
          globalAiEnabled,
        },
      });
    } catch (error) {
      logger.error("Failed to list reply drafts:", error);
      return NextResponse.json(
        { error: "Failed to list reply drafts" },
        { status: 500 }
      );
    }
  });
}
