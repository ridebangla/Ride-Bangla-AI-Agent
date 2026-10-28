/**
 * LEG D (video round 2) — tenant-chosen reply APPROVAL MODE. STAGED ONLY.
 *
 * Pure, dependency-free rules. Every rule here is exercised by the leg
 * harness; route handlers and the engine call these helpers and never
 * re-derive the rules inline.
 *
 * WHAT APPROVAL MODE IS
 * ---------------------
 * Opt-in, tenant-scoped. When a tenant turns it on (Settings), the
 * agent no longer sends a reply the moment it is generated. Instead the
 * generated text becomes a DRAFT: the team reviews it on the Reply
 * approvals page, and the draft auto-sends after a configurable wait
 * unless the team acts first. The tenant's previous behaviour — direct
 * send — is the default and is untouched: approval mode is OFF unless
 * the tenant explicitly turns it on, and turning it off returns the
 * tenant to direct send for NEW turns (see the hold rules below).
 *
 * WHAT A DRAFT IS — AND IS NOT
 * -----------------------------
 * A draft is TEXT ONLY. It is never an order, a booking, a ticket, a
 * courier booking, or any other state change. Draft turns are generated
 * tool-less (the engine's approval branch never executes a tool), so no
 * pending order can be created behind a draft, and no rejected draft
 * can leave an orphan order. Sending a draft — manually or by timer —
 * writes exactly one thing: an `assistant` message row in the thread
 * (plus the channel send attempt for non-widget channels, exactly as a
 * staff reply is delivered). It never confirms anything: a confirmed
 * order stays locked and human-confirmed, and a draft can never move
 * an order into any state. This module imports no order, ticket,
 * billing, or courier code, by construction.
 *
 * TIMER MECHANICS (the contract, in one place)
 * -------------------------------------------
 * - A draft is born with `autoSendAt = createdAt + waitSeconds`, where
 *   `waitSeconds` is the tenant's setting SNAPSHOTTED at creation.
 *   Changing the setting later does not retime a live draft.
 * - On expiry with NO team action the draft SENDS (decision `send`).
 *   The sweep route is the sender; the review page never sends on GET.
 * - A team action overrides the timer, always:
 *     send-now -> sent at once, timer dead;
 *     reject   -> rejected, never sent, timer dead;
 *     edit     -> text replaced AND the timer RESTARTS from the edit
 *                 moment with the CURRENT wait setting (a team member
 *                 who just touched the text gets a fresh review window;
 *                 keeping the old deadline could fire seconds after an
 *                 edit, before anyone re-read it).
 * - The timer is DISARMED (it will not fire) while any hold condition
 *   holds, but the draft itself SURVIVES as manual-only — it is not
 *   deleted and not sent. Hold conditions, in precedence order:
 *     1. takeover active (conversation aiEnabled === false): an AI
 *        draft must never interject into a human-owned thread;
 *     2. global AI kill-switch off (settings.aiEnabled === false):
 *        the AI stays silent everywhere, drafts included;
 *     3. approval mode globally off: the tenant stopped wanting
 *        auto-send; pending drafts wait for an explicit team action;
 *     4. per-chat pause (conversation approvalPaused): this chat's
 *        timer is held until the team unpauses it.
 *   When the hold lifts, a draft already past its autoSendAt SENDS on
 *   the next sweep (prompt-fire rule) — the review window already
 *   elapsed while held. The alternative (restart a full wait on
 *   unpause) is an open owner decision, flagged in LEG-REPORT.md.
 * - The ONE hard cancellation: a CLOSED thread cancels the draft
 *   (decision `cancel`, reason `thread_closed`). A draft is never
 *   sent into a closed thread.
 * - Precedence summary (first match wins): terminal draft -> noop;
 *   closed thread -> cancel; takeover -> hold; global kill-switch
 *   off -> hold; approval mode off -> hold; per-chat pause -> hold;
 *   unparseable deadline -> hold (fail closed, never send on a bad
 *   timestamp); past deadline -> send; otherwise -> hold (waiting).
 *
 * NEW CUSTOMER MESSAGE BEFORE THE TIMER FIRES — DECIDED RULE
 * ----------------------------------------------------------
 * SUPERSEDED. A new customer message in the same conversation
 * supersedes ANY pending draft in that conversation (edited or not):
 * the old draft moves to `superseded` and is never sent, and the new
 * turn creates a fresh draft from the full history including the new
 * message. Rationale: a draft written before the newest message may
 * answer a question the customer has already changed; sending stale
 * text is worse than discarding a team edit, which is cheap to redo
 * on the fresh draft. The alternative (draft stays valid / edited
 * drafts survive) is an open owner decision, flagged in LEG-REPORT.md.
 * At most one pending draft per conversation follows from this rule.
 *
 * TENANCY + LIMITS
 * -----------------
 * Drafts carry businessId and are tenant-scoped like every other
 * tenant model; a foreign draft id answers 404, never 403, so one
 * business cannot probe another's draft ids. Draft generation spends
 * LLM tokens and is metered exactly like a normal AI reply (company
 * unlimited; trial has no usage quotas; free tier counts AI messages
 * — a draft turn IS an AI message that was generated, even though its
 * delivery is delayed). Review actions themselves (send-now, reject,
 * edit, pause) are staff actions, not AI messages, and are never
 * metered or blocked by a limit.
 *
 * REUSE, NOT DUPLICATION (verified at HEAD)
 * -----------------------------------------
 * - Human takeover + AI pause already exist (Presswayy Leg D): this
 *   leg REUSES `aiEnabled` as the takeover signal and never redefines
 *   it. Approval drafts are a separate layer on top of live turns.
 * - Agent Desk drafts (AiPraktor-booking Leg G) are drafts of AGENT
 *   RULES (behaviour prose), not of replies. They are a different
 *   object, a different collection, and a different review surface;
 *   nothing is shared and nothing is duplicated: rule drafts never
 *   become reply drafts and vice versa.
 * - No reply-draft, approval-mode, or auto-send mechanism exists at
 *   HEAD (verified: no `replyDraft`, `approvalMode`, `autoSendAt`, or
 *   `draftPending` concept anywhere in the HEAD files read). This
 *   module + its routes are the first such mechanism.
 *
 * All user-facing wording that ships with this leg is PROPOSAL for
 * owner approval — see LEG-REPORT.md. This module carries no
 * customer-facing copy except machine reason codes.
 */

