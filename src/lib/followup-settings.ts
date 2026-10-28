/**
 * Follow-up settings: schedule presets, custom cap, earliest-first
 * ordering, and the "customer already left their number" signal spec —
 * LEG I (video round-2 batch), STAGED ONLY.
 *
 * This file EXTENDS the staged Leg F follow-up discipline; it does not replace it. Leg F's
 * files (src/lib/followup-discipline.ts, src/lib/followup-scheduler.ts,
 * src/app/api/broadcasts/route.ts, and its followups.ts diff) are
 * untouched by this leg. Nothing here changes Leg F's rules:
 * - Hot-count-null-blocks stays: this module never sets, defaults or
 *   invents a Hot reminder count, and never touches Hot scheduling.
 * - The test-send broadcast discipline stays untouched: no broadcast
 *   logic lives here, and no diff in this leg touches the broadcasts
 *   route.
 * - The followUpKind scoping fix stays: the number-left suppression in
 *   this module applies to SALES reminders (warm/hot) only, exactly
 *   like Leg F's already-ordered suppression, so order pushes,
 *   check-ins and kind-less customer-requested reminders still deliver.
 *
 * Pure, dependency-free module. No database, no network, no channel
 * sender, no copy generation. Every user-facing string the settings
 * UI eventually shows is a PROPOSAL for owner approval (see the UI
 * component header and LEG-REPORT); this module returns machine codes
 * plus one honest refusal reason, never shipped copy.
 *
 * Doctrines enforced here (from the task, not from any competitor):
 * - Per-surface identity is untouched: nothing here names a business.
 * - The agent NEVER confirms an order: ordering is not a function
 *   here; "has ordered" and "left their number" are SUPPRESSION
 *   signals only.
 * - The agent NEVER quotes fares: no price, charge or currency value
 *   is produced, read or stored here.
 * - No invented timing: the presets below are the task's own six
 *   values. No other default is staged: a missing choice is refused
 *   as "delay_not_set", never silently filled in.
 * - Patterns only: nothing here copies a competitor's branding,
 *   assets, UI text, prompts or code. The 23h cap honours the 24h
 *   platform window (a follow-up must still fit inside it); it is a
 *   platform rule, not a competitor's feature.
 */

// ---------------------------------------------------------------------------
// 1. Schedule presets + custom value, capped at 23h
// ---------------------------------------------------------------------------

/** Hard cap: a follow-up delay may never exceed 23 hours, so the
 *  follow-up always fits inside the 24h platform window. 23h is the
 *  task's largest preset and the cap; 24h itself is refused. */
export const MAX_FOLLOWUP_DELAY_MS = 23 * 60 * 60 * 1000;
export const MAX_FOLLOWUP_DELAY_MINUTES = 23 * 60; // 1380
export const MIN_FOLLOWUP_DELAY_MINUTES = 1;

export interface FollowUpDelayPreset {
  key: string;
  minutes: number;
  /** Milliseconds, derived from minutes — never hand-typed. */
  ms: number;
}

/** The task's six presets, in ascending order. */
export const FOLLOWUP_DELAY_PRESETS: readonly FollowUpDelayPreset[] = [
  { key: "30m", minutes: 30, ms: 30 * 60 * 1000 },
  { key: "1h", minutes: 60, ms: 60 * 60 * 1000 },
  { key: "2h", minutes: 120, ms: 120 * 60 * 1000 },
  { key: "6h", minutes: 360, ms: 360 * 60 * 1000 },
  { key: "12h", minutes: 720, ms: 720 * 60 * 1000 },
  { key: "23h", minutes: 1380, ms: 1380 * 60 * 1000 },
];

export type FollowUpDelayError =
  | "delay_not_set"
  | "unknown_preset"
  | "conflicting_delay_input"
  | "custom_delay_required"
  | "custom_delay_invalid"
  | "custom_delay_exceeds_23h";

export type FollowUpDelayResolution =
  | {
      ok: true;
      /** Milliseconds to wait before the first follow-up is due. */
      delayMs: number;
      /** "preset" for one of the six presets, "custom" otherwise. */
      source: "preset" | "custom";
      presetKey: string | null;
    }
  | { ok: false; error: FollowUpDelayError };

export interface ResolveFollowUpDelayInput {
  /**
   * One of the six preset keys, or "custom". Null/undefined = no
   * preset chosen. A fixed preset together with a custom value is
   * refused (conflicting_delay_input) — one source must win, and
   * silently ignoring the custom value would hide the tenant's
   * actual choice.
   */
  preset?: string | null;
  /** Custom delay in whole minutes. Only read when preset is
   *  "custom" (or when no preset is given at all, for API callers
   *  that send a bare custom value). */
  customMinutes?: number | null;
}

/**
 * Resolve a tenant's follow-up schedule choice to a delay.
 *
 * Over-cap custom values are REFUSED (ok: false, error
 * "custom_delay_exceeds_23h") — never silently clamped down to 23h
 * and never silently accepted above it. A silent clamp would make
 * the tenant believe a 30h delay was stored when 23h was; a silent
 * accept would schedule outside the platform window. The caller
 * (settings UI / route) must surface the refusal honestly and ask
 * for a value within the cap. The refusal reason string is a machine
 * code; the human wording is a PROPOSAL in the UI component.
 */
