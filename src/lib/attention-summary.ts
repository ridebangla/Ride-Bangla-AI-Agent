/**
 * attention-summary.ts — TIPS Leg A (honest "gone quiet" concept), STAGED ONLY.
 *
 * Pure, dependency-free summary computation. No database, no network,
 * no message sending, no order/ticket/billing write, no price, total,
 * fare or currency value read, computed or returned anywhere in this
 * module. COUNTS ONLY.
 *
 * WHAT THIS MODULE IS — AND WHAT IT IS NOT
 * ----------------------------------------
 * This module layers on top of the staged Leg B follow-up queues
 * (src/lib/unreplied-queues.ts). It does NOT re-derive "replied":
 * the caller must feed it ONLY threads Leg B already classified as
 * unreplied (no recorded assistant/admin reply after the last
 * customer message, by position). The replied test, the 30-day
 * window, the status exclusions and the recorded-intent evidence
 * all stay Leg B's definitions; this module re-checks business and
 * status defensively but never re-opens the replied question.
 *
 * A thread in this summary is therefore, by construction, a thread
 * whose customer message is still waiting for a reply. This module
 * then answers ONE further, strictly recorded question: how long
 * has it been since the customer last spoke, with no reply since?
 * That silence duration is the only new signal here. Nothing in
 * this module knows — or claims — whether the customer bought
 * elsewhere, left, or will return. A quiet thread is a thread that
 * needs a human reply first; it is never presented here as proof
 * that an order was missed. The summary returns counts and a
 * capped quiet list, never a money figure.
 *
 * DEFINITIONS (the whole contract — read before changing anything)
 * ----------------------------------------------------------------
 * Inputs are recorded state only. Every timestamp is supplied by
 * the caller; this module never reads environment time (nowMs is
 * an explicit argument, so the computation is deterministic).
 *
 * SILENCE. For an unreplied thread, silenceMs = nowMs -
 * lastCustomerMs: the time since the customer's last message, with
 * no reply recorded after it. WAITING is different: waitingMs =
 * nowMs - waitingSinceMs, where waitingSince is the start of the
 * current unanswered stretch (Leg B: the oldest consecutive
 * unreplied customer message). A thread can have waited a long
 * time while its silence is short (the customer just wrote again);
 * only silence measures "gone quiet".
 *
 * BUCKETS (a partition of the unreplied input — these three counts
 * DO sum to unrepliedTotal, unlike Leg B's two overlapping lenses,
 * which must never be summed):
 *   - "recent":      silence < AT_RISK_AFTER_MS.
 *   - "atRisk":      AT_RISK_AFTER_MS <= silence < QUIET_AFTER_MS.
 *   - "goneQuiet":   silence >= QUIET_AFTER_MS.
 * "Gone quiet" therefore means, precisely: the customer message is
 * still unreplied AND the customer has not written again for at
 * least QUIET_AFTER_MS. A thread whose customer wrote yesterday is
 * NOT gone quiet, however old its stretch is.
 *
 * THRESHOLDS — STAGED PROPOSALS, NOT SILENT DEFAULTS. The constants
 * below are proposals for owner decision (see the leg report,
 * decisions D1–D2). They are echoed in every result so any reader
 * can see exactly which thresholds produced the counts, and the
 * dashboard component renders them next to the numbers. Changing
 * a threshold is a one-line change plus a re-run of the harness;
 * it must never be done silently at apply time.
 *   - PROPOSED_AT_RISK_AFTER_MS = 24 hours ("waiting over a day").
 *   - PROPOSED_QUIET_AFTER_MS   = 72 hours ("no reply and no new
 *     message for three days or more").
 * The caller may override both; overrides are validated (both
 * positive, quiet strictly greater than at-risk) and an invalid
 * pair throws instead of silently falling back to a guessed value.
 *
 * INTENT OVERLAP. alsoHasIntent comes from Leg B (the thread is
 * also in the ordering-intent queue: a pending order, an open
 * lead, or a recorded warm/hot state). goneQuietWithIntent and
 * atRiskWithIntent are SUBSETS of their buckets, never added to
 * them. unrepliedWithIntent is the subset of all unreplied
 * threads that also carry intent.
 *
 * PENDING ORDERS. Pending orders are counted separately, from
 * recorded order rows only (status must be exactly "pending";
 * confirmed/cancelled rows are dropped, never counted). Two
 * pending-order counts are reported, and neither is summed with
 * any thread count:
 *   - pendingOrdersWaiting: pending orders whose recorded age is
 *     at least QUIET_AFTER_MS — i.e. still awaiting team
 *     confirmation after three days or more. The team confirms
 *     orders; this module never confirms, edits, reopens or
 *     re-prices anything, and a waiting pending order is NOT
 *     presented as a completed, cancelled or otherwise decided
 *     order.
 *   - pendingOrdersOnGoneQuietThreads: pending orders linked to a
 *     conversation that is in the goneQuiet bucket. This differs
 *     from goneQuietWithIntent: intent also includes open leads
 *     and recorded warm/hot states, so the two numbers need not
 *     match, and neither is derived from the other.
 * Pending orders with no conversation link, or linked to a
 * conversation outside this summary, still count in
 * pendingOrdersWaiting (they are waiting regardless of thread
 * state) but never in pendingOrdersOnGoneQuietThreads.
 *
 * WINDOW INHERITANCE — HONEST LIMITATION. The unreplied input
 * comes from Leg B, whose window is the last 30 days (last
 * customer message inside [now - 30d, now]). A thread whose last
 * customer message is older than 30 days is therefore invisible
 * to this summary, however long its silence truly is. Silence in
 * this summary ranges over [QUIET_AFTER_MS, 30 days]; it is NOT
 * "every quiet thread ever". Extending the window for a quiet
 * view is an owner decision (D3), not something this module does
 * by quietly widening Leg B's window.
 *
 * OUT OF SCOPE, DELIBERATELY. (1) Threads that WERE replied to and
 * then went quiet (customer never came back after a reply) are
 * NOT counted here: they are not unreplied, and counting them
 * would mix two different situations. That is a separate concept
 * for a separate decision (D4). (2) No money figure: see the leg
 * report §5 for the PROPOSAL-ONLY money version, which is not
 * built in this module. (3) No overnight/business-hours bucket:
 * no reliable business-hours record was evidenced for this
 * purpose, so none is invented. (4) No text scanning, no
 * classifier, no intent inference from message wording.
 *
 * WORDING. This module produces NO user-facing copy. All dashboard
 * wording lives in the component as PROPOSAL for owner approval.
 */

