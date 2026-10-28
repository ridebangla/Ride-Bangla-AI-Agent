/**
 * booking-reminders.test.ts — LEG D (booking batch), STAGED ONLY.
 * REPO PATH when applied: tests/unit/booking-reminders.test.ts
 *
 * Covers ONLY the pure module src/lib/booking-reminders.ts (zero
 * runtime imports, so this file needs no Firestore, no prisma mock,
 * and no network). The scheduler wiring, the processor branch, and
 * the routes are exercised by the standalone harness
 * (harness/run-harness.ts) and remain LIVE-UNVERIFIED until a
 * real-repo run. Invariants asserted throughout:
 * - Reminders are scheduled from the BOOKING date/time, never from
 *   creation; past-due slots are skipped, never backfilled.
 * - Every message states the absolute date/time; no message ever
 *   contains a generic "tomorrow" / "next day" phrase.
 * - WhatsApp is always held (linked-device route banned); Instagram
 *   after 24h is terminally suppressed; nothing is ever faked sent.
 */

import { describe, it, expect } from "vitest";
import {
  getReminderSettings,
  resolveBookingDateTime,
  planReminders,
  buildReminderMessage,
  decideChannelDelivery,
  deferralReason,
  suppressionReason,
  isNewerSameServiceOrder,
} from "@/lib/booking-reminders";

const H = 3600_000;
const START = Date.UTC(2026, 10, 2, 15, 0);
const NOW = Date.UTC(2026, 9, 30, 12, 0);
const DEF = getReminderSettings({});

describe("settings", () => {
  it("defaults to pair on, 3 hours", () => {
    expect(DEF).toEqual({
      dayBeforeEnabled: true,
      hoursBeforeEnabled: true,
      hoursBefore: 3,
      messengerTemplateName: "",
    });
  });
  it("clamps hours-before", () => {
    expect(getReminderSettings({ reminderHoursBefore: 200 }).hoursBefore).toBe(72);
    expect(getReminderSettings({ reminderHoursBefore: 0 }).hoursBefore).toBe(1);
  });
});

describe("resolution", () => {
  it("accepts ISO and date+time keys", () => {
    expect(resolveBookingDateTime({ bookingDateTime: "2026-11-02T15:00:00Z" }).startMs).toBe(START);
    expect(resolveBookingDateTime({ delivery_date: "2026-11-02", delivery_time: "15:00" }).startMs).toBe(START);
  });
  it("fails closed on bad dates, bad times, and missing dates", () => {
    expect(resolveBookingDateTime({ delivery_date: "2026-02-30" }).startMs).toBeNull();
    expect(resolveBookingDateTime({ delivery_date: "2026-11-02", delivery_time: "25:00" }).startMs).toBeNull();
    expect(resolveBookingDateTime({ notes: "x" }).startMs).toBeNull();
  });
  it("date-only has no time", () => {
    const r = resolveBookingDateTime({ delivery_date: "2026-11-02" });
    expect(r.hasTime).toBe(false);
    expect(r.startMs).toBe(Date.UTC(2026, 10, 2, 9, 0));
  });
});

describe("planning", () => {
  it("plans day-before and hours-before from the booking start", () => {
    const p = planReminders({ bookingStartMs: START, hasTime: true, settings: DEF, nowMs: NOW });
    expect(p.planned).toEqual([
      { slot: "day_before", dueAtMs: START - 24 * H },
      { slot: "hours_before", dueAtMs: START - 3 * H },
    ]);
  });
  it("skips past-due slots, never backfills", () => {
    const p = planReminders({ bookingStartMs: START, hasTime: true, settings: DEF, nowMs: START - 12 * H });
    expect(p.planned.map((s) => s.slot)).toEqual(["hours_before"]);
    expect(p.skippedPast).toEqual(["day_before"]);
  });
  it("date-only plans day-before only", () => {
    const p = planReminders({ bookingStartMs: Date.UTC(2026, 10, 2, 9, 0), hasTime: false, settings: DEF, nowMs: NOW });
    expect(p.planned.map((s) => s.slot)).toEqual(["day_before"]);
  });
});

describe("messages", () => {
  it("states absolute time and place, never relative phrasing", () => {
    const m = buildReminderMessage({ businessName: "Sweet Shop", service: "Cake", bookingStartMs: START, hasTime: true, place: "12 Main Rd", language: "en" });
    expect(m).toContain("2026-11-02 15:00 UTC");
    expect(m).toContain("12 Main Rd");
    expect(m).not.toMatch(/tomorrow|next day/i);
  });
});

describe("channels", () => {
  const at = (last: number | null, tpl: boolean) => ({ lastCustomerAtMs: last, nowMs: NOW, templateConfigured: tpl });
  it("widget stores", () => {
    expect(decideChannelDelivery("widget", at(null, false)).action).toBe("store");
  });
  it("messenger template fallback after 24h, hold without one", () => {
    expect(decideChannelDelivery("messenger", at(NOW - 25 * H, true)).action).toBe("send_template");
    expect(decideChannelDelivery("messenger", at(NOW - 25 * H, false)).action).toBe("hold");
  });
  it("instagram after 24h is suppressed, whatsapp always held", () => {
    expect(decideChannelDelivery("instagram", at(NOW - 25 * H, false)).action).toBe("suppress");
    expect(decideChannelDelivery("whatsapp", at(NOW - H, false)).action).toBe("hold");
  });
});

describe("suppression", () => {
  const base = { humanHands: false, globalAiOff: false, orderStatus: "confirmed", alreadyOrdered: false, aiUnneeded: false };
  it("defers on human hands, suppresses on cancelled/re-ordered/unneeded", () => {
    expect(deferralReason({ ...base, humanHands: true })).toBe("human_hands");
    expect(suppressionReason({ ...base, orderStatus: "cancelled" })).toBe("order_not_confirmed");
    expect(suppressionReason({ ...base, alreadyOrdered: true })).toBe("already_ordered");
    expect(suppressionReason({ ...base, aiUnneeded: true })).toBe("ai_unneeded");
    expect(suppressionReason(base)).toBeNull();
  });
  it("newer same-service confirmed order counts, others do not", () => {
    const conf = Date.UTC(2026, 9, 28, 10, 0);
    const mk = (over: Record<string, unknown>) => isNewerSameServiceOrder({
      bookingItems: [{ name: "Chocolate Cake" }], bookingSummary: "", bookingConfirmedMs: conf,
      candidateId: "ord2", bookingId: "ord1", candidateStatus: "confirmed",
      candidateCreatedMs: conf + H, candidateItems: [{ name: "chocolate cake" }], candidateSummary: "", ...over,
    });
    expect(mk({})).toBe(true);
    expect(mk({ candidateItems: [{ name: "Tea" }] })).toBe(false);
    expect(mk({ candidateId: "ord1" })).toBe(false);
  });
});
