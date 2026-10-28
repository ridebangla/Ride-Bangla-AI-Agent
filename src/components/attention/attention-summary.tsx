"use client";

/**
 * AttentionSummary — TIPS Leg A (honest "gone quiet" concept), STAGED ONLY.
 *
 * Dashboard section for the read-only GET /api/attention-summary
 * response. COUNTS ONLY: no money figure is rendered anywhere here,
 * because no money figure is returned by the route. A thread shown
 * here is a thread whose customer message is still waiting for a
 * reply and whose customer has not written again for the stated
 * threshold or more. It is NOT labelled as a missed order, and the
 * footnote below says so plainly on the rendered page.
 *
 * ALL user-facing wording in this file is PROPOSAL for owner
 * approval (standing no-invented-copy rule). Numbers render only
 * after a successful load; before load the section shows
 * "Loading..." and never a placeholder zero.
 *
 * This component SENDS NOTHING: rows link to the Follow-up Queues
 * page (Leg B) and the Orders page (Leg E), where the team acts
 * thread by thread. There is no reply box, no bulk action and no
 * automatic record creation here.
 */

import { useState, useEffect } from "react";

interface QuietThread {
  conversationId: string;
  channel: string;
  customerName: string;
  status: string;
  aiEnabled: boolean;
  waitingSinceIso: string;
  lastCustomerIso: string;
  silenceHours: number;
  waitingHours: number;
  unrepliedCount: number;
  alsoHasIntent: boolean;
  hasPendingOrder: boolean;
}

interface SummaryResponse {
  windowDays: number;
  thresholds: {
    atRiskAfterHours: number;
    quietAfterHours: number;
  };
  scanTruncated: boolean;
  intentSourcesAvailable: string[];
  threadsDroppedNoLastCustomerInTail: number;
  counts: {
    unrepliedTotal: number;
    recent: number;
    atRisk: number;
    goneQuiet: number;
    atRiskWithIntent: number;
    goneQuietWithIntent: number;
    unrepliedWithIntent: number;
    pendingOrdersTotal: number;
    pendingOrdersWaiting: number;
    pendingOrdersOnGoneQuietThreads: number;
  };
  longestSilenceHours: number | null;
  quietThreadsTotal: number;
  quietThreads: QuietThread[];
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function AttentionSummary() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/attention-summary")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load attention summary");
        setData(await res.json());
      })
      .catch(() => setError("Could not load the attention summary."))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded-lg border border-rbai-border bg-white p-4 text-sm text-rbai-text-light">
        Loading attention summary…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-lg border border-rbai-border bg-white p-4 text-sm text-red-600">
        {error ?? "Could not load the attention summary."}
      </div>
    );
  }

  const c = data.counts;
  const cards = [
    {
      label: "Unreplied threads",
      value: c.unrepliedTotal,
      note: `Last ${data.windowDays} days, still waiting for a reply.`,
    },
    {
      label: `Waiting over ${data.thresholds.atRiskAfterHours} hours`,
      value: c.atRisk,
      note: "No reply and no new message for a day or more.",
    },
    {
      label: "Gone quiet",
      value: c.goneQuiet,
      note: `No reply and no new message for ${data.thresholds.quietAfterHours} hours or more.`,
    },
    {
      label: "Gone quiet with ordering intent",
      value: c.goneQuietWithIntent,
      note: "Quiet threads that also carry a pending order, open lead or recorded intent.",
    },
    {
      label: "Pending orders waiting",
      value: c.pendingOrdersWaiting,
      note: `Pending orders still awaiting team confirmation after ${data.thresholds.quietAfterHours} hours or more.`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-rbai-border bg-white p-4"
          >
            <p className="text-xs text-rbai-text-light">{card.label}</p>
            <p className="text-2xl font-bold text-rbai-text">{card.value}</p>
            <p className="text-xs text-rbai-text-light mt-1">{card.note}</p>
          </div>
        ))}
      </div>

      {data.scanTruncated && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Showing the oldest conversations scanned; more conversations
          exist beyond this view.
        </div>
      )}

      {data.quietThreads.length === 0 ? (
        <div className="rounded-lg border border-rbai-border bg-white p-4 text-sm text-rbai-text">
          {/* PROPOSAL wording — owner approval required. */}
          <p className="font-semibold">No thread has gone quiet</p>
          <p className="text-rbai-text-light mt-1">
            No unreplied thread has been silent for{" "}
            {data.thresholds.quietAfterHours} hours or more. Threads
            waiting for a reply are listed on the Follow-up Queues page.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {data.quietThreads.map((row) => (
            <div
              key={row.conversationId}
              className="rounded-lg border border-rbai-border bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-rbai-text">
                    {row.customerName}
                  </p>
                  <p className="text-xs text-rbai-text-light">
                    {row.channel} · {row.status}
                    {!row.aiEnabled && " · Team took over"}
                  </p>
                </div>
                <a
                  href="/followup-queues"
                  className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full border border-rbai-primary/40 bg-rbai-primary/10 text-rbai-primary"
                >
                  Open in Follow-up Queues
                </a>
              </div>
              <p className="text-xs text-rbai-text-light mt-2">
                Silent for {row.silenceHours} hours · Waiting since{" "}
                {formatWhen(row.waitingSinceIso)} ·{" "}
                {row.unrepliedCount} unanswered message
                {row.unrepliedCount === 1 ? "" : "s"}
                {row.alsoHasIntent && " · Also has ordering intent"}
                {row.hasPendingOrder && " · Has a pending order"}
              </p>
            </div>
          ))}
          <p className="text-xs text-rbai-text-light">
            Showing {data.quietThreads.length} of {data.quietThreadsTotal}{" "}
            quiet threads, longest silence first.
          </p>
        </div>
      )}

      <p className="text-xs text-rbai-text-light">
        {/* PROPOSAL wording — owner approval required. */}
        Counts only — no money figure is shown here. A quiet thread is
        a thread that needs a human reply first; it is not proof that
        an order was missed, and a customer may still return. Bucket
        counts (recent, waiting over a day, gone quiet) add up to the
        unreplied total; intent and pending-order counts overlap
        those buckets and must not be added to them. Intent sources
        available: {data.intentSourcesAvailable.join(", ")}. Window:{" "}
        {data.windowDays} days (inherited from the Follow-up Queues).
      </p>
      <div className="flex gap-2">
        <a
          href="/followup-queues"
          className="text-xs font-semibold px-3 py-1.5 rounded-full border border-rbai-border bg-white text-rbai-primary"
        >
          Follow-up Queues
        </a>
        <a
          href="/orders"
          className="text-xs font-semibold px-3 py-1.5 rounded-full border border-rbai-border bg-white text-rbai-primary"
        >
          Orders
        </a>
      </div>
    </div>
  );
}
