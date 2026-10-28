/**
 * Agent Desk dashboard page — STAGED ONLY (agent booking
 * batch, LEG G). Route: /agent-desk (sidebar: System > Agent Desk).
 *
 * WHAT THE OWNER DOES HERE, IN ORDER:
 *  1. Writes agent rules in PLAIN LANGUAGE (one textarea — no
 *     code, no forms-only editing).
 *  2. Types a customer test message and sees a TEST REPLY inside
 *     a phone frame, generated under the new rule — before
 *     anything goes live. The preview banner always says the
 *     reply was NOT sent to any customer.
 *  3. Saves a draft (still not live — the old rule keeps
 *     answering customers).
 *  4. Publishes ONLY by ticking the explicit approval checkbox
 *     and clicking Publish; until then the old rule stays live.
 *  5. Rolls back with ONE click to the last live version, and
 *     reads full version history (who changed what, when).
 *
 * ALL WORDING ON THIS PAGE IS PROPOSAL TEXT for the owner's
 * approval (no user-facing copy is silently shipped): the page
 * is staged, not live, and its strings are listed as open
 * decisions in the leg report.
 *
 * The page never invents data: every version, status, and drift
 * flag comes from GET /api/agent-desk, and an empty state says
 * plainly that no rule version exists yet.
 */
"use client";

import { Header } from "@/components/layout/header";
import { diffRuleText } from "@/lib/agent-desk";
import { useCallback, useEffect, useState } from "react";

type Status = "DRAFT" | "LIVE" | "SUPERSEDED" | "DISCARDED";

interface VersionRow {
  id: string;
  versionNumber: number;
  status: Status;
  plainText: string;
  changeNote: string;
  createdByName: string;
  createdAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
  origin: "draft" | "rollback";
  restoresVersion: number | null;
}

interface DeskStatus {
  live: VersionRow | null;
  draft: VersionRow | null;
  history: VersionRow[];
  liveMirror: string;
  drift: "none" | "mirror_differs" | "legacy";
}

