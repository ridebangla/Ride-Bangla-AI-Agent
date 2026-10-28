/**
 * booking-reminders.ts — LEG D (booking batch), STAGED ONLY.
 *
 * Reminder pair for CONFIRMED bookings only. Pure module: zero runtime
 * imports, so it is harness-testable without Firestore, the engine, or
 * any channel sender.
 *
 * PATTERNS ONLY: the pair (day-before + hours-before), the per-channel
 * delivery windows, and the suppression rules are product patterns
 * re-implemented from scratch. No third-party branding, assets, UI text,
 * prompts, or code are copied here. In particular this module never
 * produces a generic "next day" reminder: every reminder states the
 * appointment's absolute date and time, so the wording is correct
 * whatever day the reminder is actually delivered on.
 *
 * BOOKING MODEL (verified at HEAD 706df0fd): this repo has NO separate
 * booking/appointment model. A booking IS an order (`orders.ts`):
 * `status: "pending" | "confirmed" | "cancelled"`, with the appointment
 * carried in business-defined `customFields` (the starter set has
 * `delivery_date`, a date with NO time) plus `items`/`summary`. This
 * module therefore resolves the appointment from customFields and
 * FAILS CLOSED when it cannot: no datetime, no reminders, never a
 * guessed time. A sibling booking leg may add canonical datetime
 * fields; the resolver already accepts them (see DATE_KEYS/TIME_KEYS
 * and the canonical ISO keys below) so the two legs reconcile by
 * key list, not by rewrite.
 *
 * TIMEZONE (honest gap, also found by a prior leg report):
 * no tenant timezone setting exists at HEAD, so every time here is
 * UTC and every rendered time is labelled UTC. A tenant-timezone
 * setting is an open owner item; until it lands, rendering a local
 * time would be inventing one.
 *
 * USER-FACING WORDING: every template in `buildReminderMessage` is a
 * PROPOSAL for owner approval, never silently shipped copy (standing
 * no-invented-copy doctrine). The staged diffs are unshipped, so all
 * wording here is proposal by construction.
 */

export type ReminderSlot = "day_before" | "hours_before";

export interface ReminderSettings {
  /** Day-before reminder on/off. Default true (missing field = on). */
  dayBeforeEnabled: boolean;
  /** Hours-before reminder on/off. Default true (missing field = on). */
  hoursBeforeEnabled: boolean;
  /**
   * Hours before the appointment the second reminder is due.
   * Business-set via PUT /api/settings (see the validations diff).
   * PROPOSAL default: 3. Clamped to 1..72.
   */
  hoursBefore: number;
  /**
   * Tenant-configured Messenger template/tag name for the
   * out-of-window fallback, if any. Empty = no fallback configured,
   * so an out-of-window Messenger reminder is HELD, never faked.
   */
  messengerTemplateName: string;
}