export const PROPOSED_AT_RISK_AFTER_MS = 24 * 60 * 60 * 1000;
export const PROPOSED_QUIET_AFTER_MS = 72 * 60 * 60 * 1000;
export const LEG_B_WINDOW_DAYS = 30;

/** One Leg B unreplied thread, with the silence input this module needs. */
export interface AttentionThreadInput {
  conversationId: string;
  businessId: string;
  channel: string;
  customerName: string;
  status: string;
  aiEnabled: boolean;
  /** Leg B waitingSince: start of the current unanswered stretch. */
  waitingSinceMs: number;
  /** Time of the customer's last message (no reply after it). */
  lastCustomerMs: number;
  /** Leg B unrepliedCount: messages in the current stretch. */
  unrepliedCount: number;
  /** Leg B alsoHasIntent flag (pending order / open lead / recorded intent). */
  alsoHasIntent: boolean;
  /** True when a pending order is linked to this conversation. */
  hasPendingOrder: boolean;
}

/** One recorded pending-order row (status must be "pending"). */
export interface AttentionPendingOrderInput {
  id: string;
  businessId: string;
  conversationId: string | null;
  status: string;
  createdAtMs: number;
}

export interface BuildAttentionSummaryInput {
  businessId: string;
  nowMs: number;
  /** ONLY Leg B unreplied rows. Replied threads must never be fed in. */
  threads: AttentionThreadInput[];
  pendingOrders: AttentionPendingOrderInput[];
  /** Override the proposed thresholds (both must be supplied together). */
  atRiskAfterMs?: number;
  quietAfterMs?: number;
}

