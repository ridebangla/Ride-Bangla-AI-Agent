/**
 * LEG D (video round 2) — Reply approvals review surface. STAGED ONLY.
 *
 * Dashboard page: the team reviews pending agent drafts before they
 * auto-send. Each card shows the draft text, the customer message it
 * answers, and a LIVE countdown to auto-send (ticking client-side
 * from the server's autoSendAt; when the server reports a hold
 * decision — takeover, global off, mode off, paused, waiting — the
 * card shows the hold reason instead of a ticking timer, so the team
 * is never shown a countdown the server will not honour).
 *
 * Actions per draft: Send now, Reject, Edit (textarea + Save edit —
 * saving restarts the timer with the current wait setting), and
 * Pause/Resume this chat's auto-send. The top card holds the
 * tenant-wide mode switch + wait-seconds input, saved through the
 * existing Settings PUT (schema extended by this leg's diff).
 *
 * ALL page wording is PROPOSAL for owner approval. This page never
 * sends on load or on poll: polling only refreshes the list; sending
 * happens only via an explicit button or the server sweep.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

interface DraftRow {
  id: string;
  conversationId: string;
  customerName: string;
  channel: string;
  customerMessage: string;
  draftText: string;
  editedText: string | null;
  status: string;
  autoSendAt: string | null;
  remainingMs: number | null;
  timerDecision: string;
  timerReason: string;
  chatPaused: boolean;
  takeoverActive: boolean;
  createdAt: string;
  editedByName: string | null;
}

interface SettingsSnapshot {
  replyApprovalEnabled: boolean;
  replyApprovalWaitSeconds: number;
  globalAiEnabled: boolean;
}

function formatRemaining(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export default function ReplyApprovalsPage() {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [enabled, setEnabled] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(300);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/reply-approvals?status=${statusFilter}`);
      if (!res.ok) return;
      const data = await res.json();
      setDrafts(data.drafts || []);
      if (data.settings) {
        setSettings(data.settings);
        setEnabled(data.settings.replyApprovalEnabled);
        setWaitSeconds(data.settings.replyApprovalWaitSeconds);
      }
    } catch {
      /* list refresh is best-effort; the team can retry */
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 10000);
    return () => clearInterval(poll);
  }, [load]);

  // Live countdown tick: re-render every second so the countdown
  // moves without refetching. Server values stay authoritative.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function act(id: string, action: string, text?: string) {
    setNotice("");
    const res = await fetch(`/api/reply-approvals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(text !== undefined ? { action, text } : { action }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setNotice(data.error || "That action did not go through.");
      return;
    }
    await load();
  }

  async function saveSettings() {
    setNotice("");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyApprovalEnabled: enabled,
        replyApprovalWaitSeconds: waitSeconds,
      }),
    });
    if (!res.ok) {
      setNotice("Settings did not save. Check the wait value and try again.");
      return;
    }
    setNotice("Approval settings saved.");
    await load();
  }

  async function setPause(conversationId: string, paused: boolean) {
    setNotice("");
    const res = await fetch(`/api/conversations/${conversationId}/approval-pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    });
    if (!res.ok) setNotice("Pause did not change.");
    await load();
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Reply approvals</h1>
      <p className="text-sm text-gray-600">
        Draft replies waiting for review. A draft sends itself when its
        timer runs out, unless you send it, reject it, or edit it first.
      </p>

      {notice && <p className="text-sm border rounded p-2">{notice}</p>}

      <section className="border rounded p-3 space-y-2">
        <h2 className="font-semibold">Approval mode</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Hold agent replies for review before sending
        </label>
        <label className="flex items-center gap-2 text-sm">
          Auto-send after (seconds)
          <input
            type="number"
            min={30}
            max={86400}
            value={waitSeconds}
            onChange={(e) => setWaitSeconds(Number(e.target.value))}
            className="border rounded px-2 py-1 w-24"
          />
        </label>
        <button onClick={saveSettings} className="border rounded px-3 py-1 text-sm">
          Save approval settings
        </button>
        {settings && !settings.globalAiEnabled && (
          <p className="text-sm">
            The global AI switch is off, so no draft will auto-send until
            it is turned back on.
          </p>
        )}
      </section>

      <div className="flex gap-2 text-sm">
        {(["pending", "sent", "rejected", "superseded", "cancelled"] as const).map(
          (s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`border rounded px-2 py-1 ${statusFilter === s ? "font-bold" : ""}`}
            >
              {s}
            </button>
          )
        )}
      </div>

      {drafts.length === 0 && (
        <p className="text-sm text-gray-600">No drafts in this view.</p>
      )}

      {drafts.map((d) => {
        const shownText = d.editedText ?? d.draftText;
        // Live countdown: recomputed from the server's autoSendAt on
        // every 1s tick, so it falls in real time between list polls.
        // The server's remainingMs / timerDecision stay authoritative
        // for hold vs send; this is display only. `tick` is read here
        // so the interval re-render actually recomputes the value.
        void tick;
        const liveRemaining =
          d.autoSendAt === null
            ? null
            : Math.max(0, new Date(d.autoSendAt).getTime() - Date.now());
        return (
          <article key={d.id} className="border rounded p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="font-semibold">
                {d.customerName} · {d.channel || "chat"}
              </span>
              <span>
                {d.timerDecision === "send"
                  ? "Due — sends on the next sweep"
                  : d.timerDecision === "cancel"
                    ? "Will not send"
                    : d.timerDecision === "hold"
                      ? `On hold: ${d.timerReason}`
                      : d.timerDecision === "noop"
                        ? `Status: ${d.status}`
                        : `Auto-sends in ${formatRemaining(liveRemaining)}`}
              </span>
            </div>
            {d.customerMessage && (
              <p className="text-sm text-gray-600">Customer: {d.customerMessage}</p>
            )}
            <p className="text-sm whitespace-pre-wrap">{shownText}</p>
            {d.editedByName && (
              <p className="text-xs text-gray-500">Edited by {d.editedByName}</p>
            )}
            {d.takeoverActive && (
              <p className="text-xs">A team member has taken over this chat.</p>
            )}
            {d.status === "pending" && (
              <div className="space-y-2">
                <textarea
                  value={edits[d.id] ?? shownText}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [d.id]: e.target.value }))
                  }
                  className="w-full border rounded p-2 text-sm"
                  rows={3}
                />
                <div className="flex flex-wrap gap-2 text-sm">
                  <button
                    onClick={() => act(d.id, "send-now")}
                    className="border rounded px-3 py-1"
                  >
                    Send now
                  </button>
                  <button
                    onClick={() => act(d.id, "edit", edits[d.id] ?? shownText)}
                    className="border rounded px-3 py-1"
                  >
                    Save edit (timer restarts)
                  </button>
                  <button
                    onClick={() => act(d.id, "reject")}
                    className="border rounded px-3 py-1"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => setPause(d.conversationId, !d.chatPaused)}
                    className="border rounded px-3 py-1"
                  >
                    {d.chatPaused ? "Resume auto-send" : "Pause auto-send"}
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
