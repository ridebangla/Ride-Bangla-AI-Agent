"use client";

/**
 * Follow-up Queues page — LEG B (video round 2), STAGED ONLY.
 *
 * Two SEPARATE sections (tabs), never merged into one list:
 *   - "Unreplied": customer messages in the last 30 days with no
 *     recorded assistant/admin reply after them.
 *   - "Ordering intent": conversations with RECORDED ordering intent
 *     in the last 30 days (pending order / open lead / recorded
 *     warm-hot state — see the API route for the exact sources).
 * A thread in both queues shows in both tabs with a badge saying so;
 * the tabs are two lenses, not a partition, and their counts are
 * never summed as unique customers.
 *
 * This page SENDS NOTHING. There is no reply box here, no bulk
 * action, and no automatic record creation: each row links to the
 * Inbox, where the team replies thread by thread. There is no
 * deep-link to a single thread at HEAD (the Inbox selects threads
 * by client state), so the link lands on the Inbox list and the
 * team finds the thread by the customer name shown.
 *
 * ALL user-facing wording on this page is PROPOSAL for owner
 * approval (no invented copy is silently shipped). In particular
 * the empty states below are proposals: they are shown only when
 * the corresponding queue array is genuinely empty, and they never
 * claim anything about customers outside the 30-day window or
 * outside the recorded-state definitions.
 */

import { Header } from "@/components/layout/header";
import { MessageSquare, Inbox } from "lucide-react";
import { useState, useEffect } from "react";

interface Evidence {
  source: string;
  detail: string;
  recordedAtIso: string;
  orderId: string | null;
  leadStage: string | null;
}

interface UnrepliedRow {
  conversationId: string;
  channel: string;
  customerName: string;
  customerContact: string;
  status: string;
  aiEnabled: boolean;
  waitingSinceIso: string;
  unrepliedCount: number;
  lastCustomerPreview: string;
  alsoHasIntent: boolean;
  messagesTruncated?: boolean;
}

interface IntentRow {
  conversationId: string;
  channel: string;
  customerName: string;
  customerContact: string;
  status: string;
  aiEnabled: boolean;
  intentRecordedAtIso: string;
  evidence: Evidence[];
  pendingOrderId: string | null;
  leadStage: string | null;
  alsoUnreplied: boolean;
  messagesTruncated?: boolean;
}

interface QueuesResponse {
  window: { days: number; startMs: number; endMs: number };
  scannedConversations: number;
  scanTruncated: boolean;
  intentSourcesAvailable: string[];
  blockedExcludedCount: number;
  counts: {
    unreplied: number;
    orderingIntent: number;
    overlap: number;
  };
  overlapConversationIds: string[];
  unreplied: UnrepliedRow[];
  orderingIntent: IntentRow[];
}

function wholeDaysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function FollowupQueuesPage() {
  const [tab, setTab] = useState<"unreplied" | "intent">("unreplied");
  const [data, setData] = useState<QueuesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/followup-queues")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load follow-up queues");
        setData(await res.json());
      })
      .catch(() => setError("Could not load the follow-up queues."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Header
        title="Follow-up Queues"
        description="Messages waiting for a reply, and ordering intent waiting for follow-up — last 30 days"
      />
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="flex items-center justify-center h-40">
            <div className="text-sm text-rbai-text-light">Loading...</div>
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-rbai-border bg-white p-4 text-sm text-red-600">
            {error}
          </div>
        )}
        {data && (
          <>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTab("unreplied")}
                className={`px-4 py-2 rounded-lg text-sm font-semibold border ${
                  tab === "unreplied"
                    ? "bg-rbai-primary text-white border-rbai-primary"
                    : "bg-white text-rbai-text border-rbai-border"
                }`}
              >
                Unreplied ({data.counts.unreplied})
              </button>
              <button
                type="button"
                onClick={() => setTab("intent")}
                className={`px-4 py-2 rounded-lg text-sm font-semibold border ${
                  tab === "intent"
                    ? "bg-rbai-primary text-white border-rbai-primary"
                    : "bg-white text-rbai-text border-rbai-border"
                }`}
              >
                Ordering intent ({data.counts.orderingIntent})
              </button>
            </div>

            {data.scanTruncated && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                Showing the oldest {data.scannedConversations} conversations
                scanned; more conversations exist beyond this view.
              </div>
            )}

            {tab === "unreplied" &&
              (data.unreplied.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 px-6 text-center rounded-lg border border-rbai-border bg-white">
                  <div className="p-4 rounded-full bg-green-50 mb-4">
                    <MessageSquare className="h-8 w-8 text-green-500" />
                  </div>
                  {/* PROPOSAL wording — owner approval required. */}
                  <p className="font-semibold text-rbai-text">All caught up</p>
                  <p className="text-sm text-rbai-text-light mt-1">
                    No customer message in the last 30 days is waiting for
                    a reply.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {data.unreplied.map((row) => (
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
                            {row.channel} · {row.customerContact} ·{" "}
                            {row.status}
                            {!row.aiEnabled && " · Team took over"}
                          </p>
                        </div>
                        <a
                          href="/inbox"
                          className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full border border-rbai-primary/40 bg-rbai-primary/10 text-rbai-primary"
                        >
                          Open in Inbox
                        </a>
                      </div>
                      <p className="text-sm text-rbai-text mt-2">
                        {row.lastCustomerPreview}
                      </p>
                      <p className="text-xs text-rbai-text-light mt-2">
                        Waiting since {formatWhen(row.waitingSinceIso)} (
                        {wholeDaysSince(row.waitingSinceIso)} days) ·{" "}
                        {row.unrepliedCount} unanswered message
                        {row.unrepliedCount === 1 ? "" : "s"}
                        {row.alsoHasIntent &&
                          " · Also in ordering-intent queue"}
                        {row.messagesTruncated &&
                          " · Long thread — earliest messages not scanned"}
                      </p>
                    </div>
                  ))}
                </div>
              ))}

            {tab === "intent" &&
              (data.orderingIntent.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 px-6 text-center rounded-lg border border-rbai-border bg-white">
                  <div className="p-4 rounded-full bg-green-50 mb-4">
                    <Inbox className="h-8 w-8 text-green-500" />
                  </div>
                  {/* PROPOSAL wording — owner approval required. */}
                  <p className="font-semibold text-rbai-text">
                    No ordering intent waiting
                  </p>
                  <p className="text-sm text-rbai-text-light mt-1">
                    No recorded ordering intent in the last 30 days is
                    waiting for follow-up.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {data.orderingIntent.map((row) => (
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
                            {row.channel} · {row.customerContact} ·{" "}
                            {row.status}
                            {!row.aiEnabled && " · Team took over"}
                          </p>
                        </div>
                        <a
                          href="/inbox"
                          className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full border border-rbai-primary/40 bg-rbai-primary/10 text-rbai-primary"
                        >
                          Open in Inbox
                        </a>
                      </div>
                      <p className="text-xs text-rbai-text-light mt-2">
                        Intent recorded{" "}
                        {formatWhen(row.intentRecordedAtIso)} ·{" "}
                        {row.evidence
                          .map((e) => `${e.source} (${e.detail})`)
                          .join(", ")}
                        {row.alsoUnreplied && " · Also unreplied"}
                      </p>
                    </div>
                  ))}
                </div>
              ))}

            <p className="text-xs text-rbai-text-light">
              Intent sources available:{" "}
              {data.intentSourcesAvailable.join(", ")}. Queues cover the
              last {data.window.days} days; a thread in both queues
              appears in both tabs ({data.counts.overlap} overlapping).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
