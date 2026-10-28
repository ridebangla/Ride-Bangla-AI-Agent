/**
 * Leg E — human-takeover handoff extras (STAGED, not yet live).
 *
 * Builds ONLY on Leg D (one-click takeover + AI pause). Leg D already
 * covers: the takeover endpoint, the pause itself, attribution, the
 * visitor notices, staff labelling, follow-up deferral, and the
 * Inbox/Conversations takeover controls. This module adds the four
 * pieces Leg D did NOT have:
 *
 *  1. A recorded handoff reason from a FIXED list.
 *  2. A business-set timer with AUTO-REVERT to the AI on expiry.
 *  3. A one-tap claim that shows how long the customer has waited.
 *  4. The "." takeover shortcut (staff reply box only).
 *
 * Pure and dependency-free, like Leg D's `lib/takeover.ts`: route
 * handlers and pages call these helpers, they never re-derive the
 * rules inline. Every rule here is exercised by the leg harness.
 *
 * Doctrines this module enforces by construction:
 * - Ordinary chat is NEVER a ticket. Nothing here imports or calls
 *   any ticket code; takeover, claim, dot-shortcut, and auto-revert
 *   create zero tickets. A ticket still needs a deliberate customer
 *   request, or an agent offer on a critical event plus consent.
 * - A MISSING PIECE OF INFORMATION ALONE IS NOT A HANDOFF REASON.
 *   The fixed list has no "missing info" value, and the resolver
 *   rejects "missing_info" / "missing_information" with its own error
 *   code so the UI can say so plainly: a missing detail means the
 *   agent asks the customer (or re-reads the thread) — it never, by
 *   itself, hands the conversation to a human.
 * - The agent NEVER confirms an order and NEVER quotes a fare. This
 *   module touches no order, price, or billing code at all.
 * - Per-surface identity is untouched: reason labels and system
 *   records name no business, so the same text is correct on every
 *   tenant surface without ever naming another business.
 * - No usage limit gates any of this: a takeover, claim, dot, or
 *   auto-revert is not an AI message and must never be blocked by a
 *   limit (company/holder unlimited, trial quota-free, free tier
 *   counts AI messages only).
 */

/** The FIXED handoff-reason list. Nothing outside it is recordable. */
export const HANDOFF_REASONS: readonly {
  value: string;
  label: string;
}[] = [
  { value: "customer_asked", label: "Customer asked for a human" },
  { value: "needs_judgment", label: "Needs human judgment" },
  { value: "angry", label: "Angry or upset customer" },
  { value: "discount_requested", label: "Discount requested" },
  { value: "complaint", label: "Complaint" },
  { value: "refund", label: "Refund" },
  { value: "outside_knowledge", label: "Outside agent knowledge" },
  { value: "ready_to_buy", label: "Ready to buy" },
  { value: "other", label: "Other" },
];

export type HandoffReason = (typeof HANDOFF_REASONS)[number]["value"];

/** How a takeover was started — kept beside the reason, never instead of it. */
export type HandoffVia = "button" | "claim" | "dot";

/** Strict reason parsing: anything outside the fixed list is null, never defaulted. */
export function parseHandoffReason(value: unknown): HandoffReason | null {
  if (typeof value !== "string") return null;
  const found = HANDOFF_REASONS.find((r) => r.value === value);
  return found ? (found.value as HandoffReason) : null;
}

/** Display label for a stored reason value; unknown values echo back, never invented. */
export function handoffReasonLabel(value: string | null | undefined): string {
  if (!value) return "";
  const found = HANDOFF_REASONS.find((r) => r.value === value);
  return found ? found.label : value;
}

/**
 * Whether a staff reply-box message is the "." takeover shortcut.
 * EXACTLY one dot (surrounding whitespace ignored). "..", ". hello",
 * and any longer text are ordinary messages. This check alone never
 * takes over: the messages route additionally requires a staff role
 * (admin/assistant) and the takeover permission, so a VISITOR typing
 * "." can never take over — a visitor has no staff session at all.
 */
