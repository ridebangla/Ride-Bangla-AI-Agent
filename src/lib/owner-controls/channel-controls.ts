/**
 * PER-CHANNEL OWNER CONTROL — pure module (settled model, 2026-10-28).
 *
 * Real repo path (NEW file): src/lib/owner-controls/channel-controls.ts
 * Pure: zero imports, zero I/O, zero defaults for send content. It never
 * sends anything, never rewrites a message, and never invents a price,
 * an amount, a text, or a timing.
 *
 * SETTLED MODEL (owner, 2026-10-28, no re-clarification):
 * - Shop owner = the TENANT business owner who takes the AI agent from
 *   Ride Bangla. Not the Ride Bangla owner, not the end customer.
 * - MESSAGES are controlled PER CHANNEL, independently, inside ONE
 *   unified dashboard. Facebook, Messenger, WhatsApp, Instagram, any
 *   channel: the SAME system for every channel.
 * - Owner takes control of ONE channel (e.g. WhatsApp) -> the owner
 *   answers that channel's customers HIMSELF from the same dashboard,
 *   and the AI is SILENT on that channel for as long as the owner is
 *   talking there. Other channels (e.g. Facebook, Instagram) stay
 *   AI-answered in the meantime.
 * - Owner turns the channel ON again -> the AI takes control back on
 *   that channel immediately (for NEW incoming messages; it never
 *   messages proactively on resume — standing pause semantics).
 * - On/off is per channel separately: one channel off does NOT turn
 *   all channels off. There is no channel-specific exception.
 *
 * WHAT THIS MODULE IS NOT:
 * - It is NOT the HEAD inbox's per-conversation switch (HEAD
 *   src/app/(dashboard)/inbox/page.tsx already has per-conversation
 *   AI ON/OFF plus a global kill-switch). Those stay. This module adds
 *   the missing CHANNEL layer on top of them.
 * - It is NOT the offer send-gate (Leg E). Offers still need Leg E's
 *   gate as well (see channel-send-gate.ts). A channel being AI does
 *   not, by itself, authorise an offer send.
 * - It is NOT an onboarding/subscription engine. Onboarding is a
 *   separate predicate (canAiWork) that takes explicit inputs; this
 *   module never decides whether a business has a plan.
 *
 * PRECEDENCE (highest first — read this before wiring anything):
 *   1. Onboarding gate fails -> AI does not work at all (any channel).
 *   2. Global AI off (HEAD Settings kill-switch) -> AI silent everywhere.
 *   3. Channel mode = "owner" -> AI silent on THAT channel only.
 *   4. Per-conversation AI OFF (HEAD inbox switch) -> AI silent on
 *      that conversation only.
 *   5. Otherwise -> AI may reply on that channel/conversation.
 * A channel takeover therefore NEVER silences another channel, and a
 * per-conversation takeover NEVER silences a whole channel. The
 * merger must apply the precedence in exactly this order; reordering
 * it changes the settled behaviour.
 *
 * DEFAULTS (stated, not guessed):
 * - A channel with NO control record defaults to "ai". Rationale:
 *   existing tenants already run with AI answering; flipping every
 *   existing channel to owner-held on deploy would silently stop
 *   their AI. A missing channel record is NOT a send configuration,
 *   so this default does not touch the offer send-gate: an offer
 *   send with a missing offer control still blocks (Leg E).
 * - A channel takeover has NO auto-expiry. The owner holds the
 *   channel until the owner hands it back. A timed pause is a
 *   different feature (offer/message-family pauses in Legs B/C) and
 *   must not be confused with a channel takeover.
 */

// ---------------------------------------------------------------------------
// Channel identity — extensible, never a closed allow-list that blocks
// a channel the business connects later.
// ---------------------------------------------------------------------------

/** Channels the settled model names explicitly. Any other non-empty
 *  channel string is still a valid channel (see normalizeChannel). */
export const KNOWN_CHANNELS = [
  "website",
  "whatsapp",
  "messenger",
  "facebook",
  "instagram",
  "x",
  "telegram",
  "sms",
  "email",
  "phone",
] as const;

