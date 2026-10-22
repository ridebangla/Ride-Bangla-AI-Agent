/**
 * Phase 5: shared inbound pipeline for every channel handler.
 *
 * Single choke point that every channel (WhatsApp Web, WhatsApp Cloud API,
 * Telegram, SMS, Email, Phone, Meta Messenger/Instagram, X) funnels
 * customer messages through:
 *
 *   1. Subscription hard-stop (user decision 16): an inactive trial /
 *      subscription stores the customer's message honestly but generates
 *      ZERO AI reply and spends ZERO LLM tokens (402 semantics — the
 *      dashboard/API chat routes return 402; channels answer with silence).
 *   2. The AI engine (`chat()`), which itself honors the per-conversation
 *      `aiEnabled` switch AND the global settings kill-switch
 *      (user decision 17) by storing the message in pure silence.
 *
 * Tenancy: `businessId` must be resolved by the caller (webhook route or
 * background worker) BEFORE entering this function; every write below is
 * tenant-scoped via `withBusinessId`. Callers enter business context with
 * `runWithBusiness` (HTTP) or `enterBusinessContext` (workers) around it.
 */
import { prisma, withBusinessId } from "@/lib/prisma";
import { chat, type ChatResult } from "@/lib/ai/engine";
import { clearActivity } from "@/lib/ai/activity";
import type { MediaInput } from "@/lib/ai/media";
import {
  requireActiveSubscription,
  SubscriptionInactiveError,
} from "@/lib/subscription";
import { logger } from "@/lib/logger";
import { checkMessageLimitExceeded } from "@/lib/billing-usage";

export interface InboundResult extends ChatResult {
  /** true when the message was stored but the AI reply was blocked by the subscription hard-stop. */
  blockedBySubscription?: boolean;
  /** true when the message was stored but the AI reply was blocked by the plan message limit. */
  blockedByMessageLimit?: boolean;
}

/**
 * Process one inbound customer message for a channel conversation.
 */
export async function processChannelMessage(
  conversationId: string,
  businessId: string,
  userMessage: string,
  opts?: { media?: MediaInput }
): Promise<InboundResult> {
  // ---- User decision 16 (airtight): subscription hard-stop BEFORE any
  // LLM tokens are spent or conversations are created. Inactive trial /
  // subscription => the message is stored honestly, no AI reply, no spend.
  // The blocked path is shared with the feature-scope gate below: both
  // answer a channel message with the route's existing silent-drop —
  // store the message, generate nothing, spend nothing.
  const storeSilently = async (): Promise<InboundResult> => {
    await prisma.message.create({
      data: withBusinessId({
        conversationId,
        role: "customer",
        content: userMessage,
      }),
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return { response: "", products: [], silent: true, blockedBySubscription: true };
  };

  let sub;
  try {
    sub = await requireActiveSubscription(businessId);
  } catch (err) {
    if (err instanceof SubscriptionInactiveError) {
      const blocked = await storeSilently();
      logger.warn(
        `[inbound] subscription inactive — stored customer message silently for conversation ${conversationId}`
      );
      return blocked;
    }
    throw err;
  }

  // Feature scope (B6 follow-up): a grant scoped away from "chat" gets
  // the same silent-drop as an inactive subscription. A chat-scoped
  // grant (scopeAllowsChat true) and every unscoped account pass
  // unchanged — the check is explicit-false only.
  if (sub.scopeAllowsChat === false) {
    const blocked = await storeSilently();
    logger.warn(
      `[inbound] grant scope excludes chat — stored customer message silently for conversation ${conversationId}`
    );
    return blocked;
  }

  // Plan quota hard-stop (same pattern as the subscription block above):
  // store the customer's message honestly, spend zero LLM tokens.
  if (await checkMessageLimitExceeded(businessId)) {
    await prisma.message.create({
      data: withBusinessId({
        conversationId,
        role: "customer",
        content: userMessage,
      }),
    });
    logger.warn(
      `[inbound] message limit reached — stored customer message silently for conversation ${conversationId}`
    );
    return { response: "", products: [], silent: true, blockedByMessageLimit: true };
  }

  // `chat()` honors conversations.aiEnabled AND the global kill-switch.
  // The engine reports + clears live activity on its normal paths; this
  // finally guarantees no activity survives a thrown turn on any channel
  // (idempotent — a no-op when the engine already cleared). Channel
  // handlers report `sending_reply` around their provider send next.
  try {
    return await chat(conversationId, userMessage, opts);
  } finally {
    await clearActivity(conversationId);
  }
}