export function resolveFollowUpDelay(
  input: ResolveFollowUpDelayInput
): FollowUpDelayResolution {
  const preset = input.preset ?? null;
  const custom = input.customMinutes ?? null;

  if (preset !== null && preset !== "custom") {
    const found = FOLLOWUP_DELAY_PRESETS.find((p) => p.key === preset);
    if (!found) {
      return { ok: false, error: "unknown_preset" };
    }
    if (custom !== null) {
      return { ok: false, error: "conflicting_delay_input" };
    }
    return { ok: true, delayMs: found.ms, source: "preset", presetKey: found.key };
  }

  if (preset === "custom" && custom === null) {
    return { ok: false, error: "custom_delay_required" };
  }
  if (custom === null) {
    // Neither a preset nor a custom value: no default is invented.
    return { ok: false, error: "delay_not_set" };
  }
  if (
    typeof custom !== "number" ||
    !Number.isFinite(custom) ||
    !Number.isInteger(custom) ||
    custom < MIN_FOLLOWUP_DELAY_MINUTES
  ) {
    return { ok: false, error: "custom_delay_invalid" };
  }
  if (custom > MAX_FOLLOWUP_DELAY_MINUTES) {
    return { ok: false, error: "custom_delay_exceeds_23h" };
  }
  return {
    ok: true,
    delayMs: custom * 60 * 1000,
    source: "custom",
    presetKey: null,
  };
}

// ---------------------------------------------------------------------------
// 2. Earliest-first sending order
// ---------------------------------------------------------------------------

export interface DueFollowUpLike {
  dueAt: Date | number | string;
  [key: string]: unknown;
}

/**
 * Earliest-first order for due follow-ups. Stable: records with an
 * equal dueAt keep their input order (the delivery loop must never
 * reorder equal-due records arbitrarily).
 *
 * Honest scope note: at verified HEAD, the delivery loop's query
 * already carries `orderBy: { dueAt: "asc" }`, so on HEAD data this
 * sort changes nothing — it is a guarantee, not a behaviour change.
 * It protects the order if that orderBy is ever dropped or if a
 * future caller hands the loop an unsorted page, and it is what the
 * Leg I diff applies in the loop (see diffs/001). The take-20 page
 * still bounds each run; earliest-first applies within the page.
 */
export function sortDueEarliestFirst<T extends DueFollowUpLike>(
  records: readonly T[]
): T[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const aMs = new Date(a.record.dueAt).getTime();
      const bMs = new Date(b.record.dueAt).getTime();
      if (aMs !== bMs) return aMs - bMs;
      return a.index - b.index;
    })
    .map((entry) => entry.record);
}

// ---------------------------------------------------------------------------
// 3. "Customer already left their number" — EXPLICIT signal only
// ---------------------------------------------------------------------------

/**
 * The explicit recorded signal for "the customer left their number".
 *
 * SPEC — READ BEFORE WIRING: no such signal exists at HEAD (see
 * LEG-REPORT §3, verified NOT FOUND). The ONLY acceptable value for
 * `providedInChat` is a record made when the customer actually typed
 * a phone number inside THIS conversation (for example, a future
 * capture step that stores `customerProvidedPhoneInChat: true` on the
 * conversation at the moment the number is given in chat, with the
 * timestamp of that message).
 *
 * NEVER use any of these as this signal — each would be an inference
 * from profile/channel data the customer did not give in chat, and
 * each would wrongly suppress whole channels:
 * - Customer.phone / Customer.whatsapp (profile fields, possibly
 *   imported or staff-entered, not given in this chat);
 * - Conversation.customerContact (the channel address: on WhatsApp /
 *   SMS it IS a number by construction, so treating it as "left their
 *   number" would suppress every WhatsApp/SMS thread);
 * - a channel sender id (Telegram chat id, Meta sender id) — an
 *   address, not a number the customer left.
 *
 * Until the capture step lands, the delivery-loop wiring in
 * diffs/001 reads the (not-yet-existing) conversation field and gets
 * `false`, so this suppression is INERT at HEAD — built and
 * harness-proven at the pure level, but never firing on guessed
 * data. Backfilling it from profile/channel data is forbidden.
 */
export interface CustomerNumberSignal {
  /** True ONLY when the customer typed a number in this conversation. */
  providedInChat: boolean;
  /** When the number was given in chat, if recorded; null otherwise. */
  providedAtMs: number | null;
}

/**
 * Pure form of the number-left suppression, mirroring the loop diff:
 * it fires ONLY for sales reminders (warm/hot) — the same scoping as
 * Leg F's already-ordered suppression. Order pushes, check-ins and
 * kind-less customer-requested reminders are never suppressed by it,
 * even when the customer did leave their number. The caller applies
 * this AFTER Leg F's delivery gate (see LEG-REPORT §4): if Leg F's
 * gate already suppressed the record, its reason stands; this check
 * only converts a gate-allowed sales reminder into a suppression.
 */
export function isNumberLeftSuppressed(args: {
  followUpKind: string | null | undefined;
  customerLeftNumber: boolean;
}): boolean {
  if (!args.customerLeftNumber) return false;
  const kind = args.followUpKind ?? null;
  return kind === "warm_followup" || kind === "hot_followup";
}

/**
 * Composition helper used by the harness (and documenting the loop
 * diff's order): Leg F gate first, number-left second, sales only.
 * `legFGateSend` is Leg F's decideFollowUpDelivery(...).send for the
 * same record; this function does not re-implement Leg F's gate.
 */
export function applyNumberLeftAfterGate(args: {
  legFGateSend: boolean;
  followUpKind: string | null | undefined;
  customerLeftNumber: boolean;
}): { send: boolean; reason: "customer_left_number" | null } {
  if (!args.legFGateSend) return { send: false, reason: null };
  if (isNumberLeftSuppressed(args)) {
    return { send: false, reason: "customer_left_number" };
  }
  return { send: true, reason: null };
}
