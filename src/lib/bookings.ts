/**
 * bookings.ts — booking record service (Leg A, STAGED ONLY).
 *
 * The booking is a SEPARATE record type from a product order: it is stored
 * in the tenant's own `bookings` collection (delegate registered in
 * src/lib/firestore.ts, shape in src/lib/models.ts), never in `orders`,
 * and never via the order path. The only writer of new bookings from chat
 * is the `request_booking` agent tool (src/lib/ai/tools.ts), which always
 * creates status `requested`.
 *
 * Tenancy: `createBooking` / list / get / status-update use the ambient
 * tenant-scoped `prisma` client (fail-closed — throws TenantContextError
 * with no business context), exactly like orders.ts. Reading the business
 * row for booking questions goes through the UNSCOPED client on purpose
 * (the `businesses` collection is not tenant-scoped; fail-closed on a
 * missing business). Cross-tenant reads fail closed the same way as an
 * unknown id (a 404 at the route, never a leak).
 *
 * LOCK BOUNDARY (Leg B owns it): `setBookingStatus` performs NO locking
 * and writes NO audit record. When the target is `confirmed`, the
 * LEG-B INTEGRATION POINT comment below marks where Leg B's guard +
 * audit trail attach: after this function lands a `confirmed` status,
 * Leg B's guard must treat the booking as locked (no agent/tool edits,
 * no re-open), and Leg B's audit trail must record the confirmation.
 * This module's own `statusHistory` array is doc-level state history
 * only — it is not the audit trail.
 *
 * NO COURIER BRIDGE: unlike orders, confirming a booking does NOT create
 * a courier booking. A booking is an appointment for a service, not a
 * delivery. If a future owner decision wants courier dispatch for some
 * booking type, that is a separate leg — this module never calls the
 * bridge, so a booking confirmation can never silently dispatch a rider.
 *
 * AVAILABILITY HONESTY: `createBooking` always stores
 * `availabilityChecked: false`. There is no calendar in this batch, so
 * nothing here may ever claim a slot is free, busy, or booked.
 */

import { prisma, withBusinessId, getUnscopedPrisma, getBusinessId } from "./prisma";
import type { JsonValue } from "./models";
import {
  type BookingStatus,
  type BookingQuestion,
  type BookingQuestionAnswer,
  type BookingTransitionInput,
  validateBookingQuestions,
  normalizeQuestionAnswers,
  getMissingBookingQuestions,
  normalizeAdvance,
  isValidDateShape,
  isValidTimeShape,
  transitionBooking,
  BOOKING_STATUSES,
} from "./booking-state";

export type {
  BookingStatus,
  BookingQuestion,
  BookingQuestionAnswer,
} from "./booking-state";
export {
  BOOKING_STATUSES,
  BOOKING_STATUS_LABELS,
  BOOKING_TEMPLATES,
  isBookingLockedStatus,
  isTerminalBookingStatus,
  canTransition,
} from "./booking-state";

/** Starter question set offered by the dashboard (mirrors DEFAULT_ORDER_FIELDS). */
export const DEFAULT_BOOKING_QUESTIONS: BookingQuestion[] = [
  { key: "customer_name", label: "Customer name", type: "text", required: true },
  { key: "phone", label: "Phone number", type: "text", required: true },
  { key: "occasion", label: "Occasion / purpose", type: "text", required: false },
  { key: "notes", label: "Booking notes", type: "textarea", required: false },
];

/** Read a business's booking question definitions (empty array when none). */
export async function getBookingQuestions(businessId: string): Promise<BookingQuestion[]> {
  const biz = await getUnscopedPrisma().business.findUnique({
    where: { id: businessId },
    select: { id: true, bookingQuestions: true },
  });
  if (!biz) {
    throw new Error(`Unknown business: ${businessId}`);
  }
  try {
    return validateBookingQuestions((biz as { bookingQuestions?: unknown }).bookingQuestions ?? []);
  } catch {
    // Tolerate legacy/corrupt data: treat as no questions rather than crash.
    return [];
  }
}

/** Replace a business's booking question definitions (dashboard settings). */
export async function setBookingQuestions(
  businessId: string,
  questions: unknown
): Promise<BookingQuestion[]> {
  const cleaned = validateBookingQuestions(questions);
  await getUnscopedPrisma().business.update({
    where: { id: businessId },
    data: { bookingQuestions: cleaned as unknown as JsonValue },
  });
  return cleaned;
}

export interface CreateBookingInput {
  conversationId?: string | null;
  customerId?: string | null;
  service: string;
  requestedSlot: string;
  requestedDate?: string | null;
  requestedTime?: string | null;
  place?: string | null;
  whatToBring?: string | null;
  questions: BookingQuestionAnswer[];
  customerName?: string | null;
  customerPhone?: string | null;
  advanceAmount?: number | null;
  advanceCurrency?: string | null;
  reminders?: string[];
  summary?: string;
}

export interface CreateBookingResult {
  ok: true;
  bookingId: string;
  status: "requested";
  availability: "not_checked";
}

/**
 * Persist a booking REQUEST in the tenant's `bookings` collection.
 * Status is ALWAYS `requested` — callers cannot create a booking in any
 * other status through this function. That is the agent-never-confirms
 * rule enforced in code, not just in prose.
 */