export interface QuietThreadRow {
  conversationId: string;
  channel: string;
  customerName: string;
  status: string;
  aiEnabled: boolean;
  waitingSinceMs: number;
  waitingSinceIso: string;
  lastCustomerMs: number;
  lastCustomerIso: string;
  /** Silence in hours, rounded to one decimal for display. */
  silenceHours: number;
  waitingHours: number;
  unrepliedCount: number;
  alsoHasIntent: boolean;
  hasPendingOrder: boolean;
}

export type AttentionExclusionReason =
  | "foreign_business"
  | "closed_or_escalated"
  | "invalid_timestamp";

export interface AttentionSummary {
  windowDays: number;
  thresholds: {
    atRiskAfterMs: number;
    quietAfterMs: number;
    atRiskAfterHours: number;
    quietAfterHours: number;
  };
  counts: {
    /** All unreplied threads fed in and valid. */
    unrepliedTotal: number;
    /** Partition of unrepliedTotal by silence; recent + atRisk + goneQuiet === unrepliedTotal. */
    recent: number;
    atRisk: number;
    goneQuiet: number;
    /** Subsets of the buckets above — never added to them. */
    atRiskWithIntent: number;
    goneQuietWithIntent: number;
    unrepliedWithIntent: number;
    /** Pending-order counts — separate subject, never summed with thread counts. */
    pendingOrdersTotal: number;
    pendingOrdersWaiting: number;
    pendingOrdersOnGoneQuietThreads: number;
  };
  /** Longest-waiting thread's stretch start, or null when no valid thread. */
  oldestWaitingSinceMs: number | null;
  oldestWaitingSinceIso: string | null;
  /** Longest silence among valid unreplied threads, in hours (1 decimal), or null. */
  longestSilenceHours: number | null;
  /** Gone-quiet threads, longest silence first, then conversationId. */
  quietThreads: QuietThreadRow[];
  excluded: Array<{
    conversationId: string;
    reason: AttentionExclusionReason;
  }>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function hours(ms: number): number {
  return Math.round((ms / (60 * 60 * 1000)) * 10) / 10;
}

function isValidMs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function buildAttentionSummary(
  input: BuildAttentionSummaryInput,
): AttentionSummary {
  const atRiskAfterMs =
    input.atRiskAfterMs ?? PROPOSED_AT_RISK_AFTER_MS;
  const quietAfterMs = input.quietAfterMs ?? PROPOSED_QUIET_AFTER_MS;
  if (
    !isValidMs(atRiskAfterMs) ||
    !isValidMs(quietAfterMs) ||
    atRiskAfterMs <= 0 ||
    quietAfterMs <= atRiskAfterMs
  ) {
    throw new Error(
      "Invalid attention thresholds: atRiskAfterMs must be positive and quietAfterMs must be strictly greater.",
    );
  }

  let recent = 0;
  let atRisk = 0;
  let goneQuiet = 0;
  let atRiskWithIntent = 0;
  let goneQuietWithIntent = 0;
  let unrepliedWithIntent = 0;
  let oldestWaitingSinceMs: number | null = null;
  let longestSilenceMs = -1;
  const quietThreads: QuietThreadRow[] = [];
  const excluded: AttentionSummary["excluded"] = [];
  const goneQuietIds = new Set<string>();

  for (const t of input.threads) {
    if (t.businessId !== input.businessId) {
      excluded.push({ conversationId: t.conversationId, reason: "foreign_business" });
      continue;
    }
    if (t.status === "closed" || t.status === "escalated") {
      excluded.push({ conversationId: t.conversationId, reason: "closed_or_escalated" });
      continue;
    }
    if (
      !isValidMs(t.waitingSinceMs) ||
      !isValidMs(t.lastCustomerMs)
    ) {
      excluded.push({ conversationId: t.conversationId, reason: "invalid_timestamp" });
      continue;
    }
    const silenceMs = input.nowMs - t.lastCustomerMs;
    const waitingMs = input.nowMs - t.waitingSinceMs;
    // A future-dated last-customer record is clock skew, not proof
    // of recency: it cannot be bucketed honestly, so it is excluded
    // rather than assumed recent (mirrors Leg B's future exclusion).
    if (silenceMs < 0 || waitingMs < 0) {
      excluded.push({ conversationId: t.conversationId, reason: "invalid_timestamp" });
      continue;
    }
    if (t.alsoHasIntent) unrepliedWithIntent += 1;
    if (oldestWaitingSinceMs === null || t.waitingSinceMs < oldestWaitingSinceMs) {
      oldestWaitingSinceMs = t.waitingSinceMs;
    }
    if (silenceMs > longestSilenceMs) longestSilenceMs = silenceMs;

    if (silenceMs >= quietAfterMs) {
      goneQuiet += 1;
      if (t.alsoHasIntent) goneQuietWithIntent += 1;
      goneQuietIds.add(t.conversationId);
      quietThreads.push({
        conversationId: t.conversationId,
        channel: t.channel,
        customerName: t.customerName,
        status: t.status,
        aiEnabled: t.aiEnabled,
        waitingSinceMs: t.waitingSinceMs,
        waitingSinceIso: iso(t.waitingSinceMs),
        lastCustomerMs: t.lastCustomerMs,
        lastCustomerIso: iso(t.lastCustomerMs),
        silenceHours: hours(silenceMs),
        waitingHours: hours(waitingMs),
        unrepliedCount: t.unrepliedCount,
        alsoHasIntent: t.alsoHasIntent,
        hasPendingOrder: t.hasPendingOrder,
      });
    } else if (silenceMs >= atRiskAfterMs) {
      atRisk += 1;
      if (t.alsoHasIntent) atRiskWithIntent += 1;
    } else {
      recent += 1;
    }
  }

  // Longest silence first: the smallest lastCustomerMs has waited
  // longest without a new message, so sort lastCustomerMs ascending.
  quietThreads.sort(
    (a, b) =>
      a.lastCustomerMs - b.lastCustomerMs ||
      (a.conversationId < b.conversationId
        ? -1
        : a.conversationId > b.conversationId
          ? 1
          : 0),
  );

  let pendingOrdersTotal = 0;
  let pendingOrdersWaiting = 0;
  let pendingOrdersOnGoneQuietThreads = 0;
  for (const o of input.pendingOrders) {
    if (o.businessId !== input.businessId) continue;
    if (o.status !== "pending") continue;
    if (!isValidMs(o.createdAtMs)) continue;
    pendingOrdersTotal += 1;
    const ageMs = input.nowMs - o.createdAtMs;
    if (ageMs < 0) continue;
    if (ageMs >= quietAfterMs) pendingOrdersWaiting += 1;
    if (o.conversationId !== null && goneQuietIds.has(o.conversationId)) {
      pendingOrdersOnGoneQuietThreads += 1;
    }
  }

  const unrepliedTotal = recent + atRisk + goneQuiet;
  return {
    windowDays: LEG_B_WINDOW_DAYS,
    thresholds: {
      atRiskAfterMs,
      quietAfterMs,
      atRiskAfterHours: atRiskAfterMs / (60 * 60 * 1000),
      quietAfterHours: quietAfterMs / (60 * 60 * 1000),
    },
    counts: {
      unrepliedTotal,
      recent,
      atRisk,
      goneQuiet,
      atRiskWithIntent,
      goneQuietWithIntent,
      unrepliedWithIntent,
      pendingOrdersTotal,
      pendingOrdersWaiting,
      pendingOrdersOnGoneQuietThreads,
    },
    oldestWaitingSinceMs,
    oldestWaitingSinceIso:
      oldestWaitingSinceMs === null ? null : iso(oldestWaitingSinceMs),
    longestSilenceHours:
      longestSilenceMs < 0 ? null : hours(longestSilenceMs),
    quietThreads,
    excluded,
  };
}