export const DEFAULT_WAIT_SECONDS = 300;
export const MIN_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 86400;
export const MAX_EDIT_CHARS = 10000;
export const MAX_DRAFTS_PER_SWEEP = 200;

export type DraftStatus =
  | "pending"
  | "sending"
  | "sent"
  | "rejected"
  | "superseded"
  | "cancelled";

export type DraftAction = "send-now" | "reject" | "edit";

export type TimerDecision = "send" | "hold" | "cancel" | "noop";

export interface ApprovalSettings {
  enabled: boolean;
  waitSeconds: number;
}

export interface TimerInput {
  status: string;
  /** Conversation status string; exactly "closed" cancels (see header). */
  conversationStatus: string | null | undefined;
  /** Conversation aiEnabled flag; false = human takeover active. */
  conversationAiEnabled: boolean;
  /** Tenant approval-mode switch, current value (not snapshot). */
  approvalEnabled: boolean;
  /** Global kill-switch; false = AI silent everywhere. */
  globalAiEnabled: boolean;
  /** Per-chat pause flag on the conversation. */
  chatPaused: boolean;
  /** Draft autoSendAt as ISO string, Date, or ms number. */
  autoSendAt: string | Date | number | null | undefined;
  nowMs: number;
}

export interface TimerOutcome {
  decision: TimerDecision;
  reason: string;
}

/** Staff roles allowed to REVIEW drafts (read). Viewers may read. */
export const DRAFT_READ_ROLES: readonly string[] = [
  "viewer",
  "agent",
  "supervisor",
  "admin",
  "super_admin",
];

/** Staff roles allowed to ACT on drafts (send-now / reject / edit / pause). */
export const DRAFT_MANAGE_ROLES: readonly string[] = [
  "agent",
  "supervisor",
  "admin",
  "super_admin",
];

export function canReadDrafts(role: string | null | undefined): boolean {
  if (!role) return false;
  return (DRAFT_READ_ROLES as readonly string[]).includes(role);
}

export function canManageDrafts(role: string | null | undefined): boolean {
  if (!role) return false;
  return (DRAFT_MANAGE_ROLES as readonly string[]).includes(role);
}

/**
 * Tenant scoping: the draft's business must equal the caller's. A
 * caller with no resolved business never matches (fail closed).
 */
export function isSameTenant(
  draftBusinessId: string | null | undefined,
  callerBusinessId: string | null | undefined
): boolean {
  if (!draftBusinessId || !callerBusinessId) return false;
  return draftBusinessId === callerBusinessId;
}

