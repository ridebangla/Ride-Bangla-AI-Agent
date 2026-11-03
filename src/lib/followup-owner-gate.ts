/**
 * FOLLOW-UP OWNER GATE — Team J wiring (2026-11-03).
 *
 * Pure decision module: combines the two ALREADY-LIVE owner-control
 * layers for the follow-ups processor (src/lib/followups.ts) WITHOUT
 * changing any gate logic and WITHOUT changing send content:
 *
 *   1. Channel hold — the settings-doc ownerControls channel map
 *      (src/lib/owner-controls/settings-owner-control-adapter.ts):
 *      a channel whose mode is "owner" silences AI sends on it. Read
 *      through isAiSilentOnChannel (pure, no onboarding predicate).
 *   2. Message controls — the dashboard message-controls layer
 *      (src/lib/owner-controls/message-controls.ts, routes live at
 *      /api/message-controls): family disabled, master pause, scope
 *      pause, or a per-record owner pause blocks the send.
 *
 * BLOCK-ONLY wiring: this module returns only send/defer. It NEVER
 * applies an owner override text — the loop keeps sending the
 * record's own message verbatim, so no send content changes here.
 * (Per-record message edits made through the dashboard
 * editRecordMessage path still flow through, because they rewrite
 * the record's message itself before the loop reads it.)
 * Templated scopes (reminders slots, reviewAsks/delivered) are
 * resolved with their texts stripped: their overrides need
 * bookingDateTime / reviewUrl context this loop does not carry, and
 * resolving them without it would block on template_context_missing.
 * Pause/disable still enforce on those scopes; override-text
 * application for templated scopes is follow-up work (see report).
 *
 * OUTCOME SEMANTICS (matches the loop's existing deferral):
 * a deferred record stays "pending" — never "failed", never deleted —
 * so it delivers on the next run after the owner resumes / hands the
 * channel back. Exactly one counter per record: this gate runs AFTER
 * the loop's existing suppressions (Leg F, Leg I, Leg J toggles),
 * so a record those already stopped never reaches here.
 *
 * DELIBERATELY NOT WIRED HERE — decideAiSendWithOwnerControls'
 * onboarding predicate (canAiWork: website attached + active trial
 * or paid): the follow-ups processor today applies NO onboarding
 * gate, and applying it would newly silence free-tier tenants'
 * follow-ups. That is a coordinator/owner decision, not something
 * this wiring silently ships (see Team J report §a). Likewise the
 * strict Leg E decideSendGate (missing ownerSendControls record
 * blocks) has NO live resolver in this tree — no store reads or
 * writes the ownerSendControls collection — so it cannot be wired
 * to follow-ups without inventing one; see report §a BLOCKED item.
 */

import {
  isAiSilentOnChannel,
  type ChannelControlMap,
} from "./owner-controls/channel-controls";
import {
  familyForRecordKind,
  normalizeControls,
  resolveMessageControl,
  scopeForRecordKind,
  TEMPLATED_SCOPES,
  type MessageControlState,
} from "./owner-controls/message-controls";

export interface FollowUpOwnerRecord {
  id: string;
  message: string;
  ownerPaused?: boolean | null;
  ownerPausedUntil?: string | null;
  slot?: string | null;
}

/** Extract the gate's record view from a followUp row (extra fields
 *  are read defensively: rows written before the owner-controls
 *  fields existed simply carry none of them). */
export function ownerRecordFromFollowUp(fu: {
  id: string;
  message: string;
  kind?: unknown;
  slot?: unknown;
  ownerPaused?: unknown;
  ownerPausedUntil?: unknown;
}): {
  record: FollowUpOwnerRecord;
  kind: string | null;
  slot: string | null;
} {
  return {
    record: {
      id: fu.id,
      message: fu.message,
      ownerPaused: fu.ownerPaused === true,
      ownerPausedUntil:
        typeof fu.ownerPausedUntil === "string" ? fu.ownerPausedUntil : null,
      slot: typeof fu.slot === "string" ? fu.slot : null,
    },
    kind: typeof fu.kind === "string" ? fu.kind : null,
    slot: typeof fu.slot === "string" ? fu.slot : null,
  };
}

export type FollowUpOwnerDecision =
  | { send: true }
  | { send: false; reason: string };

/**
 * Map a followUp record kind (+ slot for booking reminders) to the
 * message-controls family/scope. Null = no message-controls family
 * covers this kind (broadcasts, broadcast_test, order_status_update,
 * kind-less records): only the channel-hold gate applies to those.
 */
export function followUpControlScope(
  kind: string | null | undefined,
  slot: string | null | undefined
): { family: "followups" | "reminders" | "reviewAsks"; scope: string } | null {
  const family = familyForRecordKind(kind);
  if (!family) return null;
  if (kind === "booking_reminder") {
    if (slot !== "day_before" && slot !== "hours_before") return null;
    return { family: "reminders", scope: slot };
  }
  const scope = scopeForRecordKind(kind);
  if (!scope) return null;
  return { family, scope };
}

export function decideFollowUpOwnerGate(input: {
  businessId: string;
  /** Business the loaded controls doc belongs to (null = no doc). */
  controlBusinessId: string | null;
  /** Normalised message controls (null = no controls configured). */
  controls: MessageControlState | null;
  /** Owner-controls channel map (null/undefined = no holds). */
  channelControls: ChannelControlMap | null | undefined;
  channel: string;
  /** True when the owner-controls adapter threw (corrupt / down). */
  docError: boolean;
  record: FollowUpOwnerRecord;
  kind: string | null | undefined;
  slot: string | null | undefined;
  nowMs: number;
}): FollowUpOwnerDecision {
  // Fail-closed on store failure, before any other read: a corrupt
  // owner-held entry must never read back as AI.
  if (input.docError) {
    return { send: false, reason: "owner_controls_store_unavailable" };
  }
  if (
    input.controlBusinessId !== null &&
    input.controlBusinessId !== input.businessId
  ) {
    return { send: false, reason: "cross_tenant" };
  }
  if (isAiSilentOnChannel(input.channelControls, input.channel)) {
    return { send: false, reason: "channel_owner_controlled" };
  }
  const mapped = followUpControlScope(input.kind, input.slot);
  if (!mapped) return { send: true };
  // Normalise defensively: callers may pass a raw settings-doc field.
  const controls =
    input.controls === null
      ? null
      : normalizeControls(input.controls as unknown);
  let effectiveControls = controls;
  if (
    controls &&
    TEMPLATED_SCOPES[`${mapped.family}:${mapped.scope}`]
  ) {
    // Block-only for templated scopes (see header): strip texts so a
    // set-but-unrenderable override cannot block the record's own
    // message; pause/disable still enforce.
    effectiveControls = {
      ...controls,
      [mapped.family]: { ...controls[mapped.family], texts: {} },
    };
  }
  const resolved = resolveMessageControl({
    family: mapped.family,
    scope: mapped.scope,
    businessId: input.businessId,
    controlBusinessId: input.controlBusinessId,
    controls: effectiveControls,
    record: {
      id: input.record.id,
      message: input.record.message,
      ownerPaused: input.record.ownerPaused,
      ownerPausedUntil: input.record.ownerPausedUntil,
      slot: input.record.slot,
    },
    text: null,
    nowMs: input.nowMs,
  });
  if (!resolved.allowed) {
    return { send: false, reason: resolved.reason };
  }
  return { send: true };
}