export function isDotTakeover(content: unknown): boolean {
  return typeof content === "string" && content.trim() === ".";
}

/**
 * The business-set auto-revert timer, in minutes. The settings value
 * is stored as `takeoverAutoRevertMinutes` (null/0 = no auto-revert).
 * Defensive re-validation: anything outside 1..10080, non-integer, or
 * non-numeric means NO auto-revert (fail-closed to Leg D behaviour:
 * a takeover lasts until staff hand it back). Never throws.
 */
export function resolveTimerMinutes(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < 1 || value > 10080) return null;
  return value;
}

/**
 * Expiry timestamp for a takeover starting at `nowMs`, or "" when the
 * business has no timer. The expiry is SNAPSHOTTED onto the
 * conversation at takeover time: if the business later changes its
 * timer, takeovers already running keep the expiry they started with.
 */
export function computeTakeoverExpiry(
  nowMs: number,
  timerMinutes: number | null
): string {
  if (timerMinutes === null) return "";
  return new Date(nowMs + timerMinutes * 60_000).toISOString();
}

/**
 * Whether a takeover's timer has fired. Unparseable, empty, or missing
 * expiry values are NEVER expired (fail-closed: a corrupt value must
 * not silently hand a live human conversation back to the AI).
 */
export function isTakeoverExpired(
  expiresAt: unknown,
  nowMs: number
): boolean {
  if (typeof expiresAt !== "string" || expiresAt === "") return false;
  const ms = new Date(expiresAt).getTime();
  if (Number.isNaN(ms)) return false;
  return nowMs >= ms;
}

/**
 * Staff-side system record for an automatic revert. PROPOSAL wording —
 * owner approval required before shipping.
 */
export function autoRevertEventText(): string {
  return "AI resumed automatically — the takeover timer expired.";
}

/**
 * Staff-side system record for a claim transfer (one staff member
 * claiming a conversation another staff member owns). PROPOSAL
 * wording — owner approval required before shipping.
 */
export function claimTransferEventText(actorName: string): string {
  const name = actorName && actorName.trim() ? actorName.trim() : "A team member";
  return `${name} claimed this conversation.`;
}

export type TakeoverReasonError =
  | "reason_required"
  | "reason_invalid"
  | "missing_info_not_a_reason";

export type ResolvedTakeoverReason =
  | {
      ok: true;
      reason: HandoffReason | "";
      claimed: boolean;
      via: HandoffVia;
    }
  | { ok: false; error: TakeoverReasonError };

/**
 * Resolve the reason stored for a takeover action.
 *
 * - resume: the reason is always cleared ("" is returned as the
 *   cleared value by the caller; this resolver reports no reason).
 * - button takeover (staff picks from the fixed list in the thread
 *   header): a valid reason is REQUIRED — missing or invalid is a
 *   400, never a silent default.
 * - claim takeover (one tap, staff has not necessarily read the
 *   thread yet): no reason given records "other" with claimed=true,
 *   so the "other" bucket stays interpretable in reports. A reason
 *   given with a claim is stored as given.
 * - dot takeover (staff typed "."): same as a claim with no reason —
 *   "other" via "dot". The "." carries no reason by definition.
 * - "missing_info" / "missing_information" are rejected with their
 *   own error: a missing detail alone is NOT a handoff reason.
 */
export function resolveTakeoverReason(input: {
  action: "takeover" | "resume";
  reason: unknown;
  via: HandoffVia;
}): ResolvedTakeoverReason {
  if (input.action === "resume") {
    return { ok: true, reason: "", claimed: false, via: input.via };
  }
  const raw = input.reason;
  if (typeof raw === "string" && raw !== "") {
    if (raw === "missing_info" || raw === "missing_information") {
      return { ok: false, error: "missing_info_not_a_reason" };
    }
    const parsed = parseHandoffReason(raw);
    if (!parsed) return { ok: false, error: "reason_invalid" };
    return {
      ok: true,
      reason: parsed,
      claimed: input.via === "claim",
      via: input.via,
    };
  }
  if (input.via === "button") return { ok: false, error: "reason_required" };
  return {
    ok: true,
    reason: "other",
    claimed: input.via === "claim",
    via: input.via,
  };
}