/** Platform defaults. Missing settings fields mean these (no migration). */
export const REMINDER_DEFAULTS: ReminderSettings = {
  dayBeforeEnabled: true,
  hoursBeforeEnabled: true,
  hoursBefore: 3,
  messengerTemplateName: "",
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Read reminder settings off a business Settings doc. Unknown/missing
 * fields fall back to REMINDER_DEFAULTS; the doc is never mutated.
 */
export function getReminderSettings(settings: unknown): ReminderSettings {
  const s = (settings ?? {}) as Record<string, unknown>;
  return {
    dayBeforeEnabled: s.reminderDayBeforeEnabled !== false,
    hoursBeforeEnabled: s.reminderHoursBeforeEnabled !== false,
    hoursBefore: clampInt(
      s.reminderHoursBefore,
      1,
      72,
      REMINDER_DEFAULTS.hoursBefore
    ),
    messengerTemplateName:
      typeof s.messengerTemplateName === "string"
        ? s.messengerTemplateName.trim().slice(0, 200)
        : "",
  };
}

// ---------------------------------------------------------------------------
// Appointment resolution from order customFields
// ---------------------------------------------------------------------------

/** Canonical ISO datetime fields (accepted first; a sibling booking leg
 *  may standardise on one of these — the resolver needs no change). */
const ISO_KEYS = [
  "bookingDateTime",
  "appointmentDateTime",
  "appointmentAt",
  "bookingAt",
];

/** Date-only field keys, in precedence order. */
const DATE_KEYS = [
  "delivery_date",
  "appointment_date",
  "booking_date",
  "service_date",
  "date",
];

/** Time-of-day field keys, in precedence order. */
const TIME_KEYS = [
  "delivery_time",
  "appointment_time",
  "booking_time",
  "service_time",
  "time",
];

/** Place field keys, in precedence order. */
const PLACE_KEYS = [
  "venue",
  "location",
  "place",
  "delivery_address",
  "address",
  "shop_address",
  "pickup_address",
];

export interface ResolvedBooking {
  /** Epoch ms (UTC) of the appointment start, or null when unresolvable. */
  startMs: number | null;
  /** True when a real time-of-day was found (not just a date). */
  hasTime: boolean;
  /** Machine reason when startMs is null (for logs, never customer copy). */
  reason: string | null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function parseDateOnly(value: unknown): { y: number; m: number; d: number } | null {
  const s = asNonEmptyString(value);
  if (!s) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Round-trip check rejects overflow dates (e.g. 2026-02-30).
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

function parseTimeOnly(value: unknown): { h: number; min: number } | null {
  const s = asNonEmptyString(value);
  if (!s) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!match) return null;
  const h = Number(match[1]);
  const min = Number(match[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

/**
 * Resolve the appointment start from customFields. Returns startMs null
 * (never a guess) when: no date key, an unparseable date, or a date
 * with an unparseable time value present. A date with NO time key at
 * all resolves as date-only (hasTime false) — the hours-before slot
 * is then skipped by planReminders, because "a few hours before" an
 * unknown time cannot be computed.
 */
export function resolveBookingDateTime(
  customFields: Record<string, unknown>
): ResolvedBooking {
  const fields = customFields ?? {};
  for (const key of ISO_KEYS) {
    const raw = fields[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const ms =
      raw instanceof Date
        ? raw.getTime()
        : Date.parse(String(raw));
    if (!Number.isFinite(ms)) {
      return { startMs: null, hasTime: false, reason: `bad_iso:${key}` };
    }
    const text = String(raw);
    return {
      startMs: ms,
      hasTime: /T\d{2}:\d{2}/.test(text) || raw instanceof Date,
      reason: null,
    };
  }
  let date: { y: number; m: number; d: number } | null = null;
  let dateKey: string | null = null;
  for (const key of DATE_KEYS) {
    if (fields[key] === undefined || fields[key] === null || fields[key] === "") {
      continue;
    }
    dateKey = key;
    date = parseDateOnly(fields[key]);
    break;
  }
  if (!dateKey) return { startMs: null, hasTime: false, reason: "no_date" };
  if (!date) return { startMs: null, hasTime: false, reason: `bad_date:${dateKey}` };
  let time: { h: number; min: number } | null = null;
  let timeKey: string | null = null;
  for (const key of TIME_KEYS) {
    if (fields[key] === undefined || fields[key] === null || fields[key] === "") {
      continue;
    }
    timeKey = key;
    time = parseTimeOnly(fields[key]);
    break;
  }
  if (timeKey && !time) {
    return { startMs: null, hasTime: false, reason: `bad_time:${timeKey}` };
  }
  if (!time) {
    // Date-only: 09:00 UTC is NOT the appointment; hasTime false marks
    // it so callers never treat it as a real start time.
    return {
      startMs: Date.UTC(date.y, date.m - 1, date.d, 9, 0, 0),
      hasTime: false,
      reason: null,
    };
  }
  return {
    startMs: Date.UTC(date.y, date.m - 1, date.d, time.h, time.min, 0),
    hasTime: true,
    reason: null,
  };
}

/** Service label: the order summary, else the item names (max 3 shown). */
export function extractService(
  items: Array<{ name?: unknown }>,
  summary: unknown
): string {
  const s = asNonEmptyString(summary);
  if (s) return s.slice(0, 200);
  const names = (items ?? [])
    .map((it) => asNonEmptyString(it?.name))
    .filter((n): n is string => n !== null)
    .slice(0, 3);
  return names.length > 0 ? names.join(", ").slice(0, 200) : "your booking";
}

/** Place label, or null when no place field exists (never invented). */
export function extractPlace(customFields: Record<string, unknown>): string | null {
  const fields = customFields ?? {};
  for (const key of PLACE_KEYS) {
    const v = asNonEmptyString(fields[key]);
    if (v) return v.slice(0, 300);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scheduling: scheduled FROM THE BOOKING DATE/TIME, never from creation
// ---------------------------------------------------------------------------

export interface PlannedReminder {
  slot: ReminderSlot;
  /** Epoch ms (UTC) the reminder becomes due. */
  dueAtMs: number;
}

export interface PlanResult {
  planned: PlannedReminder[];
  /** Slots skipped because their due time had already passed. */
  skippedPast: ReminderSlot[];
  /** Slots skipped because the business switched them off. */
  skippedDisabled: ReminderSlot[];
}

/**
 * Plan the reminder pair from the BOOKING start, not from when the
 * booking was created. A slot whose due time is already past is
 * SKIPPED, never backfilled: a day-before reminder delivered on the
 * day itself (or after) would be wrong, and an hours-before reminder
 * due in the past is moot. A booking already in the past plans
 * nothing. Date-only bookings (hasTime false) plan ONLY the
 * day-before slot: the hours-before slot needs a real time.
 *
 * Day-before due time: exactly 24h before a timed appointment. For a
 * date-only booking the day-before reminder is due at 09:00 UTC on
 * the day before the date (PROPOSAL hour — tenant timezone is the
 * open item that would replace this UTC hour with a local one).
 */
export function planReminders(input: {
  bookingStartMs: number;
  hasTime: boolean;
  settings: ReminderSettings;
  nowMs: number;
}): PlanResult {
  const { bookingStartMs, hasTime, settings, nowMs } = input;
  const planned: PlannedReminder[] = [];
  const skippedPast: ReminderSlot[] = [];
  const skippedDisabled: ReminderSlot[] = [];
  if (!Number.isFinite(bookingStartMs) || bookingStartMs <= nowMs) {
    return { planned, skippedPast, skippedDisabled };
  }
  const consider = (slot: ReminderSlot, enabled: boolean, dueAtMs: number) => {
    if (!enabled) {
      skippedDisabled.push(slot);
      return;
    }
    if (dueAtMs <= nowMs) {
      skippedPast.push(slot);
      return;
    }
    planned.push({ slot, dueAtMs });
  };
  if (hasTime) {
    consider("day_before", settings.dayBeforeEnabled, bookingStartMs - 24 * 3600_000);
    consider(
      "hours_before",
      settings.hoursBeforeEnabled,
      bookingStartMs - settings.hoursBefore * 3600_000
    );
  } else {
    // Date-only: startMs is the 09:00 UTC stand-in (see resolver), so
    // day-before = that stand-in minus 24h = 09:00 UTC the day before.
    consider("day_before", settings.dayBeforeEnabled, bookingStartMs - 24 * 3600_000);
    if (settings.hoursBeforeEnabled) skippedDisabled.push("hours_before");
  }
  return { planned, skippedPast, skippedDisabled };
}

/** Deterministic dedupe key: one record per (order, slot), ever. */
export function reminderDedupeKey(orderId: string, slot: ReminderSlot): string {
  return `booking_reminder:${orderId}:${slot}`;
}

// ---------------------------------------------------------------------------
// Message builder (PROPOSAL wording — owner approval required)
// ---------------------------------------------------------------------------

function renderUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/**
 * Build one reminder's text. ALWAYS states the absolute appointment
 * date/time and the place when known; NEVER a relative phrase like
 * "tomorrow" or "next day", so a reminder delivered late by a cron
 * cadence still states the truth. Language: "bn" for Bengali, anything
 * else falls back to English. Business name prefixes the message so
 * the reminder speaks AS the business (per-surface identity) — an
 * empty business name simply omits the prefix, never a wrong name.
 */
export function buildReminderMessage(input: {
  businessName: string;
  service: string;
  bookingStartMs: number;
  hasTime: boolean;
  place: string | null;
  language: string;
}): string {
  const business = (input.businessName ?? "").trim();
  const when = input.hasTime
    ? renderUtc(input.bookingStartMs)
    : renderUtc(input.bookingStartMs).slice(0, 10);
  const placePart = input.place ? ` at ${input.place}` : "";
  if (input.language === "bn") {
    // PROPOSAL Bengali wording — owner approval required.
    const prefix = business ? `${business} থেকে মনে করিয়ে দেওয়া হচ্ছে: ` : "";
    const timePart = input.hasTime ? `${when} সময়ে` : `${when} তারিখে`;
    return (
      `${prefix}আপনার ${input.service} অ্যাপয়েন্টমেন্ট ${timePart}${placePart} রয়েছে।`
    );
  }
  const prefix = business ? `Reminder from ${business}: ` : "Reminder: ";
  const timePart = input.hasTime ? `on ${when}` : `on ${when}`;
  return `${prefix}your ${input.service} appointment is ${timePart}${placePart}.`;
}

// ---------------------------------------------------------------------------
// Per-channel delivery rules (honest for OUR channels at HEAD)
// ---------------------------------------------------------------------------

export const META_WINDOW_MS = 24 * 3600_000;

export type ChannelAction =
  | "send_response" // In-window conversational send (Messenger/IG, SMS, email, Telegram)
  | "send_template" // Out-of-window Messenger template/tag fallback (seam; see channels file)
  | "store" // Website widget: no push exists; store as an assistant message
  | "send" // Direct senders with no 24h window (SMS/email/Telegram)
  | "hold" // Do NOT send now; leave pending for a later run (window may reopen)
  | "suppress"; // Terminal: never send this record (Instagram after 24h)

export interface ChannelDecision {
  action: ChannelAction;
  reason: string;
}

/**
 * Decide how a booking reminder may travel on one channel.
 *
 * - widget: the website chat has NO push at HEAD (followups.ts says
 *   so itself). A reminder is STORED as an assistant message in the
 *   thread and surfaces on the visitor's next poll/visit via the
 *   thread endpoint — that IS the website-chat path, built here
 *   explicitly rather than assumed. Nothing is invented as "pushed".
 * - messenger: inside 24h of the customer's last message, a RESPONSE
 *   send is allowed. Outside 24h, RESPONSE fails at Meta; the rule is
 *   a template/tag fallback when the tenant configured one, else
 *   HOLD (the window reopens if the customer writes again).
 * - instagram: inside 24h, RESPONSE. Outside 24h, NOTHING — Instagram
 *   has no template fallback in this design, so the record is
 *   terminally suppressed, never faked as sent.
 * - whatsapp: ALWAYS hold in this leg. The only sender at HEAD is
 *   the whatsapp-web.js linked-device client (QR + LocalAuth) — the
 *   route this batch is forbidden to copy (ban risk). The compliant
 *   official-API sender does not exist yet (settings fields
 *   whatsappMode/whatsappApiKey exist but are unwired in the sender
 *   module), so WhatsApp reminders are DESIGN-ONLY here: held, never
 *   sent through the linked-device route.
 * - sms/email/telegram: existing direct senders, no 24h window rule.
 * - unknown channel: HOLD, fail-closed. (HEAD's generic default of
 *   "store + count as sent" must NEVER apply to booking reminders:
 *   a stored-only message on a push channel would be counted sent
 *   while the customer never got it.)
 *
 * lastCustomerAtMs null = unknown: treated as OUTSIDE the window
 * (fail-closed). A last-customer time in the future is also treated
 * as outside (clock skew must not widen a policy window).
 */
export function decideChannelDelivery(
  channel: string,
  input: {
    lastCustomerAtMs: number | null;
    nowMs: number;
    templateConfigured: boolean;
  }
): ChannelDecision {
  const { lastCustomerAtMs, nowMs, templateConfigured } = input;
  const inWindow =
    lastCustomerAtMs !== null &&
    lastCustomerAtMs <= nowMs &&
    nowMs - lastCustomerAtMs < META_WINDOW_MS;
  switch (channel) {
    case "widget":
      return { action: "store", reason: "widget_stored_in_thread" };
    case "messenger":
      if (inWindow) return { action: "send_response", reason: "messenger_in_window" };
      if (templateConfigured) {
        return { action: "send_template", reason: "messenger_template_fallback" };
      }
      return { action: "hold", reason: "messenger_window_expired_no_template" };
    case "instagram":
      if (inWindow) return { action: "send_response", reason: "instagram_in_window" };
      return { action: "suppress", reason: "instagram_window_expired" };
    case "whatsapp":
      return {
        action: "hold",
        reason: "whatsapp_official_api_not_built_linked_device_banned",
      };
    case "sms":
    case "email":
    case "telegram":
      return { action: "send", reason: `${channel}_direct_send` };
    default:
      return { action: "hold", reason: "unknown_channel" };
  }
}

// ---------------------------------------------------------------------------
// Suppression rules (pure predicates; the wiring leg fetches the inputs)
// ---------------------------------------------------------------------------

export interface SuppressionInput {
  /** Per-conversation human takeover (aiEnabled === false). */
  humanHands: boolean;
  /** Platform-wide AI kill-switch (settings aiEnabled === false). */
  globalAiOff: boolean;
  /** Current order status, or null when the order is gone. */
  orderStatus: string | null;
  /** A newer, same-service confirmed order exists on this conversation. */
  alreadyOrdered: boolean;
  /** The AI (or staff, via the suppress route) marked this unneeded. */
  aiUnneeded: boolean;
}

/**
 * Deferral (NOT terminal): the reminder stays pending and a later
 * run after hand-back may still deliver it while the appointment is
 * in the future. Returns the reason, or null when no deferral applies.
 * This mirrors the prior Leg D takeover deferral, scoped here to
 * booking records so this leg is correct even if Leg D never lands.
 */
export function deferralReason(input: SuppressionInput): string | null {
  if (input.humanHands) return "human_hands";
  if (input.globalAiOff) return "global_ai_off";
  return null;
}

/**
 * Terminal suppression: the record is marked "suppressed" and never
 * delivers. Returns the reason, or null when the reminder may go out.
 * Order-not-confirmed covers cancelled orders AND orders deleted
 * after scheduling (both must silence the reminder).
 */
export function suppressionReason(input: SuppressionInput): string | null {
  if (input.orderStatus !== "confirmed") return "order_not_confirmed";
  if (input.alreadyOrdered) return "already_ordered";
  if (input.aiUnneeded) return "ai_unneeded";
  return null;
}

/**
 * "Already ordered" (narrow reading, flagged as an owner decision):
 * a DIFFERENT order on the same conversation, status confirmed,
 * created after this booking's confirmation, for the SAME service
 * (shared item name, case-insensitive, or equal summary). When the
 * booking has no items and no summary, any newer confirmed order
 * counts. Dates come from createdAt with an updatedAt fallback; when
 * neither side carries a usable date, the check abstains (false)
 * rather than suppressing on a guess.
 */
export function isNewerSameServiceOrder(input: {
  bookingItems: Array<{ name?: unknown }>;
  bookingSummary: unknown;
  bookingConfirmedMs: number | null;
  candidateId: string;
  bookingId: string;
  candidateStatus: string;
  candidateCreatedMs: number | null;
  candidateItems: Array<{ name?: unknown }>;
  candidateSummary: unknown;
}): boolean {
  if (input.candidateId === input.bookingId) return false;
  if (input.candidateStatus !== "confirmed") return false;
  if (input.bookingConfirmedMs === null || input.candidateCreatedMs === null) {
    return false;
  }
  if (input.candidateCreatedMs <= input.bookingConfirmedMs) return false;
  const bookingSummary = asNonEmptyString(input.bookingSummary);
  const candidateSummary = asNonEmptyString(input.candidateSummary);
  if (bookingSummary && candidateSummary) {
    return bookingSummary.toLowerCase() === candidateSummary.toLowerCase();
  }
  const bookingNames = (input.bookingItems ?? [])
    .map((it) => asNonEmptyString(it?.name))
    .filter((n): n is string => n !== null)
    .map((n) => n.toLowerCase());
  const candidateNames = (input.candidateItems ?? [])
    .map((it) => asNonEmptyString(it?.name))
    .filter((n): n is string => n !== null)
    .map((n) => n.toLowerCase());
  if (bookingNames.length === 0 || candidateNames.length === 0) {
    // No usable service signal on one side: a newer confirmed order
    // on the same conversation still means the customer already
    // ordered (fail-open here is deliberate — the narrow same-service
    // match above is the precise path; absence of signal abstains
    // from distinguishing, it does not invent a distinction).
    return true;
  }
  return candidateNames.some((n) => bookingNames.includes(n));
}
