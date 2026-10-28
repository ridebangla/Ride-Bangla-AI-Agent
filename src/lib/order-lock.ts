/**
 * order-lock.ts — LEG B (AiPraktor-booking batch, STAGED ONLY).
 *
 * The shared human-confirm-only + LOCKED guard for orders AND bookings.
 *
 * DOCTRINE ENFORCED HERE (owner, binding):
 * - Confirmation is a HUMAN-dashboard action only. The agent NEVER
 *   confirms, cancels, or reopens an order/booking by itself, and
 *   customer chat NEVER changes a confirmed record. There is no
 *   auto-confirm path, switch, or setting in this module, and none
 *   was found in the HEAD code it guards (see LEG-REPORT.md §2) —
 *   the guard below makes such a path impossible at the data layer
 *   even if a future tool or route tried to add one, because every
 *   status write must pass `planHumanStatusChange` with a human
 *   actor, and every agent/chat edit must pass `guardAgentEdit`.
 * - Once human-confirmed, a record is LOCKED: agent edits and
 *   customer-chat changes are refused outright. The agent's only
 *   move on a locked record is the one the order-power build already
 *   provides — record the customer's exact change request as a
 *   ticket for the team to decide, leaving the record untouched.
 * - Any post-confirmation change (human reopen, human cancel of a
 *   confirmed record, human edit) requires a HUMAN action AND an
 *   audit entry appended to the record in the same write. No audit
 *   entry, no change — that is the rule the persistence caller must
 *   honour by writing exactly what `planHumanStatusChange` returns.
 * - The agent NEVER quotes fares. Nothing in this module reads,
 *   writes, or derives a price, total, or delivery charge.
 *
 * GENERIC BY DESIGN (Leg A bookings + existing orders share it):
 * this module operates on the structural `LockableRecord` shape
 * ({ id, businessId?, status, lockedAt?, lockAudit? }) and never
 * imports order or booking code. A booking record is locked by the
 * exact same rule — status "confirmed" — so Leg A consumes it by
 * passing its booking record through `guardAgentEdit` /
 * `planHumanStatusChange` (worked call sketch in LEG-REPORT.md §6).
 * No order/booking file is modified by this module itself.
 *
 * CANCELLATION WINDOW — explicitly NOT decided here: no time cutoff
 * is enforced in code (`CANCELLATION_RULE.enforcedCutoff === null`).
 * Cancellation is human-only + audited, always; the final window
 * (e.g. until rider pickup, until dispatch, until delivery) is an
 * OWNER DECISION (see LEG-REPORT.md §7, decision D1). Encoding a
 * cutoff without that decision would silently pick a window that
 * could break the lock, so this module refuses to pick one.
 *
 * WORDING — everything customer-facing in this file is a PROPOSAL
 * for owner approval, never silently shipped copy:
 * - `customerStatusWord` reuses the Leg C (Presswayy batch) customer
 *   words verbatim ("Waiting for team confirmation" /
 *   "Order confirmed" / "Order cancelled") so the customer hears ONE
 *   vocabulary, not two competing ones. Leg C already marks those
 *   words PROPOSAL; this module does the same.
 * - `teamStatusLabel` is a functional label ("Confirmed · Locked"),
 *   not marketing copy: it exists so simplified customer wording can
 *   NEVER hide the lock state from the team.
 *
 * This module has ZERO runtime imports (types only, erased at
 * compile), so it is unit-testable in isolation and cannot pull in
 * a data layer by accident. All database IO lives in the callers
 * (src/lib/orders.ts `setOrderStatus`, Leg A booking writers), which
 * persist exactly what the plan functions return.
 */

// ---------------------------------------------------------------------------
// Shapes (structural — compatible with src/lib/models.ts Order by shape,
// and with any booking record that carries a status string)
// ---------------------------------------------------------------------------

export type RecordStatus = "pending" | "confirmed" | "cancelled";

/** Who is attempting the change. Only "human" may write status. */
export type LockActorType = "human" | "agent" | "customer" | "system";

export interface LockableRecord {
  id: string;
  businessId?: string;
  status: string;
  /** ISO timestamp set at human confirmation; null/absent otherwise. */
  lockedAt?: unknown;
  /** Append-only audit trail; entries are LockAuditEntry JSON. */
  lockAudit?: unknown;
}