/**
 * Claim transfer: a one-tap claim by a DIFFERENT staff member on a
 * conversation already taken over moves ownership to the claimer.
 * A plain button takeover by a different staff member does NOT
 * transfer (Leg D no-op behaviour preserved) — staff must claim to
 * take a conversation from a colleague, so transfers are always
 * deliberate and always leave a claim record.
 */
export function isClaimTransfer(
  currentAiEnabled: boolean,
  currentTakenOverBy: string,
  actorId: string,
  via: HandoffVia
): boolean {
  return (
    via === "claim" &&
    currentAiEnabled === false &&
    currentTakenOverBy !== "" &&
    currentTakenOverBy !== actorId
  );
}

/**
 * Reason-only update: the SAME staff member re-taking over a
 * conversation they already own with a different valid reason updates
 * just the reason (no duplicate system record, no attribution change).
 */
export function shouldUpdateReasonOnly(
  currentAiEnabled: boolean,
  currentTakenOverBy: string,
  actorId: string,
  action: "takeover" | "resume",
  reason: HandoffReason | null,
  currentReason: string
): boolean {
  return (
    action === "takeover" &&
    currentAiEnabled === false &&
    currentTakenOverBy !== "" &&
    currentTakenOverBy === actorId &&
    reason !== null &&
    reason !== currentReason
  );
}

export interface WaitableMessage {
  role: string;
  createdAt: string | Date | null | undefined;
}

export interface CustomerWait {
  /** ISO timestamp of the oldest still-unanswered customer message, or null. */
  waitingSince: string | null;
  /** Whole seconds from waitingSince to `nowMs`, or null when nobody is waiting. */
  waitSeconds: number | null;
}

function messageTimeMs(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== "string" || value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * How long the customer has waited for a human reply.
 *
 * Input: messages in ASCENDING (oldest-first) order, as the messages
 * route returns them. Walk back from the newest: customer messages
 * count; admin/assistant messages (real replies) stop the run; system
 * records are staff-side chrome, not replies, so they are SKIPPED
 * rather than breaking the run. (Deliberate, documented divergence
 * from the inbox `unread` count, which breaks on any non-customer
 * role including system records: a takeover system record must not
 * reset "how long the customer has waited".)
 *
 * Returns nulls when no customer message is unanswered, or when the
 * oldest unanswered message has no parseable timestamp (never invent
 * a wait from bad data).
 */
export function oldestUnansweredCustomerMessage(
  messagesAsc: readonly WaitableMessage[],
  nowMs: number
): CustomerWait {
  let oldestMs: number | null = null;
  for (let i = messagesAsc.length - 1; i >= 0; i--) {
    const m = messagesAsc[i];
    if (m.role === "admin" || m.role === "assistant") break;
    if (m.role !== "customer") continue;
    const ms = messageTimeMs(m.createdAt);
    if (ms !== null) oldestMs = ms;
  }
  if (oldestMs === null) return { waitingSince: null, waitSeconds: null };
  return {
    waitingSince: new Date(oldestMs).toISOString(),
    waitSeconds: Math.max(0, Math.floor((nowMs - oldestMs) / 1000)),
  };
}

/**
 * Short wait label for the claim button and list badges. PROPOSAL
 * wording — owner approval required before shipping. Deterministic:
 * whole minutes/hours/days, never a live countdown promise.
 */
export function formatWait(waitSeconds: number | null | undefined): string | null {
  if (waitSeconds === null || waitSeconds === undefined) return null;
  if (waitSeconds < 60) return "just now";
  const minutes = Math.floor(waitSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
