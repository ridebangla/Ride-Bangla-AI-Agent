/**
 * CENTRAL SEND-GATE — Leg E (owner offer + reply control batch).
 *
 * Real repo path: src/lib/owner-controls/send-gate.ts (NEW file).
 * Pure module: zero imports, zero I/O, zero defaults. It never sends
 * anything, never rewrites content, and never invents an amount, a
 * text, or a timing.
 *
 * DOCTRINE (owner, 2026-10-25, FIRM, safety-critical): the AI NEVER
 * sends an offer on its own. A send may proceed ONLY when ALL hold:
 *   (a) the owner enabled that offer/reply type,
 *   (b) it is not currently paused,
 *   (c) the amount / text / timing comes from owner configuration
 *       (never a default, never a guess).
 * Any failure -> the send is BLOCKED, nothing goes out, and the block
 * is logged with a machine reason. Fail-closed throughout: a missing
 * control record, a failed resolver, an unknown type, or an empty
 * tenant context all block.
 *
 * SCOPE — what this gate covers (offer-sends specifically):
 *   coupon preview + coupon application, video-review asks + rewards,
 *   follow-ups, booking reminders, review asks, order-status messages,
 *   ad-draft publishing, reply-approval auto-send, broadcasts.
 * OUT OF SCOPE, deliberately: ordinary conversational replies (the
 * agent answering a customer is the product itself, not an offer-send),
 * and order confirmation (which stays human-team only per the standing
 * lifecycle doctrine — this gate adds an offer-send guard alongside
 * that rule, it does not change it).
 *
 * PLACEMENT (merger rule): insert the gate check AFTER every existing
 * suppression check (review doctrine, human takeover, platform
 * windows, already-ordered / number-left, closed thread) and BEFORE
 * the send. The gate only ADDS owner control on top; a gate-allowed
 * result must never override an existing suppression that already
 * blocked the send.
 *
 * CONFIG RESOLVER: this module does NOT pick where owner controls
 * live. The caller supplies a SendGateConfigResolver. Where a staged
 * path's config shape is undecided (see LEG-REPORT §5), the resolver
 * returns null until the owning leg lands its store — which blocks
 * the send by design. Never map "a coupon exists" or "a template
 * exists" to enabled: existence is not enablement.
 */

// ---------------------------------------------------------------------------
// Type registry — the ONLY send types the gate recognises. Any other
// string is blocked as unknown_type. Add a type here only with a
// matching OwnerSendControl record and a merger checklist entry.
// ---------------------------------------------------------------------------

export const SEND_TYPES = [
  // Presswayy Leg H coupons: preview states a discount; apply stamps it.
  "coupon_preview",
  "coupon_apply",
  // Video-review loop: Leg A ask (Leg B template + incentive line),
  // Leg D reward issuance through the Leg H coupon engine.
  "video_review_ask",
  "video_review_reward",
  // AiPraktor Leg F follow-ups (+ video2 Leg I settings layer, same loop).
  "followup_warm",
  "followup_hot",
  // AiPraktor Leg F broadcasts (extension of the mandated list: a
  // broadcast is a proactive reply-send, so the doctrine covers it).
  "followup_broadcast",
  // AiPraktor Leg D booking reminders (day-before + hours-before).
  "reminder_booking_day_before",
  "reminder_booking_hours_before",
  // Review asks: HEAD generic ask, and AiPraktor Leg I delivered ask.
  "review_ask_text",
  "review_ask_delivered",
  // Presswayy Leg C order-status pushes (confirmed / cancelled).
  "order_status_update",
  // Video-review Leg E: building a draft is NOT a send; publishing is.
  "ad_draft_publish",
  // Video2 Leg D reply-approval: the sweep's auto-send delivery.
  "reply_approval_auto_send",
] as const;

export type SendType = (typeof SEND_TYPES)[number];

