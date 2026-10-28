"use client";

/**
 * Dashboard > Bookings (Leg A, STAGED ONLY) — the SEPARATE bookings screen.
 *
 * This page is deliberately NOT the Orders page: it fetches ONLY
 * /api/bookings, renders ONLY booking records, and its actions are the
 * booking state machine (confirm / propose another time / return /
 * cancel). It never reads or writes product orders.
 *
 * HUMAN-ONLY ACTIONS: every button here calls PATCH /api/bookings/[id]
 * with a dashboard session (bookings:update). The agent has no tool that
 * calls that route — that is what makes "the agent never confirms" real.
 * A confirmed booking is LOCKED (Leg B owns the guard + audit trail);
 * this page's machine already refuses every exit from a confirmed booking
 * except a human-recorded cancellation.
 *
 * AVAILABILITY HONESTY: the banner below the header and the "Request —
 * not confirmed" badge exist so a requested slot is never mistaken for a
 * booked one. There is no calendar in this batch; nothing on this page
 * claims a slot is free, busy, or booked.
 *
 * PROPOSAL COPY: all user-facing strings on this page are proposal text
 * for owner approval (doctrine: no invented copy ships silently).
 * Mounting: this file is staged as a NEW page at
 * src/app/(dashboard)/bookings/page.tsx, and diff 006 adds its sidebar
 * entry (Bookings, after Orders in the Storefront section). No existing
 * dashboard page is modified by this leg.
 */

import { Header } from "@/components/layout/header";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
  CalendarClock,
  CheckCircle,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useEffect, useState } from "react";

const inputClasses =
  "w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg text-rbai-text placeholder:text-rbai-text-light/60 focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary transition-colors";

