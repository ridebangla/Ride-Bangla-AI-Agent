/**
 * unreplied-queues.ts — LEG B (video round 2), STAGED ONLY.
 *
 * Pure, dependency-free queue computation for the two team follow-up
 * queues. No database, no network, no message sending, no order, ticket
 * or billing write, no price or fare logic, no classifier. Everything
 * here is computed from RECORDED state supplied by the caller (the API
 * route); nothing is guessed from raw message text.
 *
 * ------------------------------------------------------------------
 * DEFINITIONS (the whole contract — read before changing anything)
 * ------------------------------------------------------------------
 *
 * REPLIED. A thread counts as replied iff a message whose role is
 * "assistant" or "admin" appears AFTER the last customer message in
 * the thread, by position in the caller-supplied chronological order.
 * - At HEAD, staff replies are stored as role "assistant" (the messages
 *   route coerces "admin" to "assistant"), so assistant covers both AI
 *   and team replies today. Accepting "admin" as well covers the
 *   staged Leg D (takeover) change, under which staff replies are
 *   stored honestly as "admin". Either way the queue does NOT
 *   distinguish AI replies from team replies: at HEAD both are the
 *   same role, and the distinction is not needed for "was this
 *   customer message answered".
 * - "system" and any unknown role are NEVER a reply: a system record
 *   is not a message sent to the customer. This is a deliberate
 *   divergence from HEAD /api/inbox, whose unread loop stops at ANY
 *   non-customer message (so a trailing system record makes its
 *   unread count 0 even though nobody answered). This queue must not
 *   reproduce that masking behaviour.
 * - Position, not timestamp, decides replied-vs-unreplied, so equal
 *   or missing timestamps on the reply side cannot flip the answer.
 *   Timestamps are used only for the 30-day window and for
 *   waitingSince (see below).
 *
 * UNREPLIED QUEUE. A conversation enters it iff ALL of these hold:
 *   (a) it belongs to the requesting business (foreign rows are
 *       excluded, never surfaced);
 *   (b) its status is not "closed" or "escalated" (explicit team
 *       dispositions; see STATUS below);
 *   (c) it has at least one customer message;
 *   (d) no reply-role message appears after the last customer
 *       message (the replied test above);
 *   (e) the last customer message's time is inside the 30-day window
 *       [now - 30 days, now], lower bound inclusive, future times
 *       excluded (a future-dated record is clock skew, not proof of
 *       recency, and is excluded rather than assumed);
 *   (f) the customer is not recorded as blocked (only when the
 *       caller supplies that fact; see BLOCKED below).
 * waitingSince is the time of the OLDEST consecutive unreplied
 * customer message — the start of the current unanswered stretch —
 * not merely the last message. Example: a customer wrote 40 days ago
 * (no reply) and again 2 days ago (no reply): the thread is in the
 * queue because its last customer message is inside the window, and
 * waitingSince is the 40-day-old message, because that is honestly
 * how long the stretch has waited. unrepliedCount is the number of
 * customer messages in that stretch.
 * Ordering: waitingSince ascending (longest-waiting first — the
 * triage order for "no customer is left waiting"), then
 * conversationId ascending for determinism.
 *
 * ORDERING-INTENT QUEUE. A conversation enters it iff it has at
 * least one RECORDED intent evidence whose recorded time is inside
 * the same 30-day window, it passes the same business and status
 * tests as the unreplied queue, and it is not blocked. Evidence
 * sources (each reported verbatim on the row as `evidence`, so the
 * team always sees WHY a thread is listed):
 *   - "pending_order": a PENDING order doc linked to this
 *     conversation (orders.conversationId, status "pending"). This
 *     is the ONLY intent marker that exists at HEAD today. A
 *     confirmed order is NOT intent (the team already acted;
 *     confirmed is locked) and a cancelled order is NOT intent.
 *   - "inbound_lead_open": an OPEN inbound lead for this
 *     conversation (or, as fallback, for this conversation's
 *     customerId) from the staged Leg H inbound-leads system
 *     (stages new/contacted/interested/quoted). At HEAD this
 *     collection does not exist, so this source contributes
 *     nothing until Leg H lands; the route reports which sources
 *     were actually available, and this module never pretends a
 *     missing source is empty-by-design.
 *   - "recorded_intent": a warm/hot intent state RECORDED by a
 *     classifier — the staged Leg F warm/hot classification concept.
 *     The classifier itself is NOT built here and raw message text
 *     is NEVER scanned here: if no recorded warm/hot state is
 *     supplied, this source contributes nothing. A customer who
 *     wrote words suggesting they will order, but who has no
 *     pending order, no open lead and no recorded intent, does NOT
 *     appear in this queue at HEAD landing. That is the honest
 *     consequence of the recorded-state-only rule, and the
 *     classifier that would close it is flagged as follow-up work
 *     (see the leg report, decision D-INTENT), not silently built.
 * intentRecordedAt is the earliest IN-WINDOW evidence time; evidence
 * older than the window does not by itself qualify the thread, but a
 * newer in-window evidence does (the row keeps all supplied evidence
 * so the history stays visible).
 * Ordering: intentRecordedAt ascending (longest-waiting intent
 * first), then conversationId ascending.
 *
 * SEPARATION + OVERLAP. The two queues are two lenses over the same
 * threads, not a partition. A thread that is both unreplied AND has
 * ordering intent appears in BOTH queues, flagged
 * (alsoHasIntent / alsoUnreplied) and counted once in
 * overlapConversationIds. Removing it from either queue would hide
 * real work (an unanswered message, or an order awaiting
 * confirmation), so the queues are never made disjoint. Counts must
 * therefore never be summed as "unique customers".
 *
 * STATUS. Included: "active", "resolved", "snoozed", and any unknown
 * status value (shown verbatim; the queue only surfaces work, it
 * sends nothing, so an unknown status fails open to visibility).
 * Excluded: "closed" and "escalated" only — the same two states the
 * HEAD follow-up system suppresses. A customer message arriving on
 * a closed/escalated thread is still visible in the Inbox (which
 * lists all statuses); it is simply not in this triage queue until
 * the team reopens it through the existing status control.
 *
 * BLOCKED. The caller supplies customerBlockedByConversation only
 * for threads that would otherwise qualify (the route looks the
 * customer up for queue candidates only, so the check costs nothing
 * for the bulk of threads). The blocked test runs LAST in the check
 * order, so an excluded row's reason is precise: a blocked thread
 * that was already replied is reported as "replied", not as
 * "customer_blocked". When the caller supplies no blocked map at
 * all, no thread is excluded for blocking (the map is absent, not
 * evidence of "not blocked" — the route documents this).
 *
 * WINDOW. WINDOW_DAYS = 30, fixed by the task. Both queues use the
 * same window. A window is computed from an explicit nowMs supplied
 * by the caller (never read from the environment here), so the
 * module is deterministic and testable.
 *
 * WORDING. This module produces NO user-facing copy and never uses
 * the word that would claim a customer is gone: rows carry machine
 * codes and facts only. The "all caught up" empty state lives in the
 * dashboard page as PROPOSAL wording for owner approval, and it is
 * shown only when a queue array is genuinely empty.
 */

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Task-fixed window: last 30 days. */
export const WINDOW_DAYS = 30;
export const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Roles that count as a reply to the customer (see header). */
export const REPLY_ROLES: readonly string[] = ["assistant", "admin"];

