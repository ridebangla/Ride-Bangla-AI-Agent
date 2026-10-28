/**
 * CHANNEL SEND-GATE — pure module (settled model, 2026-10-28).
 *
 * Real repo path (NEW file): src/lib/owner-controls/channel-send-gate.ts
 * Pure: zero imports, zero I/O. It never sends anything and never
 * invents content.
 *
 * This gate answers TWO different questions, and they must not be
 * confused:
 *   1. May the AI REPLY on this channel right now?  -> channel gate
 *      (onboarding + global off + channel mode + conversation mode).
 *   2. May the AI SEND an offer/order for this business? -> offer
 *      gate (Leg E, settled fail-closed). An offer send needs BOTH
 *      the channel reply permission AND the offer control; a channel
 *      being AI does NOT, by itself, authorise an offer.
 *
 * ORDINARY REPLIES are not offer-gated (Leg E scope): the agent
 * answering a customer is the product itself. Owner replies from
 * the dashboard are never gated by this module at all — when the
 * owner has taken a channel, the owner answering from the dashboard
 * is always allowed; it is the AI that is silenced, not the owner.
 *
 * PLACEMENT (merger rule): check the channel gate AFTER every
 * existing suppression (global off is itself a suppression, listed
 * here only so the precedence is explicit) and BEFORE any AI send.
 * A channel-gate block must never override a suppression that
 * already blocked, and a channel-gate allow must never override a
 * suppression that already blocked either — both must pass.
 */

import {
  decideAiReply,
  type ChannelControlMap,
  type ChannelId,
  type OnboardingState,
} from "./channel-controls";

/** Owner offer control, as supplied by the caller (Leg E shape, in
 *  miniature — the full Leg E record stays the authority; this
 *  module only reads the three fields that decide a send). */
export interface OfferControlInput {
  /** Owner explicitly enabled this offer send. Anything but true blocks. */
  enabled: boolean;
  /** Paused (temporary off, not deleted). Timed-pause semantics are
   *  Leg E's: a set future pausedUntilMs pauses, a lapsed one
   *  auto-resumes even if paused is still true. */
  paused: boolean;
  pausedUntilMs?: number | null;
  /** Content comes from owner configuration (amount/text/timing).
   *  False = content would have to be guessed or defaulted. */
  contentFromOwnerConfig: boolean;
}

export function isOfferPaused(
  control: OfferControlInput,
  nowMs: number
): boolean {
  if (control.pausedUntilMs !== undefined && control.pausedUntilMs !== null) {
    return control.pausedUntilMs > nowMs;
  }
  return control.paused === true;
}

export type ChannelSendDecision =
  | { kind: "ai_send_allowed" }
  | { kind: "owner_reply_allowed" }
  | {
      kind: "blocked";
      reason:
        | "onboarding_not_complete"
        | "global_ai_off"
        | "channel_owner_controlled"
        | "conversation_owner_controlled"
        | "offer_not_enabled"
        | "offer_paused"
        | "offer_content_not_configured"
        | "cross_tenant";
    };

/**
 * Decide an AI send on a channel.
 *
 * - kind "message": an ordinary AI reply. Needs the channel gate
 *   only. Owner replies bypass this function entirely (they are
 *   always allowed from the dashboard).
 * - kind "offer": an offer/order send. Needs the channel gate AND
 *   the offer control (enabled + not paused + owner-configured
 *   content). Missing offer control (null) blocks, per the settled
 *   fail-closed send rule: missing/paused/disabled = nothing goes
 *   out, never a guessed amount or text.
 *
 * Cross-tenant check first: a control record for another business
 * must never authorise this business's send, even if it would
 * otherwise allow it.
 */
export function decideChannelSend(input: {
  kind: "message" | "offer";
  businessId: string;
  controlBusinessId: string | null;
  onboarding: OnboardingState;
  globalAiOff: boolean;
  controls: ChannelControlMap | null | undefined;
  channel: ChannelId;
  conversationAiEnabled: boolean;
  offerControl?: OfferControlInput | null;
  nowMs: number;
}): ChannelSendDecision {
  if (input.controlBusinessId !== null && input.controlBusinessId !== input.businessId) {
    return { kind: "blocked", reason: "cross_tenant" };
  }
  const reply = decideAiReply({
    onboarding: input.onboarding,
    globalAiOff: input.globalAiOff,
    controls: input.controls,
    channel: input.channel,
    conversationAiEnabled: input.conversationAiEnabled,
  });
  if (!reply.allowed) {
    return { kind: "blocked", reason: reply.reason };
  }
  if (input.kind === "message") {
    return { kind: "ai_send_allowed" };
  }
  const offer = input.offerControl;
  if (!offer) {
    return { kind: "blocked", reason: "offer_not_enabled" };
  }
  if (offer.enabled !== true) {
    return { kind: "blocked", reason: "offer_not_enabled" };
  }
  if (isOfferPaused(offer, input.nowMs)) {
    return { kind: "blocked", reason: "offer_paused" };
  }
  if (offer.contentFromOwnerConfig !== true) {
    return { kind: "blocked", reason: "offer_content_not_configured" };
  }
  return { kind: "ai_send_allowed" };
}

/** Block-log entry (shape mirrors Leg E's block log; merger maps it
 *  to the one canonical trail at go-live, never a second trail). */
export interface ChannelBlockLogEntry {
  businessId: string;
  channel: ChannelId;
  kind: "message" | "offer";
  reason: string;
  atMs: number;
}

export function buildBlockLogEntry(input: {
  businessId: string;
  channel: ChannelId;
  kind: "message" | "offer";
  reason: string;
  atMs: number;
}): ChannelBlockLogEntry {
  return {
    businessId: input.businessId,
    channel: input.channel,
    kind: input.kind,
    reason: input.reason,
    atMs: input.atMs,
  };
}