interface Toast {
  id: number;
  type: "success" | "error";
  message: string;
}

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium",
            t.type === "success" ? "bg-rbai-success text-white" : "bg-rbai-danger text-white"
          )}
        >
          {t.type === "success" ? (
            <CheckCircle className="h-4 w-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types (mirror the booking document; keep in sync with src/lib/bookings.ts)
// ---------------------------------------------------------------------------

type BookingStatus =
  | "requested"
  | "proposed"
  | "confirmed"
  | "declined"
  | "cancelled_by_customer"
  | "cancelled_by_business";

interface BookingQuestionAnswer {
  key: string;
  question: string;
  answer: string;
}

interface Booking {
  id: string;
  service: string;
  requestedSlot: string;
  requestedDate: string | null;
  requestedTime: string | null;
  place: string | null;
  whatToBring: string | null;
  questions: BookingQuestionAnswer[];
  customerName: string | null;
  customerPhone: string | null;
  advanceAmount: number | null;
  advanceCurrency: string | null;
  reminders: string[];
  proposedSlot: string | null;
  proposedDate: string | null;
  proposedTime: string | null;
  humanNote: string | null;
  status: BookingStatus;
  availabilityChecked: boolean;
  summary?: string;
  createdAt: string;
}

const STATUS_FILTERS: BookingStatus[] = [
  "requested",
  "proposed",
  "confirmed",
  "declined",
  "cancelled_by_customer",
  "cancelled_by_business",
];

const statusStyles: Record<BookingStatus, string> = {
  requested: "bg-amber-100 text-amber-800",
  proposed: "bg-sky-100 text-sky-800",
  confirmed: "bg-emerald-100 text-emerald-800",
  declined: "bg-zinc-200 text-zinc-700",
  cancelled_by_customer: "bg-rose-100 text-rose-800",
  cancelled_by_business: "bg-rose-100 text-rose-800",
};

const statusLabels: Record<BookingStatus, string> = {
  requested: "Request — not confirmed",
  proposed: "Another time proposed — not confirmed",
  confirmed: "Confirmed",
  declined: "Returned by team",
  cancelled_by_customer: "Cancelled by customer",
  cancelled_by_business: "Cancelled by business",
};

/** Which human actions the machine allows from each status (mirrors booking-state.ts). */
const ACTIONS_FROM: Record<BookingStatus, BookingStatus[]> = {
  requested: ["confirmed", "proposed", "declined", "cancelled_by_customer", "cancelled_by_business"],
  proposed: ["confirmed", "proposed", "declined", "cancelled_by_customer", "cancelled_by_business"],
  confirmed: ["cancelled_by_customer", "cancelled_by_business"],
  declined: [],
  cancelled_by_customer: [],
  cancelled_by_business: [],
};

const ACTION_LABELS: Record<string, string> = {
  confirmed: "Confirm booking",
  proposed: "Propose another time",
  declined: "Return request",
  cancelled_by_customer: "Record customer cancellation",
  cancelled_by_business: "Cancel booking",
};

export default function BookingsPage() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = (type: Toast["type"], message: string) =>
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), type, message }]);

  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  // Per-booking action form state (only one action form open at a time).
  const [actionForm, setActionForm] = useState<{
    bookingId: string;
    target: BookingStatus;
    proposedSlot: string;
    proposedDate: string;
    proposedTime: string;
    reason: string;
  } | null>(null);

  const reload = async (status = statusFilter) => {
    const q = status === "all" ? "" : `?status=${status}`;
    const res = await fetch(`/api/bookings${q}`);
    if (!res.ok) throw new Error("Failed to load bookings");
    const json = await res.json();
    setBookings(json.bookings ?? []);
  };

  useEffect(() => {
    (async () => {
      try {
        await reload("all");
      } catch {
        toast("error", "Could not load bookings.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeFilter = async (s: string) => {
    setStatusFilter(s);
    try {
      await reload(s);
    } catch {
      toast("error", "Could not load bookings.");
    }
  };

  const submitAction = async () => {
    if (!actionForm) return;
    setActing(actionForm.bookingId);
    try {
      const body: Record<string, unknown> = { status: actionForm.target };
      if (actionForm.target === "proposed") {
        body.proposedSlot = actionForm.proposedSlot;
        if (actionForm.proposedDate) body.proposedDate = actionForm.proposedDate;
        if (actionForm.proposedTime) body.proposedTime = actionForm.proposedTime;
      }
      if (
        actionForm.target === "declined" ||
        actionForm.target === "cancelled_by_customer" ||
        actionForm.target === "cancelled_by_business"
      ) {
        body.reason = actionForm.reason;
      }
      const res = await fetch(`/api/bookings/${actionForm.bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Update failed");
      }
      toast("success", `Booking ${actionForm.target.replaceAll("_", " ")}.`);
      setActionForm(null);
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Failed.");
    } finally {
      setActing(null);
    }
  };

  const openForm = (b: Booking, target: BookingStatus) =>
    setActionForm({
      bookingId: b.id,
      target,
      proposedSlot: "",
      proposedDate: "",
      proposedTime: "",
      reason: "",
    });

  const advanceLabel = (b: Booking) => {
    if (b.advanceAmount === null || b.advanceAmount === undefined) return "Not stated";
    return b.advanceCurrency
      ? `${b.advanceAmount} ${b.advanceCurrency}`
      : `${b.advanceAmount} (currency not stated)`;
  };

  return (
    <div className="p-6 max-w-6xl space-y-4">
      <Header
        title="Bookings"
        description="Booking requests captured by your AI — confirm, propose another time, or return them here"
      />
      <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
        A requested slot is only a request — nothing here is confirmed until your team confirms
        it. This system has no calendar, so no slot is ever shown as free, busy, or booked.
      </p>
      <ToastContainer toasts={toasts} />

      <div className="flex items-center gap-2 flex-wrap">
        {["all", ...STATUS_FILTERS].map((s) => (
          <button
            key={s}
            onClick={() => changeFilter(s)}
            className={cn(
              "px-3 py-1.5 text-sm rounded-full border capitalize transition-colors",
              statusFilter === s
                ? "bg-rbai-primary text-white border-rbai-primary"
                : "border-rbai-border text-rbai-text hover:bg-rbai-bg"
            )}
          >
            {s.replaceAll("_", " ")}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-rbai-text-light py-10">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading bookings…
        </div>
      ) : bookings.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No bookings yet"
          description="When your AI collects a booking request in chat, it appears here for your team to confirm, propose another time, or return."
        />
      ) : (
        <div className="rounded-xl border border-rbai-border bg-rbai-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rbai-border text-left text-rbai-text-light">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Service</th>
                <th className="px-4 py-3 font-medium">Requested slot</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  expanded={expanded === b.id}
                  onToggle={() => setExpanded(expanded === b.id ? null : b.id)}
                  acting={acting === b.id}
                  actionForm={actionForm && actionForm.bookingId === b.id ? actionForm : null}
                  onOpenForm={openForm}
                  onFormChange={setActionForm}
                  onSubmit={submitAction}
                  onCancelForm={() => setActionForm(null)}
                  advanceLabel={advanceLabel(b)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BookingRow({
  booking: b,
  expanded,
  onToggle,
  acting,
  actionForm,
  onOpenForm,
  onFormChange,
  onSubmit,
  onCancelForm,
  advanceLabel,
}: {
  booking: Booking;
  expanded: boolean;
  onToggle: () => void;
  acting: boolean;
  actionForm: {
    bookingId: string;
    target: BookingStatus;
    proposedSlot: string;
    proposedDate: string;
    proposedTime: string;
    reason: string;
  } | null;
  onOpenForm: (b: Booking, target: BookingStatus) => void;
  onFormChange: (
    f: {
      bookingId: string;
      target: BookingStatus;
      proposedSlot: string;
      proposedDate: string;
      proposedTime: string;
      reason: string;
    } | null
  ) => void;
  onSubmit: () => void;
  onCancelForm: () => void;
  advanceLabel: string;
}) {
  const customer = [b.customerName, b.customerPhone].filter(Boolean).join(" · ") || "—";
  const canAct = ACTIONS_FROM[b.status];
  const formValid =
    !actionForm ||
    (actionForm.target === "proposed"
      ? actionForm.proposedSlot.trim() !== ""
      : actionForm.target === "declined" ||
          actionForm.target === "cancelled_by_customer" ||
          actionForm.target === "cancelled_by_business"
        ? actionForm.reason.trim() !== ""
        : true);
  return (
    <>
      <tr className="border-b border-rbai-border align-top">
        <td className="px-4 py-3 text-rbai-text-light whitespace-nowrap">
          {b.createdAt ? new Date(b.createdAt).toLocaleDateString() : "—"}
        </td>
        <td className="px-4 py-3 font-medium">{b.service}</td>
        <td className="px-4 py-3">
          {b.requestedSlot}
          {b.requestedDate ? ` · ${b.requestedDate}` : ""}
          {b.requestedTime ? ` ${b.requestedTime}` : ""}
        </td>
        <td className="px-4 py-3">{customer}</td>
        <td className="px-4 py-3">
          <span
            className={cn(
              "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
              statusStyles[b.status]
            )}
          >
            {statusLabels[b.status]}
          </span>
        </td>
        <td className="px-4 py-3 text-right">
          <button onClick={onToggle} className="text-rbai-primary text-sm inline-flex items-center gap-1">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Details
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-rbai-border bg-rbai-bg/50">
          <td colSpan={6} className="px-4 py-4">
            <dl className="grid gap-2 text-sm">
              <div className="flex gap-2">
                <dt className="text-rbai-text-light min-w-32">Place:</dt>
                <dd>{b.place || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-rbai-text-light min-w-32">What to bring:</dt>
                <dd>{b.whatToBring || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-rbai-text-light min-w-32">Advance:</dt>
                <dd>{advanceLabel}</dd>
              </div>
              {b.proposedSlot && (
                <div className="flex gap-2">
                  <dt className="text-rbai-text-light min-w-32">Proposed time:</dt>
                  <dd>
                    {b.proposedSlot}
                    {b.proposedDate ? ` · ${b.proposedDate}` : ""}
                    {b.proposedTime ? ` ${b.proposedTime}` : ""}
                  </dd>
                </div>
              )}
              {b.humanNote && (
                <div className="flex gap-2">
                  <dt className="text-rbai-text-light min-w-32">Team note:</dt>
                  <dd>{b.humanNote}</dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="text-rbai-text-light min-w-32">Reminders:</dt>
                <dd>{b.reminders?.length ? b.reminders.join("; ") : "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-rbai-text-light min-w-32">Questions &amp; answers:</dt>
                <dd>
                  {b.questions?.length
                    ? b.questions.map((q) => `${q.question || q.key}: ${q.answer}`).join(" · ")
                    : "—"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-rbai-text-light min-w-32">Availability:</dt>
                <dd>Not checked — no calendar in this system. This slot is a request only.</dd>
              </div>
            </dl>

            {canAct.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {canAct.map((target) => (
                  <button
                    key={target}
                    onClick={() => onOpenForm(b, target)}
                    className="px-3 py-1.5 text-sm rounded-lg border border-rbai-border hover:bg-rbai-bg"
                  >
                    {ACTION_LABELS[target]}
                  </button>
                ))}
              </div>
            )}

            {actionForm && (
              <div className="mt-4 space-y-2 max-w-md">
                {actionForm.target === "proposed" && (
                  <>
                    <input
                      className={inputClasses}
                      placeholder="Alternative slot, e.g. Sunday afternoon"
                      value={actionForm.proposedSlot}
                      onChange={(e) =>
                        onFormChange({ ...actionForm, proposedSlot: e.target.value })
                      }
                    />
                    <div className="flex gap-2">
                      <input
                        className={inputClasses}
                        placeholder="Date YYYY-MM-DD (optional)"
                        value={actionForm.proposedDate}
                        onChange={(e) =>
                          onFormChange({ ...actionForm, proposedDate: e.target.value })
                        }
                      />
                      <input
                        className={inputClasses}
                        placeholder="Time HH:MM (optional)"
                        value={actionForm.proposedTime}
                        onChange={(e) =>
                          onFormChange({ ...actionForm, proposedTime: e.target.value })
                        }
                      />
                    </div>
                  </>
                )}
                {(actionForm.target === "declined" ||
                  actionForm.target === "cancelled_by_customer" ||
                  actionForm.target === "cancelled_by_business") && (
                  <input
                    className={inputClasses}
                    placeholder="Reason (required)"
                    value={actionForm.reason}
                    onChange={(e) => onFormChange({ ...actionForm, reason: e.target.value })}
                  />
                )}
                <div className="flex gap-2">
                  <button
                    onClick={onSubmit}
                    disabled={!formValid || acting}
                    className="px-4 py-2 text-sm rounded-lg bg-rbai-primary text-white disabled:opacity-50"
                  >
                    {acting ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={onCancelForm}
                    className="px-4 py-2 text-sm rounded-lg border border-rbai-border"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
