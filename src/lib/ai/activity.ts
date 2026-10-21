/**
 * Live agent activity — server-side reporting.
 *
 * The engine and the channel handlers call `reportActivity` at the REAL
 * execution points of the work they do (an LLM completion starting, a
 * catalog tool actually running, a WhatsApp send actually in flight).
 * The current activity is persisted on the conversation document
 * (`liveActivity`) so every surface can read the same truth:
 *
 *   - the public widget polls GET /api/chat/activity while a request is
 *     in flight and captions the working avatar with it;
 *   - the dashboard inbox reads it from GET /api/conversations/[id]
 *     (rides along with the conversation payload) and shows the tenant
 *     what their agent is doing on the open conversation;
 *   - an `agent:activity` realtime event is published for any live
 *     consumer.
 *
 * HONESTY GUARDS:
 *   - Nothing here ever invents an action. A caption exists only while
 *     the corresponding code is genuinely running: report on entry,
 *     overwrite as the turn moves on, clear on settle.
 *   - Paths whose work cannot be observed from inside this process
 *     (SMS / phone replies are dispatched by Twilio from the route's
 *     TwiML response — there is no in-process send to wrap) never emit
 *     `sending_reply`; those turns show only the engine activities,
 *     which are real.
 *   - `searching_website` is never emitted: the engine has no website
 *     browse/search execution point today.
 *   - Reporting is fail-soft: an activity write failure must never
 *     break the customer's turn, so every call swallows its errors.
 */

import { prisma } from "@/lib/prisma";
import { emitAgentActivity } from "@/lib/realtime";
import { logger } from "@/lib/logger";
import type { AgentActivity, AgentActivityKind } from "./activity-labels";

export type { AgentActivity, AgentActivityKind };

/**
 * Tool name (as the model calls it) -> the activity that is TRUE while
 * that tool executes. Every tool in `agentTools` is mapped; an unmapped
 * tool leaves the current activity untouched (the composing caption
 * stays — generic, never a fabricated specific).
 */
const TOOL_ACTIVITY: Record<string, AgentActivityKind> = {
  search_catalog: "searching_catalog",
  recommend_alternative: "recommending_alternatives",
  show_products: "finding_products",
  create_ticket: "creating_ticket",
  assign_to_person: "assigning_ticket",
  send_internal_email: "sending_email",
  get_customer_history: "checking_history",
  schedule_followup: "scheduling_followup",
  take_order: "taking_order",
  trigger_webhook: "triggering_webhook",
};

export function activityKindForTool(toolName: string): AgentActivityKind | null {
  return TOOL_ACTIVITY[toolName] ?? null;
}

/**
 * Widget activity token: the embed generates one random token per page
 * session and sends it with every chat/vision/voice request. It is
 * stored on the conversation so the embed can poll the conversation's
 * live activity BEFORE the first response hands it a conversationId —
 * and afterwards as a second factor next to the visitor check. It is a
 * caption-channel identifier only: it grants no read access to message
 * content (the activity endpoint returns nothing but the activity).
 */
export function parseActivityToken(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value)
    ? value
    : "";
}

/** Bind a widget activity token to a conversation (fail-soft). */
export async function bindActivityToken(
  conversationId: string,
  token: string,
  current?: unknown
): Promise<void> {
  if (!token || current === token) return;
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { activityToken: token },
    });
  } catch (err) {
    logger.warn("[activity] failed to bind activity token", {
      conversationId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record that the agent is now doing `kind` on this conversation.
 * Overwrites any previous activity (latest action wins). Never throws.
 */
export async function reportActivity(
  conversationId: string,
  kind: AgentActivityKind,
  opts?: { channel?: string | null }
): Promise<void> {
  const activity: AgentActivity = {
    kind,
    channel: opts?.channel ?? null,
    at: new Date().toISOString(),
  };
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { liveActivity: activity },
    });
  } catch (err) {
    logger.warn("[activity] failed to record agent activity", {
      conversationId,
      kind,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    emitAgentActivity(conversationId, activity);
  } catch {
    /* realtime is best-effort */
  }
}

/**
 * Clear the conversation's live activity (the turn settled). Idempotent:
 * skips the write when nothing is recorded. Never throws.
 */
export async function clearActivity(conversationId: string): Promise<void> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conv?.liveActivity) return;
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { liveActivity: null },
    });
  } catch (err) {
    logger.warn("[activity] failed to clear agent activity", {
      conversationId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    emitAgentActivity(conversationId, null);
  } catch {
    /* realtime is best-effort */
  }
}