/** Conversation statuses excluded from both queues. */
export const EXCLUDED_STATUSES: readonly string[] = ["closed", "escalated"];

/** Open inbound-lead stages (staged Leg H concept, reused by key). */
export const OPEN_LEAD_STAGES: readonly string[] = [
  "new",
  "contacted",
  "interested",
  "quoted",
];

/** Preview length, mirroring HEAD /api/inbox (140 chars). */
export const PREVIEW_CHARS = 140;

// ------------------------------------------------------------------
// Input types (caller-supplied recorded state only)
// ------------------------------------------------------------------

export interface QueueMessage {
  id?: string;
  role: string;
  content: string;
  createdAt: Date | string | number;
}

export interface QueueConversation {
  id: string;
  businessId: string;
  channel: string;
  customerName: string;
  customerContact: string;
  customerId: string | null;
  status: string;
  aiEnabled: boolean;
  messages: QueueMessage[];
}

/** One recorded ordering-intent evidence item. */
export interface IntentEvidenceInput {
  source: "pending_order" | "inbound_lead_open" | "recorded_intent";
  /** Machine detail: order id, lead stage, or "warm"/"hot". */
  detail: string;
  businessId: string;
  recordedAt: Date | string | number;
  /** Order id when source is pending_order, else null. */
  orderId?: string | null;
  /** Lead stage when source is inbound_lead_open, else null. */
  leadStage?: string | null;
}