export type KnownChannel = (typeof KNOWN_CHANNELS)[number];

/** Any channel string, normalised. Unknown channels are NOT blocked. */
export type ChannelId = string;

/** Lowercase + trim. Empty / non-string input is rejected by callers. */
export function normalizeChannel(value: unknown): ChannelId | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "" ? null : v;
}

export function isKnownChannel(value: string): value is KnownChannel {
  return (KNOWN_CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Channel control state
// ---------------------------------------------------------------------------

/** Who answers this channel right now. */
export type ChannelMode = "ai" | "owner";

export interface ChannelControlState {
  businessId: string;
  channel: ChannelId;
  /** "ai" = AI answers; "owner" = owner answers from the dashboard. */
  mode: ChannelMode;
  /** Epoch ms of the last mode change. Owner-supplied by the writer. */
  changedAtMs: number;
  /** Actor that made the change (dashboard user id, or "api-key:<id>"). */
  changedBy: string | null;
  /** Optional free-form reason the owner gave (never required). */
  reason?: string | null;
}

export interface ChannelControlMap {
  [channel: string]: ChannelControlState;
}

/** A channel with no record is AI. See DEFAULTS above. */
export function channelModeOf(
  controls: ChannelControlMap | null | undefined,
  channel: ChannelId
): ChannelMode {
  const record = controls ? controls[channel] : undefined;
  if (!record) return "ai";
  return record.mode === "owner" ? "owner" : "ai";
}

export function isAiSilentOnChannel(
  controls: ChannelControlMap | null | undefined,
  channel: ChannelId
): boolean {
  return channelModeOf(controls, channel) === "owner";
}

// ---------------------------------------------------------------------------
// Takeover / hand-back (pure state transitions + audit entries)
// ---------------------------------------------------------------------------

export interface ChannelControlAuditEntry {
  businessId: string;
  channel: ChannelId;
  action: "channel_takeover" | "channel_handback";
  /** Mode before the change ("ai" when no record existed). */
  beforeMode: ChannelMode;
  afterMode: ChannelMode;
  changedAtMs: number;
  changedBy: string | null;
  reason: string | null;
}

export interface ChannelTakeoverResult {
  ok: true;
  state: ChannelControlState;
  audit: ChannelControlAuditEntry;
}

export interface ChannelTakeoverFailure {
  ok: false;
  error: "invalid_business" | "invalid_channel" | "invalid_actor";
}

function buildState(
  businessId: string,
  channel: ChannelId,
  mode: ChannelMode,
  changedAtMs: number,
  changedBy: string | null,
  reason: string | null
): ChannelControlState {
  return { businessId, channel, mode, changedAtMs, changedBy, reason: reason ?? null };
}

/**
 * Owner takes control of ONE channel. Only that channel's state
 * changes; the caller must merge the returned state into the map
 * without touching other channels (one off != all off).
 * No-change calls are idempotent: they return ok with the target
 * mode state and audit = null (no trail entry for a change that
 * did not happen).
 */
export function takeOverChannel(input: {
  businessId: string;
  channel: ChannelId;
  controls: ChannelControlMap | null | undefined;
  changedAtMs: number;
  changedBy: string | null;
  reason?: string | null;
}): { ok: true; state: ChannelControlState; audit: ChannelControlAuditEntry | null } | ChannelTakeoverFailure {
  const { businessId, channel } = input;
  if (typeof businessId !== "string" || businessId.trim() === "") {
    return { ok: false, error: "invalid_business" };
  }
  if (typeof channel !== "string" || channel.trim() === "") {
    return { ok: false, error: "invalid_channel" };
  }
  const before = channelModeOf(input.controls, channel);
  const state = buildState(
    businessId,
    channel,
    "owner",
    input.changedAtMs,
    input.changedBy,
    input.reason ?? null
  );
  if (before === "owner") {
    return { ok: true, state, audit: null };
  }
  return {
    ok: true,
    state,
    audit: {
      businessId,
      channel,
      action: "channel_takeover",
      beforeMode: before,
      afterMode: "owner",
      changedAtMs: input.changedAtMs,
      changedBy: input.changedBy,
      reason: input.reason ?? null,
    },
  };
}

/**
 * Owner hands a channel back to the AI. From this moment the AI may
 * answer NEW incoming messages on that channel. It must NOT send a
 * message proactively on hand-back (standing pause semantics) — the
 * caller must not treat hand-back as a send trigger.
 */
export function handBackChannel(input: {
  businessId: string;
  channel: ChannelId;
  controls: ChannelControlMap | null | undefined;
  changedAtMs: number;
  changedBy: string | null;
  reason?: string | null;
}): { ok: true; state: ChannelControlState; audit: ChannelControlAuditEntry | null } | ChannelTakeoverFailure {
  const { businessId, channel } = input;
  if (typeof businessId !== "string" || businessId.trim() === "") {
    return { ok: false, error: "invalid_business" };
  }
  if (typeof channel !== "string" || channel.trim() === "") {
    return { ok: false, error: "invalid_channel" };
  }
  const before = channelModeOf(input.controls, channel);
  const state = buildState(
    businessId,
    channel,
    "ai",
    input.changedAtMs,
    input.changedBy,
    input.reason ?? null
  );
  if (before === "ai") {
    return { ok: true, state, audit: null };
  }
  return {
    ok: true,
    state,
    audit: {
      businessId,
      channel,
      action: "channel_handback",
      beforeMode: before,
      afterMode: "ai",
      changedAtMs: input.changedAtMs,
      changedBy: input.changedBy,
      reason: input.reason ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Onboarding gate (predicate only — it never decides plan economics)
// ---------------------------------------------------------------------------

export interface OnboardingState {
  /** The business attached at least one website / channel source. */
  websiteAttached: boolean;
  /** An active trial OR an active paid subscription exists. */
  hasActiveTrialOrPaid: boolean;
  /**
   * The company's own internal account (Ride Bangla itself). Standing
   * doctrine: the company is unlimited, no key, no metering, no
   * trial expiry. Only the merger may set this, from verified
   * account identity — never from a client-supplied string.
   */
  isInternalHolder?: boolean;
}

/**
 * Settled onboarding rule (owner, 2026-10-28): no website attach /
 * no plan-trial = AI does not work at all. Trial = works within the
 * trial once everything is added (30 days; usage caps do not bite
 * during an active trial, expiry ends it — the caller, not this
 * predicate, enforces the trial clock). Paid = works per the
 * subscription month/plan (the caller enforces plan limits).
 * The internal holder always passes (company unlimited).
 */
export function canAiWork(state: OnboardingState): boolean {
  if (state.isInternalHolder === true) return true;
  return state.websiteAttached === true && state.hasActiveTrialOrPaid === true;
}

// ---------------------------------------------------------------------------
// Effective AI-reply permission (precedence order — do not reorder)
// ---------------------------------------------------------------------------

export interface EffectiveReplyInput {
  onboarding: OnboardingState;
  /** HEAD global kill-switch: true = AI off globally (Settings). */
  globalAiOff: boolean;
  controls: ChannelControlMap | null | undefined;
  channel: ChannelId;
  /** HEAD per-conversation switch: false = owner took that thread. */
  conversationAiEnabled: boolean;
}

export type EffectiveReplyDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "onboarding_not_complete"
        | "global_ai_off"
        | "channel_owner_controlled"
        | "conversation_owner_controlled";
    };

export function decideAiReply(input: EffectiveReplyInput): EffectiveReplyDecision {
  if (!canAiWork(input.onboarding)) {
    return { allowed: false, reason: "onboarding_not_complete" };
  }
  if (input.globalAiOff === true) {
    return { allowed: false, reason: "global_ai_off" };
  }
  if (isAiSilentOnChannel(input.controls, input.channel)) {
    return { allowed: false, reason: "channel_owner_controlled" };
  }
  if (input.conversationAiEnabled === false) {
    return { allowed: false, reason: "conversation_owner_controlled" };
  }
  return { allowed: true };
}
