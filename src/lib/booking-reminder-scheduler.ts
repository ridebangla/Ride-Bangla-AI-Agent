/**
 * booking-reminder-scheduler.ts — LEG D (booking batch), STAGED ONLY.
 *
 * Wiring between the pure reminder rules (booking-reminders.ts) and the
 * Firestore-backed store (the `@/lib/prisma` shim, mirroring
 * followups.ts). This module NEVER sends a message itself: it only
 * creates `followUp` records with kind "booking_reminder" and evaluates
 * the delivery gate. Sending stays in followups.ts's processor, so
 * there is exactly one delivery loop.
 *
 * TRIGGER (deliberate, disjoint-by-design): scheduling is a SCAN, not
 * a hook in setOrderStatus. The scan (POST /api/booking-reminders/
 * schedule, cron) finds confirmed orders and creates any missing
 * reminder records idempotently. This keeps this leg out of
 * orders.ts entirely — the prior Leg C status-update diff and
 * any sibling booking leg's orders.ts diffs therefore need no
 * reconciliation with this leg — and it self-heals a missed run:
 * a booking confirmed between scans still gets its reminders on the
 * next scan, as long as their due times are still in the future
 * (past-due slots are skipped, never backfilled).
 *
 * CONFIRMATION TIME PROXY: orders carry updatedAt (hasUpdatedAt) but
 * no confirmedAt. The scan treats updatedAt as the confirmation time
 * for the already-ordered comparison. That is an approximation,
 * flagged in the leg report: a later edit to a confirmed order moves
 * its updatedAt and can only make the already-ordered check MORE
 * conservative (a newer order must beat the moved timestamp).
 *
 * TENANCY: every query here runs inside runWithBusiness (the scan
 * enters one business context at a time, exactly like
 * processDueFollowUps). A business's reminders can never be created
 * or read as another business's. Fail-closed: no business context
 * means the shim throws before any write.
 *
 * RECORD SHAPE: the followUp model at HEAD is schemaless apart from
 * a `status: "pending"` default, and existing kinds (dropped_revival)
 * already carry extra fields — so orderId/slot/bookingStart/service
 * ride on the record with no firestore.ts change. The generic
 * follow-ups list endpoint (GET /api/followups/process) already
 * surfaces these records to the dashboard with no new UI.
 */

import { getUnscopedPrisma, runWithBusiness, prisma, withBusinessId } from "./prisma";
import { logger } from "./logger";
import {
  getReminderSettings,
  resolveBookingDateTime,
  extractService,
  extractPlace,
  planReminders,
  reminderDedupeKey,
  buildReminderMessage,
  deferralReason,
  suppressionReason,
  isNewerSameServiceOrder,
  type ReminderSettings,
} from "./booking-reminders";

