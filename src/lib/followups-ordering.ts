/**
 * FOLLOWUPS ORDERING — the 4-way joint-tree precedence, as code.
 * Repo path when applied: src/lib/followups-ordering.ts (NEW, pure)
 *
 * HEAD-DECISION APPLIED (2026-10-28 fix-all round, not re-decided):
 * Leg F gate FIRST. Leg D/J outcomes are recorded as deferred /
 * suppressed per the F→I file's own merge note, never double-counted.
 * No joint tree that double-counts is staged.
 *
 * WHY BOTH COUNTERS EXIST WITHOUT DOUBLE-COUNTING: Leg F and Leg D
 * key on the SAME conversation-level condition in the staged texts
 * (aiEnabled === false: F calls it "human_hands" suppressed, D calls
 * it "deferred"). If both fired, one record would increment two
 * counters. The resolution that keeps both counters honest is a
 * SCOPE SPLIT, following the owner-controls precedence already in
 * channel-controls.ts:
 *   - Leg F "suppressed" = CONVERSATION-level gate (per-thread
 *     aiEnabled off, human hands, already ordered, window expired,
 *     blocked, closed thread, Leg I number-left for sales kinds).
 *   - Leg D "deferred" = CHANNEL-level owner hold (owner-controls
 *     channel mode = "owner") that Leg F's conversation-level gate
 *     does NOT cover. A channel-held record that F did not already
 *     suppress is deferred, not suppressed — and a record F already
 *     suppressed is NEVER also deferred, even if its channel is held.
 *   - Leg J toggles = the same channel-level family (global ∧ chat ∧
 *     page ∧ channel AND semantics — see below); a J-blocked record
 *     that F already suppressed stays suppressed; otherwise it is
 *     deferred under the J reason, not suppressed.
 *   - LD-06 (booking reminders) owns ONLY booking_reminder delivery,
 *     and only AFTER the gates above pass; its held/suppressed/
 *     deferred outcomes are deliberately UNCOUNTED (unlike Leg F's
 *     suppressed), exactly as staged. LD-06 never owns a record the
 *     gates already stopped, and never re-counts one.
 * First match wins; exactly one outcome per record, always.
 *
 * LEG J D1 (conservative, HEAD-BUILT-PENDING-CORRECTION): AND
 * semantics — global ∧ chat ∧ page ∧ channel must ALL be on for a
 * follow-up to send; a narrow ON never re-enables a broader OFF.
 * AND is the fail-closed reading (it can only stop sends, never
 * start one a broader OFF forbids). If the owner later picks
 * specific-overrides-general, change ONLY jToggleOn() — the
 * ordering and counters do not change.
 *
 * LEG J D2 (conservative, HEAD-BUILT-PENDING-CORRECTION): the global
 * gate extension applies to follow-ups AND vision the same way —
 * a global OFF stops both. No vision-specific exception is invented.
 *
 * D-INTENT (fail-closed, no write invented): HEAD has NO recorded
 * intent field at all. This module therefore NEVER creates intent
 * state. Until an intent field lands, the intent queue is exactly
 * pending orders + open leads (the only recorded states that exist).
 * classifyIntentQueue() returns that queue and refuses to invent a
 * classifier-written intent. A classifier that WRITES recorded
 * intent is new work gated on that field, not a silent add here.
 */

export type FollowUpOutcome =
  | { outcome: "send" }
  | { outcome: "suppressed"; reason: string }
  | { outcome: "deferred"; reason: string };

export interface FollowUpGateFacts {
  /** Leg F inputs (conversation-level). */
  conversationAiEnabled: boolean;
  humanHands: boolean;
  alreadyOrdered: boolean;
  windowExpired: boolean;
  isBlocked: boolean;
  threadClosed: boolean;
  /** Leg I: customer left a number in chat (sales kinds only). */
  customerLeftNumber: boolean;
  isSalesKind: boolean;
  /** Leg D/J inputs (channel-level, owner-controls). */
  channelOwnerHeld: boolean;
  /** Leg J D1 toggles; absent toggle = ON (missing record never blocks a send the owner never restricted — the conservative direction for TOGGLES is handled by AND over PRESENT toggles only; a missing global record is not invented as OFF). */
  toggles?: { global?: boolean; chat?: boolean; page?: boolean; channel?: boolean };
  /** LD-06: is this a booking reminder? */
  isBookingReminder: boolean;
}

/** Leg J D1 AND semantics over the toggles that are present. */
export function jToggleOn(toggles?: FollowUpGateFacts["toggles"]): boolean {
  if (!toggles) return true;
  const values = [toggles.global, toggles.chat, toggles.page, toggles.channel];
  for (const v of values) {
    if (v === false) return false;
  }
  return true;
}

/**
 * Classify ONE due record. Order is the decision — do not reorder:
 * F (conversation) -> I (sales number-left) -> D (channel hold) ->
 * J (toggles) -> LD-06 ownership note -> send.
 */
export function classifyFollowUp(facts: FollowUpGateFacts): FollowUpOutcome {
  // 1. Leg F gate FIRST (conversation-level suppressions).
  if (facts.conversationAiEnabled === false || facts.humanHands) {
    return { outcome: "suppressed", reason: "human_hands" };
  }
  if (facts.alreadyOrdered) return { outcome: "suppressed", reason: "already_ordered" };
  if (facts.windowExpired) return { outcome: "suppressed", reason: "window_expired" };
  if (facts.isBlocked) return { outcome: "suppressed", reason: "blocked" };
  if (facts.threadClosed) return { outcome: "suppressed", reason: "closed_thread" };
  // 2. Leg I, after F (staged order: "a Leg F reason always stands first").
  if (facts.customerLeftNumber && facts.isSalesKind) {
    return { outcome: "suppressed", reason: "customer_left_number" };
  }
  // 3. Leg D channel hold — ONLY if F did not already suppress.
  //    This is the no-double-count rule: reaching here proves F passed.
  if (facts.channelOwnerHeld) {
    return { outcome: "deferred", reason: "channel_owner_controlled" };
  }
  // 4. Leg J toggles (AND semantics) — only if F and D passed.
  if (!jToggleOn(facts.toggles)) {
    return { outcome: "deferred", reason: "channel_toggle_off" };
  }
  // 5. LD-06 owns booking_reminder delivery from here on; its own
  //    held/suppressed/deferred outcomes stay UNCOUNTED by design.
  return { outcome: "send" };
}

/** Counter update: exactly one counter moves per record, or none. */
export interface FollowUpCounters {
  processed: number;
  sent: number;
  failed: number;
  suppressed: number;
  deferred: number;
}

export function applyOutcome(
  counters: FollowUpCounters,
  outcome: FollowUpOutcome,
): FollowUpCounters {
  const next = { ...counters, processed: counters.processed + 1 };
  if (outcome.outcome === "suppressed") next.suppressed += 1;
  if (outcome.outcome === "deferred") next.deferred += 1;
  return next;
}

/**
 * D-INTENT queue, fail-closed: pending orders + open leads only.
 * No classifier-written intent exists until HEAD gains a recorded
 * intent field. Passing a classifier-written intent here is refused
 * by the type (there is no such parameter to pass).
 */
export interface IntentQueueInput {
  pendingOrders: string[];
  openLeads: string[];
}

export function intentQueue(input: IntentQueueInput): string[] {
  return [...input.pendingOrders, ...input.openLeads];
}
