/**
 * Classified follow-up scheduling — LEG F (booking batch),
 * STAGED ONLY.
 *
 * Store-injected (no Prisma import): the route adapts the tenant-scoped
 * Prisma client to FollowUpStore, so this file is testable with an
 * in-memory store and cannot leak across tenants by itself — tenancy
 * lives in the caller's store, exactly as the existing follow-up code
 * relies on runWithBusiness scoping.
 *
 * This scheduler NEVER invents reminder wording: `message` is supplied
 * by the caller (owner-approved reminder text, in the customer's
 * language, produced by the engine/behaviour layer). It NEVER invents
 * timing either: firstDueAtMs and intervalMs are required caller
 * parameters — both are OWNER DECISIONS (see LEG-REPORT), because the
 * task gives no reminder delay and the repo's only evidenced delays
 * (dropped-revival quiet hours, order check-in hours) belong to
 * different features and are NOT reused here.
 * It NEVER confirms, edits or reads an order: ordering is out of scope.
 * It NEVER quotes a fare: no price is read or written here.
 */

import {
  planClassifiedFollowUps,
  type IntentClass,
} from "./followup-discipline";

export interface FollowUpStore {
  /** Kinds already recorded for this conversation (caller filters out
   *  explicitly cancelled records, if the store has such a status). */
  listKinds(conversationId: string): Promise<string[]>;
  createFollowUp(input: {
    conversationId: string;
    message: string;
    dueAt: Date;
    kind: string;
  }): Promise<{ id: string }>;
}

export interface ScheduleClassifiedInput {
  conversationId: string;
  intent: IntentClass;
  /** Caller-supplied, owner-approved reminder text. */
  message: string;
  /** Business-configurable Hot count; null = not configured (blocks). */
  hotMaxReminders: number | null | undefined;
  /** Caller/owner-decided delay of the first reminder. */
  firstDueAtMs: number;
  /** Caller/owner-decided gap between Hot reminders. */
  intervalMs: number;
  /** Business behaviour switch; false = schedule nothing. */
  followUpsEnabled: boolean;
}

export interface ScheduleClassifiedResult {
  scheduled: Array<{ id: string; kind: string; sequence: number; dueAt: Date }>;
  blockedReason?: string;
}

export async function scheduleClassifiedFollowUps(
  store: FollowUpStore,
  input: ScheduleClassifiedInput
): Promise<ScheduleClassifiedResult> {
  if (!input.followUpsEnabled) {
    return { scheduled: [], blockedReason: "followups_disabled" };
  }
  if (!input.message || input.message.trim().length === 0) {
    // Never schedule an empty reminder.
    return { scheduled: [], blockedReason: "empty_message" };
  }
  const existingKinds = await store.listKinds(input.conversationId);
  const plan = planClassifiedFollowUps({
    intent: input.intent,
    existingKinds,
    hotMaxReminders: input.hotMaxReminders,
  });
  if (plan.blockedReason) {
    return { scheduled: [], blockedReason: plan.blockedReason };
  }
  const scheduled: ScheduleClassifiedResult["scheduled"] = [];
  for (const item of plan.schedule) {
    const dueAt = new Date(input.firstDueAtMs + item.sequence * input.intervalMs);
    const created = await store.createFollowUp({
      conversationId: input.conversationId,
      message: input.message,
      dueAt,
      kind: item.kind,
    });
    scheduled.push({
      id: created.id,
      kind: item.kind,
      sequence: item.sequence,
      dueAt,
    });
  }
  return { scheduled };
}