export interface BuildQueuesInput {
  businessId: string;
  nowMs: number;
  conversations: QueueConversation[];
  /** Pending-order evidence keyed by conversation id. */
  pendingOrderEvidence?: Record<string, IntentEvidenceInput[]>;
  /** Open-lead evidence keyed by conversation id. */
  leadEvidence?: Record<string, IntentEvidenceInput[]>;
  /** Recorded warm/hot state keyed by conversation id. */
  recordedIntent?: Record<string, "warm" | "hot">;
  /** Recorded time of the warm/hot state, keyed by conversation id. */
  recordedIntentAt?: Record<string, Date | string | number>;
  /** customerId-keyed open-lead evidence (fallback when a lead has
   *  no conversationId). Matched only to a conversation of the same
   *  business with the same customerId. */
  leadEvidenceByCustomer?: Record<string, IntentEvidenceInput[]>;
  /** Blocked flag for queue candidates only (see header). */
  customerBlockedByConversation?: Record<string, boolean>;
}

// ------------------------------------------------------------------
// Output types
// ------------------------------------------------------------------

export interface IntentEvidence {
  source: "pending_order" | "inbound_lead_open" | "recorded_intent";
  detail: string;
  recordedAtMs: number;
  recordedAtIso: string;
  orderId: string | null;
  leadStage: string | null;
}

export interface UnrepliedRow {
  conversationId: string;
  businessId: string;
  channel: string;
  customerName: string;
  customerContact: string;
  status: string;
  aiEnabled: boolean;
  waitingSinceMs: number;
  waitingSinceIso: string;
  unrepliedCount: number;
  lastCustomerPreview: string;
  lastCustomerMessageId: string | null;
  alsoHasIntent: boolean;
}

export interface OrderingIntentRow {
  conversationId: string;
  businessId: string;
  channel: string;
  customerName: string;
  customerContact: string;
  status: string;
  aiEnabled: boolean;
  intentRecordedAtMs: number;
  intentRecordedAtIso: string;
  evidence: IntentEvidence[];
  pendingOrderId: string | null;
  leadStage: string | null;
  alsoUnreplied: boolean;
}

export type ExclusionReason =
  | "foreign_business"
  | "closed_or_escalated"
  | "no_messages"
  | "no_customer_message"
  | "replied"
  | "outside_window"
  | "invalid_timestamp"
  | "customer_blocked"
  | "no_intent_evidence"
  | "intent_outside_window";

export interface ExcludedRow {
  conversationId: string;
  unrepliedReason: ExclusionReason | null;
  intentReason: ExclusionReason | null;
}

export interface QueuesResult {
  window: { days: number; startMs: number; endMs: number };
  unreplied: UnrepliedRow[];
  orderingIntent: OrderingIntentRow[];
  counts: {
    unreplied: number;
    orderingIntent: number;
    overlap: number;
  };
  overlapConversationIds: string[];
  excluded: ExcludedRow[];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Parse a recorded timestamp; NaN when it cannot be parsed. */
export function toMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const t = new Date(value as string).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function isInWindow(tMs: number, startMs: number, endMs: number): boolean {
  return !Number.isNaN(tMs) && tMs >= startMs && tMs <= endMs;
}

function preview(content: string): string {
  return (content || "").trim().slice(0, PREVIEW_CHARS);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ------------------------------------------------------------------
// Core analysis for one thread (replied test, by position)
// ------------------------------------------------------------------

interface ThreadAnalysis {
  /** Index of the last customer message, or -1. */
  lastCustomerIndex: number;
  /** Index of the last reply-role message, or -1. */
  lastReplyIndex: number;
  /** Oldest index of the current consecutive unreplied stretch. */
  stretchStartIndex: number;
  /** Customer messages in the current stretch. */
  stretchCount: number;
}

function analyseThread(messages: QueueMessage[]): ThreadAnalysis {
  let lastCustomerIndex = -1;
  let lastReplyIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === "customer") lastCustomerIndex = i;
    else if ((REPLY_ROLES as readonly string[]).includes(role)) {
      lastReplyIndex = i;
    }
    // "system" and unknown roles update neither index: they are
    // neither a customer message nor a reply (see header).
  }
  let stretchStartIndex = -1;
  let stretchCount = 0;
  if (lastCustomerIndex >= 0 && lastReplyIndex < lastCustomerIndex) {
    // Walk back over consecutive customer messages from the last one.
    stretchStartIndex = lastCustomerIndex;
    stretchCount = 0;
    for (let i = lastCustomerIndex; i >= 0; i--) {
      if (messages[i].role === "customer") {
        stretchStartIndex = i;
        stretchCount++;
      } else {
        break;
      }
    }
  }
  return { lastCustomerIndex, lastReplyIndex, stretchStartIndex, stretchCount };
}

