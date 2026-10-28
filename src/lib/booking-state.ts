/**
 * booking-state.ts — PURE booking state machine + validation + templates.
 *
 * Leg A (booking batch), STAGED ONLY.
 *
 * A booking is a SEPARATE record type from a product order. It is never an
 * order with a flag: it lives in its own `bookings` collection, has its own
 * states, its own templates, and its own dashboard screen. Nothing in this
 * file imports Firestore, Prisma, or any route — it is pure logic so it can
 * be unit-tested standalone.
 *
 * LIFECYCLE (agent creates the request only; a HUMAN team acts on it):
 *   requested ──human──> confirmed          (human confirms the request)
 *   requested ──human──> proposed           (human proposes another time)
 *   requested ──human──> declined           (human returns/declines it)
 *   requested ──team───> cancelled_by_customer / cancelled_by_business
 *   proposed  ──human──> confirmed | proposed | declined | cancelled_*
 *   confirmed ──team───> cancelled_by_customer / cancelled_by_business
 *   declined, cancelled_* ──> TERMINAL (no further transition)
 *
 * The agent NEVER confirms: there is no agent transition into `confirmed`
 * in this machine, and no agent confirmation tool exists anywhere in this
 * leg. The only agent entry point is `request_booking`, which always
 * creates status `requested` (see src/lib/bookings.ts).
 *
 * AVAILABILITY HONESTY (mandatory rule, item 10):
 * This batch has NO calendar and NO free/busy data — neither does the
 * reference product studied for patterns. A requested slot is therefore
 * NEVER presented as booked: it is stored verbatim as the customer's
 * REQUEST, `availabilityChecked` is always false, and every template and
 * tool result in this leg says "request" until a human confirms. A slot's
 * date/time strings are shape-checked only (YYYY-MM-DD / HH:MM); they are
 * never checked against availability, because there is nothing to check
 * against. Calendar/availability checking is an OPEN OWNER DECISION
 * (see the leg report) — it must come from a real availability source,
 * never from invented free/busy data.
 *
 * NO FARE QUOTING BY DESIGN: this module has no price, total, or fare
 * field. `advanceAmount` is recorded ONLY when explicitly stated (by the
 * business's booking questions or by the customer); null means "not
 * stated", never a default, never a quote. The agent must never invent
 * an advance figure.
 *
 * USER-FACING WORDING = PROPOSAL: every template string below is proposal
 * text for owner approval (doctrine: no invented copy ships silently).
 * Templates are display drafts for the dashboard; nothing in this leg
 * auto-sends a template to a customer.
 */

export type BookingStatus =
  | "requested"
  | "proposed"
  | "confirmed"
  | "declined"
  | "cancelled_by_customer"
  | "cancelled_by_business";

export const BOOKING_STATUSES: BookingStatus[] = [
  "requested",
  "proposed",
  "confirmed",
  "declined",
  "cancelled_by_customer",
  "cancelled_by_business",
];

export const TERMINAL_BOOKING_STATUSES: BookingStatus[] = [
  "declined",
  "cancelled_by_customer",
  "cancelled_by_business",
];

/** A business-defined booking question (mirrors the orderFields pattern, but separate). */
export type BookingQuestionType = "text" | "select" | "date" | "number" | "textarea";

export interface BookingQuestion {
  /** Machine key, e.g. "occasion". */
  key: string;
  /** Human label shown to the team and to the agent, e.g. "Occasion". */
  label: string;
  type: BookingQuestionType;
  required: boolean;
  /** Only for type "select". */
  options?: string[];
}

/** One collected answer: the business's question + the customer's answer, verbatim. */
export interface BookingQuestionAnswer {
  key: string;
  question: string;
  answer: string;
}

export interface BookingStatusHistoryEntry {
  from: BookingStatus;
  to: BookingStatus;
  at: string;
  reason?: string | null;
}

/**
 * The booking document shape (what the `bookings` collection holds).
 * `availabilityChecked` is ALWAYS false in this leg: no calendar exists.
 */
