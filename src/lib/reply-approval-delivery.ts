/**
 * LEG D (video round 2) — draft delivery. STAGED ONLY.
 *
 * The ONE place that turns a draft into a customer-visible message,
 * shared by the send-now route and the auto-send sweep so both paths
 * deliver identically. Deliberately narrow:
 *
 * - Writes exactly one assistant message row in the thread, updates
 *   the conversation timestamp, and emits the realtime event (so the
 *   website widget's thread poll picks the message up like any other
 *   assistant reply).
 * - For non-widget channels it then attempts the channel send through
 *   the SAME delivery helper staff replies use (deliverOwnerReply) —
 *   best-effort, never throwing after the message row exists, so a
 *   channel failure can never duplicate the message on retry.
 * - It imports NO order, ticket, billing, or courier code and calls
 *   no tool: sending a draft cannot confirm, create, price, dispatch,
 *   or otherwise change any order, booking, ticket, or courier state.
 *   The delivered text is text, full stop.
 *
 * Throwing contract: this function throws ONLY if the message row
 * itself could not be created (nothing was sent, so the caller may
 * safely leave the draft pending for retry). Once the row exists it
 * never throws — delivery-note failures are folded into the result.
 *
 * Callers own the draft-status transitions (pending -> sending claim
 * before calling here, sending -> sent after a successful return).
 * That ordering is what makes delivery at-most-once: a second
 * claimant finds the draft already claimed and stops with 409.
 */
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { emitNewMessage } from "@/lib/realtime";
import { deliverOwnerReply } from "@/lib/channels/deliver";

export interface DraftDeliveryResult {
  messageId: string;
  delivered: boolean;
  deliveryNote: string;
}

interface ConversationForDelivery {
  id: string;
  channel: string;
  customerContact: string;
  metadata?: unknown;
}

export async function deliverDraftText(input: {
  conversation: ConversationForDelivery;
  text: string;
}): Promise<DraftDeliveryResult> {
  const { conversation, text } = input;

  // The message row FIRST: the widget poll reads the thread, so the
  // reply is visible there even if the channel send below fails.
  const saved = await prisma.message.create({
    data: withBusinessId({
      conversationId: conversation.id,
      role: "assistant",
      content: text,
    }),
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });
  emitNewMessage(conversation.id, {
    id: saved.id,
    role: "assistant",
    content: text,
  });

  // Widget / api threads have no outbound send path — the thread poll
  // is the delivery. Every other channel gets the staff-reply send
  // attempt; a failure stays a delivery note, never a retry that
  // could duplicate the customer-visible message.
  let deliveryNote = "stored — visible in the website chat on refresh";
  let delivered = false;
  if (conversation.channel !== "widget" && conversation.channel !== "api") {
    try {
      const attempt = await deliverOwnerReply(conversation, text);
      delivered = attempt.delivered;
      deliveryNote = attempt.deliveryNote;
    } catch (err) {
      logger.warn("[reply-approval] channel delivery threw after store", {
        conversationId: conversation.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      deliveryNote = "dashboard-only reply (send error — see logs)";
    }
  }

  try {
    await prisma.message.update({
      where: { id: saved.id },
      data: { deliveryNote },
    });
  } catch (err) {
    logger.warn("[reply-approval] could not store delivery note", {
      messageId: saved.id,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return { messageId: saved.id, delivered, deliveryNote };
}