interface PreviewResult {
  businessName: string;
  reply: string;
  isPreview: true;
  notSent: true;
  rulesVersionNumber: number | null;
  source: string;
  warnings: string[];
  model: string;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export default function AgentDeskPage() {
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/agent-desk");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load Agent Desk");
      setStatus(data as DeskStatus);
      if (data.draft) {
        setRuleText(data.draft.plainText);
        setChangeNote(data.draft.changeNote || "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Agent Desk");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function callApi(
    path: string,
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { ok: res.ok, data };
  }

  async function handlePreview() {
    setPreviewBusy(true);
    setNotice("");
    setError("");
    // Preview the text as typed (unsaved) when it differs from the
    // saved draft, otherwise preview the saved draft row.
    const body =
      status?.draft && ruleText === status.draft.plainText
        ? { draftId: status.draft.id, testMessage }
        : { plainText: ruleText, testMessage };
    const { ok, data } = await callApi("/api/agent-desk/preview", body);
    setPreviewBusy(false);
    if (!ok) {
      const codes = Array.isArray(data.codes)
        ? ` (${(data.codes as string[]).join(", ")})`
        : "";
      setError(`${String(data.error || "Preview failed")}${codes}`);
      return;
    }
    setPreview(data as unknown as PreviewResult);
  }

  async function handleSaveDraft() {
    setBusy(true);
    setNotice("");
    setError("");
    const { ok, data } = await callApi("/api/agent-desk/drafts", {
      plainText: ruleText,
      changeNote,
    });
    setBusy(false);
    if (!ok) {
      const codes = Array.isArray(data.codes)
        ? ` (${(data.codes as string[]).join(", ")})`
        : "";
      setError(`${String(data.error || "Save failed")}${codes}`);
      return;
    }
    setNotice("Draft saved. Nothing has gone live.");
    await refresh();
  }

  async function handlePublish() {
    if (!status?.draft) return;
    setBusy(true);
    setNotice("");
    setError("");
    const { ok, data } = await callApi("/api/agent-desk/publish", {
      draftId: status.draft.id,
      approved,
    });
    setBusy(false);
    if (!ok) {
      setError(String(data.error || "Publish failed"));
      return;
    }
    setApproved(false);
    setNotice("Published. The new rule is now live.");
    await refresh();
  }

  async function handleRollback() {
    setBusy(true);
    setNotice("");
    setError("");
    const { ok, data } = await callApi("/api/agent-desk/rollback", {});
    setBusy(false);
    if (!ok) {
      setError(String(data.error || "Rollback failed"));
      return;
    }
    setNotice(
      `Rolled back to version ${String(data.restoredVersion)}. The previous live rule is still in history.`
    );
    await refresh();
  }

  if (loading) {
    return (
      <div className="p-6">
        <Header title="Agent Desk" description="Plain-language agent rules, previewed before they go live" />
        <p className="mt-6 text-sm">Loading…</p>
      </div>
    );
  }

  const canRollback =
    !!status?.live &&
    status.history.some(
      (v) =>
        v.status === "SUPERSEDED" && v.versionNumber < status.live!.versionNumber
    );

  return (
    <div className="p-6 space-y-6">
      <Header title="Agent Desk" description="Plain-language agent rules, previewed before they go live" />

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      {/* Live now */}
      <section className="rounded border p-4 space-y-2">
        <h2 className="text-base font-semibold">Live now</h2>
        {status?.live ? (
          <div className="text-sm space-y-1">
            <p>
              Version {status.live.versionNumber} · by{" "}
              {status.live.createdByName} ·{" "}
              {fmtDate(status.live.publishedAt || status.live.createdAt)}
            </p>
            <p className="whitespace-pre-wrap rounded bg-gray-50 p-3">
              {status.live.plainText}
            </p>
          </div>
        ) : (
          <p className="text-sm">
            No Agent Desk rule has gone live yet. The agent uses its
            existing behaviour until you publish a first version.
          </p>
        )}
        {status?.drift === "mirror_differs" && (
          <p className="text-sm text-amber-800">
            The live behaviour differs from the live version shown
            above — it may have been edited outside Agent Desk, or
            a publish may have been interrupted. Re-publish the
            live version to restore it.
          </p>
        )}
        {status?.drift === "legacy" && (
          <p className="text-sm text-gray-600">
            The agent currently uses behaviour set before Agent
            Desk existed. Save it as a first draft below to bring
            it under version control.
          </p>
        )}
        <button
          type="button"
          onClick={handleRollback}
          disabled={!canRollback || busy}
          className="rounded bg-gray-800 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Roll back to last live version
        </button>
        {!canRollback && (
          <p className="text-xs text-gray-500">
            Rollback is available once a second version has gone live.
          </p>
        )}
      </section>

      {/* Edit + preview */}
      <section className="rounded border p-4 space-y-3">
        <h2 className="text-base font-semibold">
          Edit the rules in plain language
        </h2>
        <textarea
          value={ruleText}
          onChange={(e) => setRuleText(e.target.value)}
          rows={8}
          className="w-full rounded border p-3 text-sm"
          placeholder="Write how the agent should behave, in your own words…"
        />
        <input
          value={changeNote}
          onChange={(e) => setChangeNote(e.target.value)}
          className="w-full rounded border p-3 text-sm"
          placeholder="What changed? (optional, in your own words)"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={busy || !ruleText.trim()}
            className="rounded bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Save draft (not live yet)
          </button>
        </div>

        <div className="space-y-2 border-t pt-3">
          <h3 className="text-sm font-semibold">
            Test it before it goes live
          </h3>
          <input
            value={testMessage}
            onChange={(e) => setTestMessage(e.target.value)}
            className="w-full rounded border p-3 text-sm"
            placeholder="Type a customer message to test…"
          />
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewBusy || !ruleText.trim() || !testMessage.trim()}
            className="rounded bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {previewBusy ? "Generating test reply…" : "See test reply"}
          </button>
          {preview && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-amber-800">
                TEST PREVIEW — this reply was NOT sent to any customer.
              </p>
              {/* Phone frame: how the reply looks on a customer's phone. */}
              <div className="mx-auto w-full max-w-[320px] rounded-[2rem] border-2 border-gray-800 p-3 shadow">
                <p className="border-b pb-2 text-center text-sm font-semibold">
                  {preview.businessName}
                </p>
                <div className="mt-3 rounded-2xl rounded-tl-sm bg-gray-100 p-3 text-sm whitespace-pre-wrap">
                  {preview.reply}
                </div>
                <p className="mt-2 text-center text-[11px] text-gray-500">
                  Test reply · model {preview.model}
                </p>
              </div>
              {preview.warnings.length > 0 && (
                <p className="text-xs text-amber-800">
                  Check before publishing: {preview.warnings.join(", ")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t pt-3">
          <h3 className="text-sm font-semibold">Go live</h3>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            <span>
              I approve this draft going live. Until I tick this and
              publish, the old rule stays live.
            </span>
          </label>
          <button
            type="button"
            onClick={handlePublish}
            disabled={!status?.draft || !approved || busy}
            className="rounded bg-green-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Publish
          </button>
          {!status?.draft && (
            <p className="text-xs text-gray-500">
              Save a draft first, then publish it from here.
            </p>
          )}
        </div>
      </section>

      {/* History */}
      <section className="rounded border p-4 space-y-3">
        <h2 className="text-base font-semibold">Version history</h2>
        {!status?.history.length ? (
          <p className="text-sm">No versions yet.</p>
        ) : (
          <ul className="space-y-3">
            {status.history.map((v) => {
              const prev = [...status.history]
                .filter((o) => o.versionNumber < v.versionNumber)
                .sort((a, b) => b.versionNumber - a.versionNumber)[0];
              const d = prev ? diffRuleText(prev.plainText, v.plainText) : null;
              return (
                <li key={v.id} className="rounded border p-3 text-sm">
                  <p className="font-semibold">
                    Version {v.versionNumber} · {v.status}
                    {v.origin === "rollback"
                      ? ` · rolled back to version ${v.restoresVersion}`
                      : ""}
                  </p>
                  <p className="text-gray-600">
                    By {v.createdByName} · {fmtDate(v.createdAt)}
                    {v.publishedAt ? ` · live from ${fmtDate(v.publishedAt)}` : ""}
                  </p>
                  {v.changeNote && <p>Note: {v.changeNote}</p>}
                  {d && (d.added.length > 0 || d.removed.length > 0) && (
                    <div className="mt-1 text-xs">
                      {d.added.map((line, i) => (
                        <p key={`a${i}`} className="text-green-800">+ {line}</p>
                      ))}
                      {d.removed.map((line, i) => (
                        <p key={`r${i}`} className="text-red-800">− {line}</p>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="mt-2 text-xs underline"
                    onClick={() => {
                      setRuleText(v.plainText);
                      setChangeNote("");
                      setPreview(null);
                      setNotice(
                        `Loaded version ${v.versionNumber} into the editor. Save it as a new draft to publish it.`
                      );
                    }}
                  >
                    Use this text for a new draft
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
