/**
 * LEG D (video round 2) — /api/reply-approvals/[id]. STAGED ONLY.
 *
 * GET one draft (read permission) and PATCH the three team overrides
 * (manage permission): send-now, reject, edit.
 *
 * - send-now: claims the draft (pending -> sending; a second claimant
 *   gets 409 `already_actioned`), delivers its text through the shared
 *   delivery helper, then marks it sent (sentVia "manual"). If delivery
 *   itself fails before any message row exists, the draft returns to
 *   pending and the route answers 500 — nothing was sent, so a retry
 *   is safe.
 * - reject: pending -> rejected. The text is never sent, the timer is
 *   dead, and no order/booking/ticket/courier state is touched (this
 *   route imports none of that code — by construction it cannot).
 * - edit: replaces the text AND restarts the timer from the edit
 *   moment with the CURRENT wait setting (pure-module rule). The
 *   draft stays pending; it is not sent by the edit itself.
 *
 * Non-pending drafts answer 409 `already_actioned` for every action —
 * a draft is acted on exactly once. A missing or foreign id answers
 * 404 `not_found`, never 403, so one business cannot probe another's
 * draft ids. Null businessId (Super Admin, no business selected)
 * answers 400, mirroring the settings route.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  applyDraftEdit,
  draftDeliverText,
  isActionable,
  normalizeApprovalSettings,
  parseDraftAction,
  validateDraftEdit,
} from "@/lib/reply-approval";
import { deliverDraftText } from "@/lib/reply-approval-delivery";

type DraftRow = Record<string, unknown>;

async function loadOwnedDraft(
  id: string,
  businessId: string
): Promise<DraftRow | null> {
  const draft = (await prisma.replyDraft.findUnique({
    where: { id },
  })) as DraftRow | null;
  if (!draft) return null;
  if (draft.businessId !== businessId) return null;
  return draft;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "reply-approvals:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "A business must be selected to read a reply draft" },
        { status: 400 }
      );
    }
    try {
      const { id } = await params;
      const draft = await loadOwnedDraft(id, auth.businessId);
      if (!draft) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ draft });
    } catch (error) {
      logger.error("Failed to read reply draft:", error);
      return NextResponse.json(
        { error: "Failed to read reply draft" },
        { status: 500 }
      );
    }
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "reply-approvals:manage");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "A business must be selected to act on a reply draft" },
        { status: 400 }
      );
    }
    try {
      const { id } = await params;
      const body = await request.json().catch(() => null);
      const action = parseDraftAction(body?.action);
      if (!action) {
        return NextResponse.json(
          { error: 'action must be "send-now", "reject", or "edit"' },
          { status: 400 }
        );
      }

      const draft = await loadOwnedDraft(id, auth.businessId);
      if (!draft) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (!isActionable(draft.status as string)) {
        return NextResponse.json(
          { error: "already_actioned", status: draft.status },
          { status: 409 }
        );
      }

      const actorName = auth.name || auth.username || "";

      if (action === "reject") {
        const updated = await prisma.replyDraft.update({
          where: { id },
          data: {
            status: "rejected",
            rejectedBy: auth.userId,
            rejectedByName: actorName,
            rejectedAt: new Date().toISOString(),
          },
        });
        return NextResponse.json({ draft: updated });
      }

      if (action === "edit") {
        const checked = validateDraftEdit(body?.text);
        if (!checked.ok) {
          return NextResponse.json({ error: checked.error }, { status: 400 });
        }
        const settings = await prisma.settings.findFirst();
        const approval = normalizeApprovalSettings({
          replyApprovalWaitSeconds: (settings as { replyApprovalWaitSeconds?: unknown } | null)
            ?.replyApprovalWaitSeconds,
        });
        const edit = applyDraftEdit(
          checked.text,
          Date.now(),
          approval.waitSeconds,
          auth.userId,
          actorName
        );
        const updated = await prisma.replyDraft.update({
          where: { id },
          data: {
            editedText: edit.editedText,
            autoSendAt: edit.autoSendAt,
            editedBy: edit.editedBy,
            editedByName: edit.editedByName,
            editedAt: edit.editedAt,
          },
        });
        return NextResponse.json({ draft: updated });
      }

      // send-now: claim first (at-most-once), deliver, then mark sent.
      const claimed = await prisma.replyDraft.update({
        where: { id, status: "pending" },
        data: { status: "sending" },
      }).catch(() => null);
      if (!claimed) {
        return NextResponse.json(
          { error: "already_actioned" },
          { status: 409 }
        );
      }
      const conversation = await prisma.conversation.findUnique({
        where: { id: draft.conversationId as string },
      });
      if (!conversation) {
        await prisma.replyDraft.update({
          where: { id },
          data: { status: "pending" },
        });
        return NextResponse.json(
          { error: "conversation_not_found" },
          { status: 404 }
        );
      }
      const text = draftDeliverText({
        draftText: draft.draftText as string,
        editedText: (draft.editedText as string | null) ?? null,
      });
      try {
        const conv = conversation as unknown as {
          id: string;
          channel: string;
          customerContact: string;
          metadata?: unknown;
        };
        const delivery = await deliverDraftText({ conversation: conv, text });
        const updated = await prisma.replyDraft.update({
          where: { id },
          data: {
            status: "sent",
            sentAt: new Date().toISOString(),
            sentBy: auth.userId,
            sentByName: actorName,
            sentVia: "manual",
            sentMessageId: delivery.messageId,
            deliveryNote: delivery.deliveryNote,
          },
        });
        return NextResponse.json({ draft: updated });
      } catch (error) {
        // Delivery threw before any message row existed: return the
        // draft to pending so a retry is safe and nothing duplicates.
        await prisma.replyDraft.update({
          where: { id },
          data: { status: "pending" },
        }).catch(() => null);
        logger.error("Failed to send reply draft now:", error);
        return NextResponse.json(
          { error: "Failed to send reply draft" },
          { status: 500 }
        );
      }
    } catch (error) {
      logger.error("Failed to act on reply draft:", error);
      return NextResponse.json(
        { error: "Failed to act on reply draft" },
        { status: 500 }
      );
    }
  });
}