export interface BookingRecord {
  id: string;
  businessId: string;
  conversationId: string | null;
  customerId: string | null;
  /** What is being booked, e.g. "Haircut", "Studio session", "Consultation". */
  service: string;
  /** The customer's requested slot, verbatim (e.g. "Saturday morning"). */
  requestedSlot: string;
  /** Date as STATED by the customer (YYYY-MM-DD shape only, never verified). */
  requestedDate: string | null;
  /** Time as STATED by the customer (HH:MM shape only, never verified). */
  requestedTime: string | null;
  /** Where the booking takes place (venue / address / branch), if given. */
  place: string | null;
  /** What the customer should bring, if the business stated it. */
  whatToBring: string | null;
  /** The business's own questions + the customer's answers. */
  questions: BookingQuestionAnswer[];
  customerName: string | null;
  customerPhone: string | null;
  /** Advance/deposit ONLY when explicitly stated; null = not stated (never invented). */
  advanceAmount: number | null;
  /** Currency code ONLY when explicitly stated alongside the amount. */
  advanceCurrency: string | null;
  /** Free-text reminder preferences (e.g. "remind me the day before"). No sender exists in this leg. */
  reminders: string[];
  /** Human-proposed alternative slot (only when status is/was `proposed`). */
  proposedSlot: string | null;
  proposedDate: string | null;
  proposedTime: string | null;
  /** Human note / return reason / cancellation reason. */
  humanNote: string | null;
  status: BookingStatus;
  /** Doc-level state history. This is NOT the audit trail — that belongs to Leg B (lock). */
  statusHistory: BookingStatusHistoryEntry[];
  /** Availability honesty flag: always false in this leg (no calendar). */
  availabilityChecked: boolean;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

/** Availability honesty marker carried on every agent tool result. */
export const AVAILABILITY_NOT_CHECKED = "not_checked" as const;

/** Read-only contract predicate for the lock boundary (Leg B owns enforcement). */
export function isBookingLockedStatus(status: BookingStatus): boolean {
  return status === "confirmed";
}

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return TERMINAL_BOOKING_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Transition machine
// ---------------------------------------------------------------------------

export interface BookingTransitionInput {
  to: BookingStatus;
  /** Required when `to` is `proposed`: the human's alternative slot text. */
  proposedSlot?: string | null;
  proposedDate?: string | null;
  proposedTime?: string | null;
  /** Required when `to` is `declined` or `cancelled_*`: why. */
  reason?: string | null;
  /** Optional human note for any transition (e.g. on confirm). */
  note?: string | null;
}

export interface BookingTransitionError {
  code:
    | "invalid_status"
    | "booking_terminal"
    | "transition_not_allowed"
    | "proposed_slot_required"
    | "reason_required"
    | "bad_date_shape"
    | "bad_time_shape";
  message: string;
}

const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  requested: [
    "confirmed",
    "proposed",
    "declined",
    "cancelled_by_customer",
    "cancelled_by_business",
  ],
  proposed: [
    "confirmed",
    "proposed",
    "declined",
    "cancelled_by_customer",
    "cancelled_by_business",
  ],
  // A confirmed booking is LOCKED (Leg B integration point): the only exit
  // this machine allows is a human-recorded cancellation. Nothing here
  // re-opens, re-proposes, or edits a confirmed booking.
  confirmed: ["cancelled_by_customer", "cancelled_by_business"],
  declined: [],
  cancelled_by_customer: [],
  cancelled_by_business: [],
};