export interface LockAuditEntry {
  /** ISO timestamp of the change. */
  at: string;
  actorType: LockActorType;
  /** Dashboard user id, or "api-key:<id>" for key callers; null when
   *  the caller did not supply a verified actor (legacy path — the
   *  entry is then flagged actorUnverified, never invented). */
  actorId: string | null;
  action:
    | "confirm"
    | "cancel"
    | "reopen_to_pending"
    | "status_reaffirmed"
    | "edit_blocked";
  fromStatus: string;
  toStatus: string;
  /** Content fields the change touched (status changes: ["status"]). */
  fieldsChanged: string[];
  /** Human-supplied reason, or null when none was given. */
  reason: string | null;
  /** True when a post-confirmation change was allowed without a
   *  reason — visible to the team, so a missing reason is never
   *  silently papered over. */
  reasonMissing: boolean;
  /** True only on the legacy unsigned path (setOrderStatus called
   *  without actor options). Real dashboard calls always verify. */
  actorUnverified?: boolean;
  conversationId?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Statuses that mean LOCKED (agent/chat edits refused). Exactly one:
 *  "confirmed". "cancelled" is terminal for agent/chat edits too (see
 *  guardAgentEdit), but it is NOT the lock — a cancelled record is
 *  refused for a different reason, and the team label differs. */
export const LOCKED_STATUSES: readonly string[] = ["confirmed"];

/** Statuses the platform issues. Anything else fails closed. */
export const KNOWN_STATUSES: readonly string[] = [
  "pending",
  "confirmed",
  "cancelled",
];

/**
 * Cancellation rule, stated explicitly so no reader has to guess:
 * cancellation is HUMAN-ONLY with an audit entry, in every case.
 * enforcedCutoff is null ON PURPOSE — the time window is an owner
 * decision (LEG-REPORT.md §7 D1), not a value this module invents.
 * The decision menu the owner is being asked to choose from:
 *   (a) until rider pickup, (b) until dispatch, (c) until delivery,
 *   (d) no time cutoff (human judgement every time).
 * Until the owner picks, (d) is the effective behaviour.
 */
export const CANCELLATION_RULE = {
  actor: "human_only_with_audit" as const,
  agentMayCancel: false,
  chatMayCancel: false,
  enforcedCutoff: null as string | null,
  windowDecision: "OWNER_DECISION" as const,
} as const;

// ---------------------------------------------------------------------------
// Lock state
// ---------------------------------------------------------------------------

/** True when the record is LOCKED (human-confirmed). */
export function isLocked(record: LockableRecord): boolean {
  return record.status === "confirmed";
}

/** True for a status value that means LOCKED. */
export function isLockedStatus(status: string): boolean {
  return LOCKED_STATUSES.includes(status);
}

/** True when the status is one the platform issues. */
export function isKnownStatus(status: string): boolean {
  return KNOWN_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Agent / chat edit guard (the lock itself)
// ---------------------------------------------------------------------------

export type AgentEditDecision =
  | { allowed: true; locked: false; reason: "ok" }
  | {
      allowed: false;
      locked: boolean;
      reason: "order_locked" | "order_cancelled" | "unknown_status";
    };

/**
 * The lock guard every agent/chat edit path must call AFTER loading
 * the record and IMMEDIATELY BEFORE writing — never only at plan
 * time, because a human may confirm between plan and write. A
 * "pending" record is editable; anything else is refused:
 * - confirmed → order_locked (record the request for the team;
 *   never touch the record — order-power's change_order already
 *   does exactly this, and this guard is its write-time backstop).
 * - cancelled → order_cancelled (offer a new order / team help).
 * - unknown status → refused, fail closed.
 * The reason code "order_locked" deliberately matches the
 * Presswayy-batch Leg H coupon refusal code, so locked refusals
 * read the same everywhere.
 */
export function guardAgentEdit(record: LockableRecord): AgentEditDecision {
  if (record.status === "pending") {
    return { allowed: true, locked: false, reason: "ok" };
  }
  if (record.status === "confirmed") {
    return { allowed: false, locked: true, reason: "order_locked" };
  }
  if (record.status === "cancelled") {
    return { allowed: false, locked: false, reason: "order_cancelled" };
  }
  return { allowed: false, locked: false, reason: "unknown_status" };
}

/**
 * Agent/chat/customer callers may NEVER write status, in any
 * direction — not even pending → confirmed. Only "human" passes.
 * ("system" is denied too: the courier bridge is a CONSEQUENCE of a
 * human confirmation, never a status writer itself.)
 */
export function guardAgentStatusChange(actorType: LockActorType): {
  allowed: boolean;
  reason: "ok" | "agent_may_not_confirm";
} {
  if (actorType === "human") return { allowed: true, reason: "ok" };
  return { allowed: false, reason: "agent_may_not_confirm" };
}

// ---------------------------------------------------------------------------
// Human status-change plan (confirm / cancel / reopen + audit entry)
// ---------------------------------------------------------------------------

export interface HumanStatusChangeInput {
  record: LockableRecord;
  toStatus: string;
  actorType: LockActorType;
  actorId?: string | null;
  /** Optional human reason (dashboard may pass body.reason). */
  reason?: string | null;
  conversationId?: string | null;
  nowIso: string;
}

export type HumanStatusChangePlan =
  | {
      allowed: true;
      action: LockAuditEntry["action"];
      /** What the persistence caller must write, atomically with
       *  the status: lockedAt value (a timestamp, null to clear,
       *  or undefined to leave untouched). */
      setLockedAt: string | null | undefined;
      auditEntry: LockAuditEntry;
      /** Post-confirmation change? (from confirmed, or to confirmed
       *  from any state — both are lock-relevant transitions.) */
      isPostConfirmationChange: boolean;
    }
  | {
      allowed: false;
      reason: "agent_may_not_confirm" | "unknown_status" | "invalid_status";
      message: string;
    };

function cleanReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim().slice(0, 500);
  return trimmed === "" ? null : trimmed;
}

/**
 * Plan one human status change and build its audit entry. Rules:
 * - Non-human actor → denied, always, before anything else.
 * - Unknown target status → denied (invalid_status).
 * - Unknown current status → denied, fail closed (unknown_status).
 * - Same status → allowed as "status_reaffirmed" with an audit
 *   entry (preserves HEAD's idempotent re-confirm behaviour, which
 *   re-runs the courier bridge; the re-affirmation is now visible
 *   in the trail instead of silent).
 * - pending → confirmed: allowed; action "confirm"; lockedAt = now
 *   (the lock is born here); audit entry appended in the same write.
 * - pending → cancelled: allowed; action "cancel"; lockedAt untouched.
 * - confirmed → pending ("reopen"): allowed ONLY as a human action
 *   with an audit entry; lockedAt cleared (the record becomes
 *   agent-editable again, exactly as order-power's current-status
 *   rule expects — but now the reopening is audited and visible,
 *   instead of a silent un-lock). reasonMissing is flagged when no
 *   reason was supplied.
 * - confirmed → cancelled: allowed human-only + audit; lockedAt is
 *   RETAINED (the record keeps its lock history; cancellation does
 *   not rewrite when it was confirmed).
 * - cancelled → pending/confirmed: allowed human-only + audit
 *   (HEAD permits resurrection through the same PATCH; this module
 *   does NOT invent a cancelled-is-terminal rule — that is owner
 *   decision D2. What it guarantees is that any resurrection is a
 *   human act with an audit entry, never an agent act.)
 * - A post-confirmation change with no reason is ALLOWED but flagged
 *   (reasonMissing: true) rather than blocked: blocking it would
 *   break the existing dashboard buttons, which send no reason
 *   today. The flag keeps the gap visible until a reason input
 *   exists (follow-up F1 in LEG-REPORT.md).
 */
export function planHumanStatusChange(
  input: HumanStatusChangeInput
): HumanStatusChangePlan {
  const { record, toStatus } = input;
  if (input.actorType !== "human") {
    return {
      allowed: false,
      reason: "agent_may_not_confirm",
      message: "Only a human team member may confirm, cancel, or reopen an order.",
    };
  }
  if (!KNOWN_STATUSES.includes(toStatus)) {
    return {
      allowed: false,
      reason: "invalid_status",
      message: `Invalid status: ${toStatus}`,
    };
  }
  if (!KNOWN_STATUSES.includes(record.status)) {
    return {
      allowed: false,
      reason: "unknown_status",
      message: `Current status "${record.status}" is not a known status; refusing to change it.`,
    };
  }
  const reason = cleanReason(input.reason ?? null);
  const fromStatus = record.status;
  const isPostConfirmationChange =
    fromStatus === "confirmed" || toStatus === "confirmed";
  const actorUnverified = input.actorId === null || input.actorId === undefined;

  let action: LockAuditEntry["action"];
  let setLockedAt: string | null | undefined;
  if (fromStatus === toStatus) {
    action = "status_reaffirmed";
    setLockedAt = undefined;
  } else if (fromStatus === "pending" && toStatus === "confirmed") {
    action = "confirm";
    setLockedAt = input.nowIso;
  } else if (fromStatus === "pending" && toStatus === "cancelled") {
    action = "cancel";
    setLockedAt = undefined;
  } else if (fromStatus === "confirmed" && toStatus === "pending") {
    action = "reopen_to_pending";
    setLockedAt = null;
  } else if (fromStatus === "confirmed" && toStatus === "cancelled") {
    action = "cancel";
    setLockedAt = undefined;
  } else {
    // cancelled → pending / cancelled → confirmed (human resurrection).
    action = toStatus === "confirmed" ? "confirm" : "reopen_to_pending";
    setLockedAt = toStatus === "confirmed" ? input.nowIso : null;
  }

  return {
    allowed: true,
    action,
    setLockedAt,
    isPostConfirmationChange,
    auditEntry: {
      at: input.nowIso,
      actorType: "human",
      actorId: input.actorId ?? null,
      action,
      fromStatus,
      toStatus,
      fieldsChanged: ["status"],
      reason,
      reasonMissing: isPostConfirmationChange && reason === null,
      ...(actorUnverified ? { actorUnverified: true as const } : {}),
      conversationId: input.conversationId ?? null,
    },
  };
}

/** Append an audit entry to an existing trail WITHOUT mutating it
 *  (pure: returns a new array). Non-array trails degrade to []. */
export function appendAuditTrail(
  existing: unknown,
  entry: LockAuditEntry
): LockAuditEntry[] {
  const trail = Array.isArray(existing)
    ? (existing as LockAuditEntry[])
    : [];
  return [...trail, entry];
}

// ---------------------------------------------------------------------------
// Agent tool inventory guard (human-confirm-only, static check)
// ---------------------------------------------------------------------------

/**
 * Static inventory check: no agent tool name may be a confirm /
 * approve / status-write / cancel capability. Run against the live
 * `agentTools` name list at apply time (and in CI after any tool
 * change). "take_order" is NOT a violation: it creates PENDING
 * records only, and its name contains no confirm/status verb.
 * Returns the violating names (empty = clean).
 */
export function assertNoAgentConfirmTool(toolNames: string[]): string[] {
  const FORBIDDEN = /(confirm|approve|set_?order_?status|update_?order_?status|set_?status|change_?status|cancel_?order|cancel_?booking)/i;
  return toolNames.filter((name) => FORBIDDEN.test(name));
}

// ---------------------------------------------------------------------------
// Status wording: team (never hides the lock) vs customer (simpler)
// ---------------------------------------------------------------------------

/**
 * TEAM label — functional, always lock-explicit. A confirmed record
 * is never shown to the team as bare "Confirmed": the lock rides
 * with it, so no team member can mistake a locked record for an
 * editable one. (Dashboard diff LB-04 renders this as a "Locked"
 * badge beside the status.)
 */
export function teamStatusLabel(record: LockableRecord): string {
  if (record.status === "confirmed") return "Confirmed · Locked";
  if (record.status === "pending") return "Pending";
  if (record.status === "cancelled") return "Cancelled";
  return "Unknown status";
}

/**
 * CUSTOMER word — PROPOSAL (owner approval required before any UI
 * or prompt uses it). Deliberately simpler than the team label, and
 * deliberately the SAME three words Leg C (Presswayy batch) staged
 * for customer tracking views, so customers hear one vocabulary:
 *   pending   → "Waiting for team confirmation"
 *   confirmed → "Order confirmed"
 *   cancelled → "Order cancelled"
 * Unknown statuses return null: the caller must not display a
 * status word it cannot stand behind (never a guessed word).
 * NOTE: for bookings, Leg A should voice the same words with
 * "Booking" in place of "Order" only after owner approval — this
 * function does not silently substitute, because that would be
 * invented copy for a surface this leg does not own.
 */
export function customerStatusWord(status: string): string | null {
  if (status === "pending") return "Waiting for team confirmation";
  if (status === "confirmed") return "Order confirmed";
  if (status === "cancelled") return "Order cancelled";
  return null;
}