/** Clamp a configured wait to [MIN, MAX]; non-finite input -> default. */
export function normalizeWaitSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WAIT_SECONDS;
  }
  const floored = Math.floor(value);
  if (floored < MIN_WAIT_SECONDS) return MIN_WAIT_SECONDS;
  if (floored > MAX_WAIT_SECONDS) return MAX_WAIT_SECONDS;
  return floored;
}

/**
 * Normalise the tenant setting. Approval mode is OPT-IN: anything
 * other than an explicit `true` means OFF. Absent wait -> default.
 */
export function normalizeApprovalSettings(raw: {
  replyApprovalEnabled?: unknown;
  replyApprovalWaitSeconds?: unknown;
}): ApprovalSettings {
  return {
    enabled: raw.replyApprovalEnabled === true,
    waitSeconds: normalizeWaitSeconds(raw.replyApprovalWaitSeconds),
  };
}

export function computeAutoSendAt(
  createdAtMs: number,
  waitSeconds: number
): string {
  return new Date(createdAtMs + waitSeconds * 1000).toISOString();
}

export function parseMs(
  value: string | Date | number | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Milliseconds remaining until auto-send; 0 once due; null if unparseable. */
export function remainingMs(
  autoSendAt: string | Date | number | null | undefined,
  nowMs: number
): number | null {
  const at = parseMs(autoSendAt);
  if (at === null) return null;
  return Math.max(0, at - nowMs);
}

export function isDraftDue(
  autoSendAt: string | Date | number | null | undefined,
  nowMs: number
): boolean {
  const at = parseMs(autoSendAt);
  if (at === null) return false;
  return nowMs >= at;
}

/**
 * The timer decision, in the precedence order stated in the header.
 * First match wins; nothing below a match is consulted.
 */
export function decideDraftTimer(input: TimerInput): TimerOutcome {
  if (input.status !== "pending") {
    return { decision: "noop", reason: "already_terminal" };
  }
  if (input.conversationStatus === "closed") {
    return { decision: "cancel", reason: "thread_closed" };
  }
  if (input.conversationAiEnabled === false) {
    return { decision: "hold", reason: "takeover_active" };
  }
  if (input.globalAiEnabled === false) {
    return { decision: "hold", reason: "ai_global_off" };
  }
  if (input.approvalEnabled === false) {
    return { decision: "hold", reason: "approval_disabled" };
  }
  if (input.chatPaused === true) {
    return { decision: "hold", reason: "chat_paused" };
  }
  const at = parseMs(input.autoSendAt);
  if (at === null) {
    return { decision: "hold", reason: "invalid_deadline" };
  }
  if (input.nowMs >= at) {
    return { decision: "send", reason: "due" };
  }
  return { decision: "hold", reason: "waiting" };
}

/** Only a pending draft can be superseded by a new customer message. */
export function isSupersedeable(status: string): boolean {
  return status === "pending";
}

/** Only a pending draft can be acted on (send-now / reject / edit). */
export function isActionable(status: string): boolean {
  return status === "pending";
}

/** Strict action parsing: anything else is a 400, never a default. */
export function parseDraftAction(value: unknown): DraftAction | null {
  if (value === "send-now" || value === "reject" || value === "edit") {
    return value;
  }
  return null;
}

/** Team edits are the only draft text a human types: non-empty, capped. */
export function validateDraftEdit(
  text: unknown
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "text must be a non-empty string" };
  }
  if (text.length > MAX_EDIT_CHARS) {
    return { ok: false, error: "text exceeds the maximum length" };
  }
  return { ok: true, text };
}

/**
 * Edit outcome: replaced text + timer RESTART from the edit moment
 * with the CURRENT wait setting (see header). Returns the fields the
 * route writes; it never mutates the stored draft itself.
 */
export function applyDraftEdit(
  editedText: string,
  editMs: number,
  currentWaitSeconds: number,
  actorId: string,
  actorName: string
): {
  editedText: string;
  autoSendAt: string;
  editedBy: string;
  editedByName: string;
  editedAt: string;
} {
  return {
    editedText,
    autoSendAt: computeAutoSendAt(editMs, normalizeWaitSeconds(currentWaitSeconds)),
    editedBy: actorId,
    editedByName: actorName,
    editedAt: new Date(editMs).toISOString(),
  };
}

/** The text that is actually delivered: edited text wins over original. */
export function draftDeliverText(draft: {
  draftText: string;
  editedText?: string | null;
}): string {
  if (
    typeof draft.editedText === "string" &&
    draft.editedText.trim().length > 0
  ) {
    return draft.editedText;
  }
  return draft.draftText;
}

/** Strict pause-body parsing: `paused` must be a real boolean. */
export function parsePaused(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}