export function canTransition(
  from: BookingStatus,
  to: BookingStatus
): boolean {
  if (!BOOKING_STATUSES.includes(from) || !BOOKING_STATUSES.includes(to)) {
    return false;
  }
  return ALLOWED_TRANSITIONS[from].includes(to);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Shape check ONLY: a YYYY-MM-DD string is well-formed, never "available". */
export function isValidDateShape(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Shape check ONLY: an HH:MM string is well-formed, never "available". */
export function isValidTimeShape(value: string): boolean {
  return TIME_RE.test(value);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Pure transition: validates `from -> to` and returns the updated record
 * fields, or a machine-coded error. Never throws. This function performs
 * NO locking and writes NO audit record — both belong to Leg B. Callers
 * (the dashboard PATCH route) are the only writers; no agent tool calls it.
 */
export function transitionBooking(
  booking: Pick<
    BookingRecord,
    | "status"
    | "proposedSlot"
    | "proposedDate"
    | "proposedTime"
    | "humanNote"
    | "statusHistory"
  >,
  input: BookingTransitionInput,
  nowIso: string
): { ok: true; patch: Partial<BookingRecord> } | { ok: false; error: BookingTransitionError } {
  const from = booking.status;
  const to = input.to;
  if (!BOOKING_STATUSES.includes(to)) {
    return {
      ok: false,
      error: { code: "invalid_status", message: `Unknown booking status: "${String(to)}".` },
    };
  }
  if (isTerminalBookingStatus(from)) {
    return {
      ok: false,
      error: {
        code: "booking_terminal",
        message: `Booking is ${from} and cannot change any more.`,
      },
    };
  }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      error: {
        code: "transition_not_allowed",
        message: `Booking cannot go from ${from} to ${to}.`,
      },
    };
  }
  const reason = cleanText(input.reason, 500);
  const note = cleanText(input.note, 500);
  if (to === "proposed") {
    const proposedSlot = cleanText(input.proposedSlot, 300);
    if (!proposedSlot) {
      return {
        ok: false,
        error: {
          code: "proposed_slot_required",
          message: "Proposing another time requires the alternative slot text.",
        },
      };
    }
    const proposedDate = cleanText(input.proposedDate, 10);
    const proposedTime = cleanText(input.proposedTime, 5);
    if (proposedDate && !isValidDateShape(proposedDate)) {
      return {
        ok: false,
        error: { code: "bad_date_shape", message: "proposedDate must look like YYYY-MM-DD." },
      };
    }
    if (proposedTime && !isValidTimeShape(proposedTime)) {
      return {
        ok: false,
        error: { code: "bad_time_shape", message: "proposedTime must look like HH:MM." },
      };
    }
    return {
      ok: true,
      patch: {
        status: to,
        proposedSlot,
        proposedDate,
        proposedTime,
        humanNote: note ?? reason,
        statusHistory: [
          ...(booking.statusHistory ?? []),
          { from, to, at: nowIso, reason: reason ?? note ?? null },
        ],
      },
    };
  }
  if (to === "declined" || to === "cancelled_by_customer" || to === "cancelled_by_business") {
    if (!reason) {
      return {
        ok: false,
        error: {
          code: "reason_required",
          message: `A ${to} booking needs a reason (shown to the team and the customer).`,
        },
      };
    }
  }
  return {
    ok: true,
    patch: {
      status: to,
      // A confirmed booking keeps its requested slot as the agreed slot;
      // a fresh proposal clears only when a new proposal replaces it, so
      // confirming from `proposed` intentionally KEEPS proposedSlot as the
      // record of what was agreed. Decline/cancel leave slots untouched.
      humanNote: reason ?? note,
      statusHistory: [
        ...(booking.statusHistory ?? []),
        { from, to, at: nowIso, reason: reason ?? note ?? null },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Booking questions (the business's own questions) — validation + missing
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z0-9_]{1,40}$/;
const QUESTION_TYPES: BookingQuestionType[] = [
  "text",
  "select",
  "date",
  "number",
  "textarea",
];

/** Validate a full bookingQuestions array (used by PUT /api/booking-questions). Throws on bad input. */
export function validateBookingQuestions(input: unknown): BookingQuestion[] {
  if (!Array.isArray(input)) {
    throw new Error("bookingQuestions must be an array.");
  }
  if (input.length > 30) {
    throw new Error("Too many booking questions (max 30).");
  }
  const seen = new Set<string>();
  return input.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Question #${i + 1} is not an object.`);
    }
    const q = raw as Record<string, unknown>;
    const key = String(q.key ?? "").trim().toLowerCase();
    if (!KEY_RE.test(key)) {
      throw new Error(
        `Question #${i + 1}: key must be 1-40 chars of lowercase letters, digits or underscore.`
      );
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate question key: "${key}".`);
    }
    seen.add(key);
    const label = String(q.label ?? "").trim().slice(0, 80);
    if (!label) {
      throw new Error(`Question "${key}": label is required.`);
    }
    const type = String(q.type ?? "text") as BookingQuestionType;
    if (!QUESTION_TYPES.includes(type)) {
      throw new Error(`Question "${key}": unknown type "${type}".`);
    }
    const required = Boolean(q.required);
    let options: string[] | undefined;
    if (type === "select") {
      const rawOpts = Array.isArray(q.options) ? q.options : [];
      options = rawOpts
        .map((o) => String(o ?? "").trim())
        .filter(Boolean)
        .slice(0, 20);
      if (options.length === 0) {
        throw new Error(`Question "${key}": select questions need at least one option.`);
      }
    }
    return { key, label, type, required, ...(options ? { options } : {}) };
  });
}

/** Normalize the free-form Q&A array coming from the agent tool call. */
export function normalizeQuestionAnswers(input: unknown): BookingQuestionAnswer[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 30)
    .map((raw): BookingQuestionAnswer | null => {
      if (!raw || typeof raw !== "object") return null;
      const a = raw as Record<string, unknown>;
      const key = String(a.key ?? "").trim().toLowerCase().slice(0, 40);
      const question = String(a.question ?? "").trim().slice(0, 200);
      const answer = String(a.answer ?? "").trim().slice(0, 500);
      if (!key || !answer) return null;
      return { key, question: question || key, answer };
    })
    .filter((a): a is BookingQuestionAnswer => a !== null);
}

/** Which REQUIRED booking questions still have no usable answer. Empty = the request may be created. */
export function getMissingBookingQuestions(
  questions: BookingQuestion[],
  answers: BookingQuestionAnswer[]
): BookingQuestion[] {
  const answered = new Set(answers.map((a) => a.key));
  return questions.filter((q) => q.required && !answered.has(q.key));
}

/** Advance validation: finite, >= 0, else rejected. null/undefined/"" = not stated (never defaulted). */
export function normalizeAdvance(
  amount: unknown,
  currency: unknown
): { amount: number | null; currency: string | null } | { error: string } {
  if (amount === null || amount === undefined || amount === "") {
    return { amount: null, currency: null };
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) {
    return { error: "advanceAmount must be a number >= 0, or omitted when not stated." };
  }
  let cur: string | null = null;
  if (typeof currency === "string" && currency.trim()) {
    const c = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) {
      return { error: "advanceCurrency must be a 3-letter code, or omitted." };
    }
    cur = c;
  }
  // An amount with no stated currency is stored currency-less; the UI shows
  // "Advance: <amount> (currency not stated)" — never a guessed currency.
  return { amount: Math.round(n * 100) / 100, currency: cur };
}

// ---------------------------------------------------------------------------
// Status labels + message templates (ALL wording = PROPOSAL, owner approval)
// ---------------------------------------------------------------------------

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  requested: "Request — not confirmed",
  proposed: "Another time proposed — not confirmed",
  confirmed: "Confirmed",
  declined: "Returned by team",
  cancelled_by_customer: "Cancelled by customer",
  cancelled_by_business: "Cancelled by business",
};

/**
 * PROPOSAL templates (owner approval required before any customer send).
 * Note the honesty rule baked into every pre-confirmation template: the
 * word is "request", never "booking confirmed" / "booked", until a human
 * confirms. These are dashboard display drafts only — this leg sends none.
 */
export const BOOKING_TEMPLATES: Record<BookingStatus, string> = {
  requested:
    "Your booking request for {service} on {slot} has been received. Our team will confirm it shortly — this slot is a request, not a confirmed booking yet.",
  proposed:
    "Our team has proposed another time for your {service} request: {proposedSlot}. Please let us know if that time works for you — nothing is confirmed until you accept and the team confirms.",
  confirmed:
    "Your booking for {service} on {slot} is confirmed. Please bring: {whatToBring}.",
  declined:
    "Unfortunately our team could not take your {service} request for {slot}. Reason: {reason}. Please contact us for another option.",
  cancelled_by_customer:
    "Your {service} booking request for {slot} has been cancelled as you asked.",
  cancelled_by_business:
    "Your {service} booking for {slot} has been cancelled by our team. Reason: {reason}.",
};

export function renderBookingTemplate(
  status: BookingStatus,
  booking: Pick<
    BookingRecord,
    "service" | "requestedSlot" | "proposedSlot" | "whatToBring" | "humanNote"
  >
): string {
  return BOOKING_TEMPLATES[status]
    .replaceAll("{service}", booking.service || "—")
    .replaceAll("{slot}", booking.requestedSlot || "—")
    .replaceAll("{proposedSlot}", booking.proposedSlot || booking.requestedSlot || "—")
    .replaceAll("{whatToBring}", booking.whatToBring || "nothing special")
    .replaceAll("{reason}", booking.humanNote || "not stated");
}