// ------------------------------------------------------------------
// Intent evidence assembly (recorded state only — no text scanning)
// ------------------------------------------------------------------

function collectEvidence(
  input: BuildQueuesInput,
  conv: QueueConversation,
): IntentEvidence[] {
  const raw: IntentEvidenceInput[] = [
    ...(input.pendingOrderEvidence?.[conv.id] ?? []),
    ...(input.leadEvidence?.[conv.id] ?? []),
  ];
  // Customer-id fallback for leads without a conversation link:
  // only when the conversation itself carries that customerId.
  if (conv.customerId) {
    raw.push(...(input.leadEvidenceByCustomer?.[conv.customerId] ?? []));
  }
  // Recorded warm/hot state, only when the caller supplies a valid
  // class AND a time for it. An unknown class is ignored, never
  // upgraded to an intent.
  const recorded = input.recordedIntent?.[conv.id];
  const recordedAtRaw = input.recordedIntentAt?.[conv.id];
  if (
    (recorded === "warm" || recorded === "hot") &&
    recordedAtRaw !== undefined
  ) {
    raw.push({
      source: "recorded_intent",
      detail: recorded,
      businessId: conv.businessId,
      recordedAt: recordedAtRaw,
    });
  }
  const out: IntentEvidence[] = [];
  for (const e of raw) {
    // Defence in depth: evidence from another business never counts,
    // even if the caller assembled it wrongly.
    if (e.businessId !== input.businessId) continue;
    // A pending-order item must actually be pending (the route
    // supplies pending orders only; a non-pending item here is a
    // caller error and is dropped, never trusted).
    if (e.source === "pending_order" && e.detail !== "pending") continue;
    // A lead item must be in an open stage.
    if (
      e.source === "inbound_lead_open" &&
      e.leadStage !== undefined &&
      e.leadStage !== null &&
      !(OPEN_LEAD_STAGES as readonly string[]).includes(e.leadStage)
    ) {
      continue;
    }
    const recordedAtMs = toMs(e.recordedAt);
    if (Number.isNaN(recordedAtMs)) continue;
    out.push({
      source: e.source,
      detail: e.detail,
      recordedAtMs,
      recordedAtIso: iso(recordedAtMs),
      orderId: e.orderId ?? null,
      leadStage: e.leadStage ?? null,
    });
  }
  return out;
}

// ------------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------------