export function isKnownSendType(value: string): value is SendType {
  return (SEND_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Owner control record — the shape Legs B/C/D (offers / messages /
// rules controls) MUST store per (businessId, sendType). Proposed
// collection: `ownerSendControls`, doc id `${businessId}_${sendType}`.
// This module only reads this shape; it never writes it.
// ---------------------------------------------------------------------------

export interface OwnerSendControl {
  businessId: string;
  sendType: SendType;
  /** Owner explicitly enabled this send type. Anything but true blocks. */
  enabled: boolean;
  /** Owner paused this send type (temporary off, NOT deleted). */
  paused: boolean;
  /**
   * Optional timed pause: paused until this epoch ms. When SET, it
   * governs the pause on its own: a future value pauses, a past
   * value auto-resumes even if `paused` is still true (a timed pause
   * must end on its own, or "pause for a time" could never lapse).
   * When UNSET, `paused` governs (indefinite pause until the owner
   * clears it). Legs B/C/D must therefore implement "pause for a
   * time" as pausedUntilMs set (flag value irrelevant after lapse),
   * and "pause until I say so" as paused=true with no pausedUntilMs.
   */
  pausedUntilMs?: number | null;
  /**
   * Owner-configured amount, where the type is amount-bearing AND the
   * control record itself is the amount source (video-review reward
   * config). Coupon types deliberately do NOT use this field: the
   * coupon doc is the amount source there, and Leg H's own decision
   * function validates it. See decideSendGate content rules.
   */
  amount?: number | null;
  /** Owner-configured expiry (last valid day, YYYY-MM-DD), if any. */
  expiry?: string | null;
  /**
   * Id + version of the owner-approved template the send was rendered
   * from, when the controlling leg tracks templates. When set on the
   * control and supplied by the caller with a different value, the
   * send is blocked as content_mismatch. When the caller omits it,
   * the gate cannot prove template provenance — see LEG-REPORT §5.
   */
  templateRef?: string | null;
}

// ---------------------------------------------------------------------------
// Caller-supplied content — the exact payload about to be sent. The
// gate checks it, echoes it unchanged, and NEVER rewrites it.
// ---------------------------------------------------------------------------

export interface SendGateContent {
  /** Coupon code about to be previewed / applied (coupon types). */
  couponCode?: string | null;
  /** Amount about to be stated / granted (discount, reward). */
  amount?: number | null;
  /** Final rendered text about to be sent (text types). */
  text?: string | null;
  /** Expiry about to be stated / stamped (reward type). */
  expiry?: string | null;
  /** Template id + version the text was rendered from, if tracked. */
  templateRef?: string | null;
  /** Scheduled fire time (reminder types) — presence-checked only;
   * correct derivation stays the scheduler's job. */
  sendAtMs?: number | null;
  /** Ad publish only: the tenant's explicit per-draft approval. */
  approvalConfirmed?: boolean | null;
  /** Broadcast only: Leg F's mandatory test-send already sent. */
  testSendConfirmed?: boolean | null;
}

export type SendGateBlockReason =
  | "unknown_type"
  | "missing_business"
  | "cross_tenant"
  | "missing_config"
  | "disabled"
  | "paused"
  | "content_missing"
  | "content_mismatch";

export interface SendGateInput {
  businessId: string;
  /** Any string: unknown values block as unknown_type (fail-closed). */
  sendType: string;
  /** Null = no owner control record exists -> blocked. */
  control: OwnerSendControl | null;
  /** Content about to be sent; null = no content supplied. */
  content?: SendGateContent | null;
  nowMs?: number;
}

export type SendGateDecision =
  | {
      allowed: true;
      sendType: SendType;
      businessId: string;
      /** Echoed verbatim — the gate never rewrites content. */
      content: SendGateContent | null;
    }
  | {
      allowed: false;
      sendType: string;
      businessId: string;
      reason: SendGateBlockReason;
      detail: string;
    };

// Types whose content must carry a non-empty final text.
const TEXT_TYPES: readonly SendType[] = [
  "video_review_ask",
  "followup_warm",
  "followup_hot",
  "followup_broadcast",
  "reminder_booking_day_before",
  "reminder_booking_hours_before",
  "review_ask_text",
  "review_ask_delivered",
  "order_status_update",
  "ad_draft_publish",
  "reply_approval_auto_send",
];

// Types whose amount + expiry must match the control record EXACTLY
// when the control carries them. Only video_review_reward qualifies:
// its control record IS the reward config (Leg D's
// video_review_reward_configs). Coupon amounts are validated by Leg H.
const EXACT_CONTENT_TYPES: readonly SendType[] = ["video_review_reward"];

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A pause is live when: a pausedUntilMs is set and still in the
 * future, OR no pausedUntilMs is set and the paused flag is true.
 * A lapsed pausedUntilMs auto-resumes regardless of the flag.
 */
export function isPaused(
  control: OwnerSendControl,
  nowMs: number,
): boolean {
  if (
    control.pausedUntilMs !== null &&
    control.pausedUntilMs !== undefined
  ) {
    return control.pausedUntilMs > nowMs;
  }
  return control.paused === true;
}

function block(
  input: SendGateInput,
  reason: SendGateBlockReason,
  detail: string,
): SendGateDecision {
  return {
    allowed: false,
    sendType: input.sendType,
    businessId: input.businessId,
    reason,
    detail,
  };
}

/**
 * Pure gate decision. No I/O, no defaults, no content rewriting.
 * Check order is deliberate: unknown type first (never trust the
 * label), then tenant context, then control existence, then enable,
 * then pause, then content provenance.
 */
export function decideSendGate(input: SendGateInput): SendGateDecision {
  const nowMs = input.nowMs ?? Date.now();
  const content = input.content ?? null;

  if (!isKnownSendType(input.sendType)) {
    return block(input, "unknown_type", "send type is not registered");
  }
  const sendType: SendType = input.sendType;

  if (!isNonEmptyText(input.businessId)) {
    return block(input, "missing_business", "no tenant context");
  }

  const control = input.control;
  if (control === null) {
    return block(input, "missing_config", "no owner control record");
  }
  if (control.businessId !== input.businessId) {
    return block(input, "cross_tenant", "control belongs to another tenant");
  }
  if (control.sendType !== sendType) {
    return block(input, "missing_config", "control is for another send type");
  }
  if (control.enabled !== true) {
    return block(input, "disabled", "owner has not enabled this send type");
  }
  if (isPaused(control, nowMs)) {
    return block(input, "paused", "owner paused this send type");
  }

  // --- Content provenance: amount / text / timing from owner config.
  if (sendType === "coupon_preview" || sendType === "coupon_apply") {
    if (!isNonEmptyText(content?.couponCode)) {
      return block(input, "content_missing", "coupon code missing");
    }
    if (!isFiniteNumber(content?.amount) || (content?.amount as number) < 0) {
      return block(input, "content_missing", "discount amount missing");
    }
    // Exact coupon value/expiry validation stays with Leg H's
    // decideCouponApplication against the coupon doc — the gate does
    // not duplicate it and must not invent a second coupon truth.
  }

  if ((TEXT_TYPES as readonly string[]).includes(sendType)) {
    if (!isNonEmptyText(content?.text)) {
      return block(input, "content_missing", "send text missing");
    }
  }

  if (
    sendType === "reminder_booking_day_before" ||
    sendType === "reminder_booking_hours_before"
  ) {
    if (!isFiniteNumber(content?.sendAtMs)) {
      return block(input, "content_missing", "scheduled time missing");
    }
  }

  if (sendType === "ad_draft_publish") {
    if (content?.approvalConfirmed !== true) {
      return block(input, "content_missing", "tenant draft approval missing");
    }
  }

  if (sendType === "followup_broadcast") {
    if (content?.testSendConfirmed !== true) {
      return block(input, "content_missing", "test-send confirmation missing");
    }
  }

  if ((EXACT_CONTENT_TYPES as readonly string[]).includes(sendType)) {
    if (!isFiniteNumber(control.amount)) {
      return block(input, "missing_config", "control carries no amount");
    }
    if (!isFiniteNumber(content?.amount) || content?.amount !== control.amount) {
      return block(input, "content_mismatch", "amount differs from owner config");
    }
    if (isNonEmptyText(control.expiry)) {
      if (content?.expiry !== control.expiry) {
        return block(input, "content_mismatch", "expiry differs from owner config");
      }
    } else if (isNonEmptyText(content?.expiry)) {
      // Caller states an expiry the owner never configured: refuse
      // rather than let an unconfigured date go out.
      return block(input, "content_mismatch", "expiry not in owner config");
    }
  }

  // Template provenance: enforced only when BOTH sides carry a ref.
  // A mismatch is a hard block; an omitted caller ref is flagged in
  // the merger checklist (Legs B/C/D must pass it for text types).
  if (
    isNonEmptyText(control.templateRef) &&
    isNonEmptyText(content?.templateRef) &&
    content?.templateRef !== control.templateRef
  ) {
    return block(input, "content_mismatch", "text not from owner template");
  }

  return { allowed: true, sendType, businessId: input.businessId, content };
}

// ---------------------------------------------------------------------------
// Block logging — diagnostic only. A block stands whether or not the
// log write succeeds; a failed log write must NEVER unblock a send.
// ---------------------------------------------------------------------------

export interface SendGateBlockLogEntry {
  businessId: string;
  sendType: string;
  blockedAtMs: number;
  reason: SendGateBlockReason;
  detail: string;
}

export function buildBlockLogEntry(
  decision: Extract<SendGateDecision, { allowed: false }>,
  nowMs?: number,
): SendGateBlockLogEntry {
  return {
    businessId: decision.businessId,
    sendType: decision.sendType,
    blockedAtMs: nowMs ?? Date.now(),
    reason: decision.reason,
    detail: decision.detail,
  };
}

// ---------------------------------------------------------------------------
// THE single choke point. Every offer/discount/reply send path calls
// canSendOffer (or decideSendGate with an already-resolved control)
// and aborts on allowed === false. Resolver failures block: a control
// that cannot be read is treated exactly like a control that does
// not exist.
// ---------------------------------------------------------------------------

export interface SendGateConfigResolver {
  resolve(input: {
    businessId: string;
    sendType: string;
  }): Promise<OwnerSendControl | null>;
}

export interface SendGateBlockLogSink {
  write(entry: SendGateBlockLogEntry): Promise<void>;
}

export interface CanSendOfferResult {
  decision: SendGateDecision;
  /** False when the block-log write failed; the block still stands. */
  blockLogWritten: boolean;
}

export async function canSendOffer(
  input: Omit<SendGateInput, "control">,
  resolver: SendGateConfigResolver,
  blockLog?: SendGateBlockLogSink,
): Promise<CanSendOfferResult> {
  let control: OwnerSendControl | null = null;
  try {
    control = await resolver.resolve({
      businessId: input.businessId,
      sendType: input.sendType,
    });
  } catch {
    // Fail-closed: an unreadable control record blocks the send.
    control = null;
  }
  const decision = decideSendGate({ ...input, control });
  if (decision.allowed) {
    return { decision, blockLogWritten: true };
  }
  if (blockLog) {
    try {
      await blockLog.write(buildBlockLogEntry(decision));
      return { decision, blockLogWritten: true };
    } catch {
      return { decision, blockLogWritten: false };
    }
  }
  return { decision, blockLogWritten: false };
}
