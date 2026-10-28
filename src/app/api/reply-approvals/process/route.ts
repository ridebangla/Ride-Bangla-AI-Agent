/**
 * LEG D (video round 2) — POST /api/reply-approvals/process. STAGED ONLY.
 *
 * The AUTO-SEND sweep: the only path by which a draft sends on timer
 * expiry. Mirrors the takeover auto-revert sweep's auth shape (Leg E):
 * `Authorization: Bearer <CRON_SECRET>` alone sweeps every business;
 * otherwise a staff session with `reply-approvals:manage` sweeps only
 * the caller's business (a manual "send due drafts now" trigger with
 * the same semantics as a cron run).
 *
 * Per draft, the sweep RE-READS the conversation and the tenant's
 * CURRENT settings and runs the pure timer decision — a draft is
 * never sent on stale state. Outcomes:
 * - send: claim (pending -> sending, 409-safe), deliver through the
 *   shared delivery helper, mark sent with sentVia "auto". A delivery
 *   failure before any message row exists returns the draft to
 *   pending for the next run; a failure after the row exists is
 *   folded into the delivery note and the draft is still marked sent
 *   (at-most-once beats at-least-once: a duplicate customer message
 *   is worse than a missing delivery note).
 * - cancel: thread closed -> draft cancelled, reason thread_closed.
 * - hold: skipped untouched (takeover, global off, mode off, paused,
 *   waiting, bad deadline) — the next run re-decides.
 * - noop: already terminal — skipped (defensive; the query only
 *   selects pending drafts).
 *
 * One draft's failure never blocks the rest (per-draft try/catch).
 * The run is capped at 200 sends-or-cancels so one run can never churn
 * the whole tenant base; leftovers report `capped: true` for the next
 * run. Cron cadence is an owner decision (proposal: every minute —
 * the wait is measured in minutes, so a finer cadence buys nothing).
 *
 * This route imports no order, ticket, billing, or courier code: an
 * auto-send cannot confirm or change any order, booking, ticket, or
 * courier state — it delivers draft TEXT only.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  prisma,
  getUnscopedPrisma,
  runWithBusiness,
} from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  MAX_DRAFTS_PER_SWEEP,
  decideDraftTimer,
  draftDeliverText,
  normalizeApprovalSettings,
} from "@/lib/reply-approval";
import { deliverDraftText } from "@/lib/reply-approval-delivery";

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";
  const cronOk = !!secret && header === `Bearer ${secret}`;

  let onlyBusinessId: string | null = null;
  if (!cronOk) {
    const auth = await requireAuth(request, "reply-approvals:manage");
    if (!isAuthenticated(auth)) return auth;
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "A business must be selected to process reply drafts" },
        { status: 400 }
      );
    }
    onlyBusinessId = auth.businessId;
  }

  try {
    const businessIds: string[] = cronOk
      ? (
          await getUnscopedPrisma().business.findMany({
            where: { isActive: true },
            select: { id: true },
          })
        ).map((b: { id: string }) => b.id)
      : [onlyBusinessId as string];

    let checked = 0;
    let sent = 0;
    let cancelled = 0;
    let held = 0;
    let errors = 0;
    let capped = false;

    for (const businessId of businessIds) {
      const outcome = await runWithBusiness(businessId, async () => {
        const drafts = await prisma.replyDraft.findMany({
          where: { businessId, status: "pending" },
          orderBy: { createdAt: "asc" },
          take: MAX_DRAFTS_PER_SWEEP + 1,
        });
        if (drafts.length > MAX_DRAFTS_PER_SWEEP) capped = true;
        const batch = drafts.slice(0, MAX_DRAFTS_PER_SWEEP);

        const settings = await prisma.settings.findFirst();
        const approval = normalizeApprovalSettings({
          replyApprovalEnabled: (settings as { replyApprovalEnabled?: unknown } | null)
            ?.replyApprovalEnabled,
          replyApprovalWaitSeconds: (settings as { replyApprovalWaitSeconds?: unknown } | null)
            ?.replyApprovalWaitSeconds,
        });
        const globalAiEnabled =
          (settings as { aiEnabled?: unknown } | null)?.aiEnabled !== false;

        let local = { checked: 0, sent: 0, cancelled: 0, held: 0, errors: 0 };
        for (const draftRow of batch as Array<Record<string, unknown>>) {
          local.checked++;
          try {
            const conversation = await prisma.conversation.findUnique({
              where: { id: draftRow.conversationId as string },
            });
            if (!conversation) {
              // Thread gone: never send into nothing; cancel the draft.
              await prisma.replyDraft.update({
                where: { id: draftRow.id as string },
                data: { status: "cancelled", cancelReason: "thread_closed" },
              });
              local.cancelled++;
              continue;
            }
            const conv = conversation as unknown as Record<string, unknown>;
            const timer = decideDraftTimer({
              status: draftRow.status as string,
              conversationStatus:
                typeof conv.status === "string" ? conv.status : null,
              conversationAiEnabled: conv.aiEnabled !== false,
              approvalEnabled: approval.enabled,
              globalAiEnabled,
              chatPaused: conv.approvalPaused === true,
              autoSendAt: draftRow.autoSendAt as string | null,
              nowMs: Date.now(),
            });
            if (timer.decision === "cancel") {
              await prisma.replyDraft.update({
                where: { id: draftRow.id as string },
                data: { status: "cancelled", cancelReason: timer.reason },
              });
              local.cancelled++;
              continue;
            }
            if (timer.decision !== "send") {
              local.held++;
              continue;
            }
            const claimed = await prisma.replyDraft.update({
              where: { id: draftRow.id as string, status: "pending" },
              data: { status: "sending" },
            }).catch(() => null);
            if (!claimed) {
              local.held++;
              continue;
            }
            const text = draftDeliverText({
              draftText: draftRow.draftText as string,
              editedText: (draftRow.editedText as string | null) ?? null,
            });
            try {
              const delivery = await deliverDraftText({
                conversation: conv as unknown as {
                  id: string;
                  channel: string;
                  customerContact: string;
                  metadata?: unknown;
                },
                text,
              });
              await prisma.replyDraft.update({
                where: { id: draftRow.id as string },
                data: {
                  status: "sent",
                  sentAt: new Date().toISOString(),
                  sentBy: "auto",
                  sentByName: "Auto-send",
                  sentVia: "auto",
                  sentMessageId: delivery.messageId,
                  deliveryNote: delivery.deliveryNote,
                },
              });
              local.sent++;
            } catch (err) {
              await prisma.replyDraft.update({
                where: { id: draftRow.id as string },
                data: { status: "pending" },
              }).catch(() => null);
              local.errors++;
              logger.error("Auto-send of reply draft failed:", err);
            }
          } catch (err) {
            local.errors++;
            logger.error("Reply-draft sweep item failed:", err);
          }
        }
        return local;
      });
      checked += outcome.checked;
      sent += outcome.sent;
      cancelled += outcome.cancelled;
      held += outcome.held;
      errors += outcome.errors;
    }

    return NextResponse.json({
      success: true,
      checked,
      sent,
      cancelled,
      held,
      errors,
      capped,
    });
  } catch (error) {
    logger.error("Failed to process reply drafts:", error);
    return NextResponse.json(
      { error: "Failed to process reply drafts" },
      { status: 500 }
    );
  }
}