export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  const service = input.service.trim().slice(0, 200);
  const requestedSlot = input.requestedSlot.trim().slice(0, 300);
  if (!service || !requestedSlot) {
    throw new Error("service and requestedSlot are required to record a booking request.");
  }
  const requestedDate = input.requestedDate?.trim() || null;
  const requestedTime = input.requestedTime?.trim() || null;
  // Shape checks only — a well-formed date/time is still only a REQUEST.
  if (requestedDate && !isValidDateShape(requestedDate)) {
    throw new Error("requestedDate must look like YYYY-MM-DD.");
  }
  if (requestedTime && !isValidTimeShape(requestedTime)) {
    throw new Error("requestedTime must look like HH:MM.");
  }
  const advance = normalizeAdvance(input.advanceAmount ?? null, input.advanceCurrency ?? null);
  if ("error" in advance) {
    throw new Error(advance.error);
  }
  const questions = normalizeQuestionAnswers(input.questions ?? []);
  const reminders = (input.reminders ?? [])
    .map((r) => String(r ?? "").trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((r) => r.slice(0, 200));
  const now = new Date().toISOString();
  const booking = await prisma.booking.create({
    data: withBusinessId({
      conversationId: input.conversationId ?? null,
      customerId: input.customerId ?? null,
      service,
      requestedSlot,
      requestedDate,
      requestedTime,
      place: input.place?.trim().slice(0, 300) || null,
      whatToBring: input.whatToBring?.trim().slice(0, 500) || null,
      questions: questions as unknown as JsonValue,
      customerName: input.customerName?.trim().slice(0, 200) || null,
      customerPhone: input.customerPhone?.trim().slice(0, 100) || null,
      advanceAmount: advance.amount,
      advanceCurrency: advance.currency,
      reminders: reminders as unknown as JsonValue,
      proposedSlot: null,
      proposedDate: null,
      proposedTime: null,
      humanNote: null,
      status: "requested" as BookingStatus,
      statusHistory: [] as unknown as JsonValue,
      // Availability honesty: no calendar exists in this batch, so this
      // is always false. A future calendar leg may set it only from a
      // real availability source — never from invented free/busy data.
      availabilityChecked: false,
      summary: (input.summary ?? `${service}: ${requestedSlot}`).slice(0, 300),
    }),
  });
  return { ok: true, bookingId: booking.id, status: "requested", availability: "not_checked" };
}

export async function getBookingById(bookingId: string) {
  const businessId = getBusinessId();
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) {
    throw Object.assign(new Error("Booking not found"), { code: "P2025" });
  }
  // Fail-closed cross-tenant check: a booking of another tenant reads
  // exactly like a missing booking.
  if (
    businessId &&
    (booking as { businessId?: unknown }).businessId !== businessId
  ) {
    throw Object.assign(new Error("Booking not found"), { code: "P2025" });
  }
  return booking;
}

export async function listBookings(status?: string | null) {
  const where: Record<string, unknown> = {};
  if (status && BOOKING_STATUSES.includes(status as BookingStatus)) {
    where.status = status;
  }
  return prisma.booking.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

/**
 * Human-only status change (dashboard PATCH route). The agent has no tool
 * that calls this — that is what makes "agent never confirms" real.
 *
 * LEG-B INTEGRATION POINT (lock guard + audit trail — Leg B owns both):
 * when `patch.status` becomes `confirmed`, Leg B must (a) treat the
 * booking as LOCKED from that moment (no agent/tool mutation, no
 * re-open, no re-propose), and (b) write its audit record of the
 * confirmation. This function deliberately does neither: it only moves
 * the state machine and appends doc-level statusHistory. If Leg B's
 * guard is not yet landed, a confirmed booking is still protected by
 * this machine itself — its only exits are human-recorded cancellations
 * — but the guard + audit trail remain Leg B's owed work, not this leg's.
 */
export async function setBookingStatus(
  bookingId: string,
  input: BookingTransitionInput
) {
  const booking = await getBookingById(bookingId);
  const current = booking as unknown as {
    status: BookingStatus;
    proposedSlot: string | null;
    proposedDate: string | null;
    proposedTime: string | null;
    humanNote: string | null;
    statusHistory: Array<{
      from: BookingStatus;
      to: BookingStatus;
      at: string;
      reason?: string | null;
    }>;
  };
  const result = transitionBooking(current, input, new Date().toISOString());
  if (!result.ok) {
    const err = new Error(result.error.message) as Error & { code?: string };
    err.code = result.error.code;
    throw err;
  }
  // Delegate methods accept `any` args (see ModelDelegate in firestore.ts),
  // so the pure-machine patch passes through uncast.
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: result.patch,
  });
  // LEG-B INTEGRATION POINT ends here: `updated.status === "confirmed"`
  // is the exact moment Leg B's lock must engage (see the comment above).
  return updated;
}

/** Which REQUIRED booking questions still have no usable answer (agent slot check). */
export function getMissingBookingAnswers(
  questions: BookingQuestion[],
  answers: BookingQuestionAnswer[]
): BookingQuestion[] {
  return getMissingBookingQuestions(questions, answers);
}