export function buildQueues(input: BuildQueuesInput): QueuesResult {
  const startMs = input.nowMs - WINDOW_MS;
  const endMs = input.nowMs;
  const unreplied: UnrepliedRow[] = [];
  const orderingIntent: OrderingIntentRow[] = [];
  const excluded: ExcludedRow[] = [];

  for (const conv of input.conversations) {
    let unrepliedReason: ExclusionReason | null = null;
    let intentReason: ExclusionReason | null = null;
    let unrepliedRow: UnrepliedRow | null = null;
    let intentRow: OrderingIntentRow | null = null;

    // Check order is deliberate: business, then status, then the
    // per-queue tests, then blocked LAST (see header).
    const foreign = conv.businessId !== input.businessId;
    const closedOrEscalated = (
      EXCLUDED_STATUSES as readonly string[]
    ).includes(conv.status);
    const blocked =
      input.customerBlockedByConversation?.[conv.id] === true;

    if (foreign) {
      unrepliedReason = "foreign_business";
      intentReason = "foreign_business";
    } else if (closedOrEscalated) {
      unrepliedReason = "closed_or_escalated";
      intentReason = "closed_or_escalated";
    } else {
      // ---- Unreplied test ----
      const messages = conv.messages ?? [];
      if (messages.length === 0) {
        unrepliedReason = "no_messages";
      } else {
        const a = analyseThread(messages);
        if (a.lastCustomerIndex < 0) {
          unrepliedReason = "no_customer_message";
        } else if (a.lastReplyIndex > a.lastCustomerIndex) {
          unrepliedReason = "replied";
        } else {
          const lastCustomer = messages[a.lastCustomerIndex];
          const lastMs = toMs(lastCustomer.createdAt);
          if (Number.isNaN(lastMs)) {
            unrepliedReason = "invalid_timestamp";
          } else if (!isInWindow(lastMs, startMs, endMs)) {
            unrepliedReason = "outside_window";
          } else {
            const stretchStart = messages[a.stretchStartIndex];
            const waitingMs = toMs(stretchStart.createdAt);
            if (Number.isNaN(waitingMs)) {
              unrepliedReason = "invalid_timestamp";
            } else if (blocked) {
              unrepliedReason = "customer_blocked";
            } else {
              unrepliedRow = {
                conversationId: conv.id,
                businessId: conv.businessId,
                channel: conv.channel,
                customerName: conv.customerName,
                customerContact: conv.customerContact,
                status: conv.status,
                aiEnabled: conv.aiEnabled,
                waitingSinceMs: waitingMs,
                waitingSinceIso: iso(waitingMs),
                unrepliedCount: a.stretchCount,
                lastCustomerPreview: preview(lastCustomer.content),
                lastCustomerMessageId: lastCustomer.id ?? null,
                alsoHasIntent: false,
              };
            }
          }
        }
      }

      // ---- Ordering-intent test (independent of the replied test) ----
      const evidence = collectEvidence(input, conv);
      if (evidence.length === 0) {
        intentReason = "no_intent_evidence";
      } else {
        const inWindow = evidence.filter((e) =>
          isInWindow(e.recordedAtMs, startMs, endMs),
        );
        if (inWindow.length === 0) {
          intentReason = "intent_outside_window";
        } else if (blocked) {
          intentReason = "customer_blocked";
        } else {
          const earliest = inWindow.reduce((min, e) =>
            e.recordedAtMs < min.recordedAtMs ? e : min,
          );
          const pending = evidence.find(
            (e) => e.source === "pending_order",
          );
          const lead = evidence.find(
            (e) => e.source === "inbound_lead_open",
          );
          intentRow = {
            conversationId: conv.id,
            businessId: conv.businessId,
            channel: conv.channel,
            customerName: conv.customerName,
            customerContact: conv.customerContact,
            status: conv.status,
            aiEnabled: conv.aiEnabled,
            intentRecordedAtMs: earliest.recordedAtMs,
            intentRecordedAtIso: earliest.recordedAtIso,
            evidence,
            pendingOrderId: pending?.orderId ?? null,
            leadStage: lead?.leadStage ?? null,
            alsoUnreplied: false,
          };
        }
      }
    }

    if (unrepliedRow) unreplied.push(unrepliedRow);
    if (intentRow) orderingIntent.push(intentRow);
    if (unrepliedReason || intentReason) {
      excluded.push({
        conversationId: conv.id,
        unrepliedReason,
        intentReason,
      });
    }
  }

  // Cross-flag the overlap (both lenses, same thread — see header).
  const unrepliedIds = new Set(unreplied.map((r) => r.conversationId));
  const intentIds = new Set(orderingIntent.map((r) => r.conversationId));
  const overlapConversationIds = [...unrepliedIds].filter((id) =>
    intentIds.has(id),
  );
  for (const r of unreplied) {
    if (intentIds.has(r.conversationId)) r.alsoHasIntent = true;
  }
  for (const r of orderingIntent) {
    if (unrepliedIds.has(r.conversationId)) r.alsoUnreplied = true;
  }

  // Oldest first in both queues, conversationId breaks ties.
  unreplied.sort(
    (a, b) =>
      a.waitingSinceMs - b.waitingSinceMs ||
      (a.conversationId < b.conversationId
        ? -1
        : a.conversationId > b.conversationId
          ? 1
          : 0),
  );
  orderingIntent.sort(
    (a, b) =>
      a.intentRecordedAtMs - b.intentRecordedAtMs ||
      (a.conversationId < b.conversationId
        ? -1
        : a.conversationId > b.conversationId
          ? 1
          : 0),
  );

  return {
    window: { days: WINDOW_DAYS, startMs, endMs },
    unreplied,
    orderingIntent,
    counts: {
      unreplied: unreplied.length,
      orderingIntent: orderingIntent.length,
      overlap: overlapConversationIds.length,
    },
    overlapConversationIds,
    excluded,
  };
}