/** Minimal order shape this module reads (subset of the HEAD order doc). */
export interface ReminderOrder {
  id: string;
  conversationId: string | null;
  status: string;
  items: Array<{ name?: unknown }>;
  customFields: Record<string, unknown>;
  summary: string;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

export interface ScheduleOutcome {
  created: number;
  skippedExisting: number;
  skippedPast: number;
  skippedDisabled: number;
  reason: string | null;
}

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Schedule the reminder pair for ONE confirmed order. Idempotent:
 * a (orderId, slot) record that already exists — in any status — is
 * never duplicated. Returns counts plus a machine reason when
 * nothing was scheduled.
 */
export async function scheduleBookingRemindersForOrder(
  order: ReminderOrder,
  settingsDoc: unknown,
  businessName: string,
  language: string,
  nowMs: number = Date.now()
): Promise<ScheduleOutcome> {
  const empty = (reason: string): ScheduleOutcome => ({
    created: 0,
    skippedExisting: 0,
    skippedPast: 0,
    skippedDisabled: 0,
    reason,
  });
  if (order.status !== "confirmed") return empty("order_not_confirmed");
  if (!order.conversationId) return empty("no_conversation");
  const resolved = resolveBookingDateTime(order.customFields ?? {});
  if (resolved.startMs === null) return empty(resolved.reason ?? "no_booking_datetime");
  const settings: ReminderSettings = getReminderSettings(settingsDoc);
  const plan = planReminders({
    bookingStartMs: resolved.startMs,
    hasTime: resolved.hasTime,
    settings,
    nowMs,
  });
  const service = extractService(order.items ?? [], order.summary);
  const place = extractPlace(order.customFields ?? {});
  let created = 0;
  let skippedExisting = 0;
  for (const slot of plan.planned) {
    const existing = await prisma.followUp.findFirst({
      where: {
        conversationId: order.conversationId,
        kind: "booking_reminder",
        orderId: order.id,
        slot: slot.slot,
      },
    });
    if (existing) {
      skippedExisting++;
      continue;
    }
    await prisma.followUp.create({
      data: withBusinessId({
        conversationId: order.conversationId,
        message: buildReminderMessage({
          businessName,
          service,
          bookingStartMs: resolved.startMs,
          hasTime: resolved.hasTime,
          place,
          language,
        }),
        dueAt: new Date(slot.dueAtMs),
        status: "pending",
        kind: "booking_reminder",
        orderId: order.id,
        slot: slot.slot,
        bookingStart: new Date(resolved.startMs).toISOString(),
        service,
        dedupeKey: reminderDedupeKey(order.id, slot.slot),
      }),
    });
    created++;
  }
  return {
    created,
    skippedExisting,
    skippedPast: plan.skippedPast.length,
    skippedDisabled: plan.skippedDisabled.length,
    reason: created > 0 ? null : plan.planned.length === 0 ? "no_future_slot" : "all_existing",
  };
}

export interface ScanResult {
  businesses: number;
  ordersScanned: number;
  created: number;
  skippedExisting: number;
  suppressedStale: number;
}

/**
 * Scan every active business's confirmed orders and schedule any
 * missing reminders. Also suppresses stale pending reminders whose
 * order is no longer confirmed (cancelled/deleted after scheduling),
 * so a cancelled booking can never be reminded about by a later run
 * even if the delivery gate is somehow bypassed. One bad order never
 * aborts the scan (logged, counted by omission, scan continues).
 */
export async function scanAndScheduleConfirmedBookings(
  nowMs: number = Date.now()
): Promise<ScanResult> {
  const raw = getUnscopedPrisma();
  const businesses = await raw.business.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  const total: ScanResult = {
    businesses: businesses.length,
    ordersScanned: 0,
    created: 0,
    skippedExisting: 0,
    suppressedStale: 0,
  };
  for (const b of businesses) {
    const r = await runWithBusiness(b.id, () => scanOneBusiness(nowMs));
    total.ordersScanned += r.ordersScanned;
    total.created += r.created;
    total.skippedExisting += r.skippedExisting;
    total.suppressedStale += r.suppressedStale;
  }
  return total;
}

async function scanOneBusiness(nowMs: number): Promise<Omit<ScanResult, "businesses">> {
  const out = { ordersScanned: 0, created: 0, skippedExisting: 0, suppressedStale: 0 };
  const settings = await prisma.settings.findFirst();
  const businessName =
    typeof settings?.businessName === "string" ? settings.businessName : "";
  const language =
    typeof settings?.language === "string" ? settings.language : "en";
  const orders = (await prisma.order.findMany({
    where: { status: "confirmed" },
    take: 100,
  })) as unknown as ReminderOrder[];
  out.ordersScanned = orders.length;
  for (const order of orders) {
    try {
      const r = await scheduleBookingRemindersForOrder(
        order,
        settings,
        businessName,
        language,
        nowMs
      );
      out.created += r.created;
      out.skippedExisting += r.skippedExisting;
    } catch (err) {
      logger.warn("[booking-reminders] scheduling failed for order", {
        orderId: order.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Stale pending reminders: order cancelled/deleted after scheduling.
  const pending = (await prisma.followUp.findMany({
    where: { kind: "booking_reminder", status: "pending" },
    take: 100,
  })) as unknown as Array<{ id: string; orderId?: string }>;
  for (const fu of pending) {
    try {
      if (!fu.orderId) continue;
      const order = await prisma.order.findUnique({ where: { id: fu.orderId } });
      if (!order || (order as { status?: string }).status !== "confirmed") {
        await prisma.followUp.update({
          where: { id: fu.id },
          data: { status: "suppressed", suppressReason: "order_not_confirmed" },
        });
        out.suppressedStale++;
      }
    } catch (err) {
      logger.warn("[booking-reminders] stale-suppression failed", {
        followUpId: fu.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delivery gate (called by followups.ts's processor, inside its tenant
// context, for kind === "booking_reminder" records only).
// ---------------------------------------------------------------------------

export type GateAction = "send" | "defer" | "suppress";

export interface GateDecision {
  action: GateAction;
  reason: string;
}

/**
 * Re-check every suppression input AT DELIVERY TIME (not just at
 * scheduling time): the order may have been cancelled since, a human
 * may have taken the thread since, or the customer may have ordered
 * again since. Inputs that cannot be read fail CLOSED for the order
 * check (no order = no send) and fail OPEN with a warning for the
 * already-ordered comparison (a transient read error must not eat a
 * reminder the customer is still owed — the order-status check above
 * it is the hard gate).
 */
export async function evaluateBookingReminderGate(input: {
  followUp: {
    id: string;
    conversationId: string;
    orderId?: string;
    aiSuppressed?: boolean;
  };
  conversation: { id: string; aiEnabled?: boolean };
}): Promise<GateDecision> {
  const { followUp, conversation } = input;
  const defer = deferralReason({
    humanHands: conversation.aiEnabled === false,
    globalAiOff: await isGlobalAiOff(),
    orderStatus: "confirmed",
    alreadyOrdered: false,
    aiUnneeded: false,
  });
  if (defer) return { action: "defer", reason: defer };
  if (!followUp.orderId) return { action: "suppress", reason: "order_not_confirmed" };
  const order = (await prisma.order.findUnique({
    where: { id: followUp.orderId },
  })) as unknown as ReminderOrder | null;
  if (!order) return { action: "suppress", reason: "order_not_confirmed" };
  let alreadyOrdered = false;
  try {
    const others = (await prisma.order.findMany({
      where: { conversationId: conversation.id, status: "confirmed" },
    })) as unknown as ReminderOrder[];
    alreadyOrdered = others.some((candidate) =>
      isNewerSameServiceOrder({
        bookingItems: order.items ?? [],
        bookingSummary: order.summary,
        bookingConfirmedMs: toMs(order.updatedAt),
        candidateId: candidate.id,
        bookingId: order.id,
        candidateStatus: candidate.status,
        candidateCreatedMs: toMs(candidate.createdAt) ?? toMs(candidate.updatedAt),
        candidateItems: candidate.items ?? [],
        candidateSummary: candidate.summary,
      })
    );
  } catch (err) {
    logger.warn("[booking-reminders] already-ordered check failed, proceeding", {
      followUpId: followUp.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const suppress = suppressionReason({
    humanHands: false,
    globalAiOff: false,
    orderStatus: order.status,
    alreadyOrdered,
    aiUnneeded: followUp.aiSuppressed === true,
  });
  if (suppress) return { action: "suppress", reason: suppress };
  return { action: "send", reason: "ok" };
}

async function isGlobalAiOff(): Promise<boolean> {
  try {
    const settings = await prisma.settings.findFirst();
    return (settings as { aiEnabled?: unknown } | null)?.aiEnabled === false;
  } catch {
    return false;
  }
}
