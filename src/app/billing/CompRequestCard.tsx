"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CatalogPlanView } from "@/lib/plan-catalog";

interface CompRequestCardProps {
  /** Effective catalog plans for the plan select (id + name only). */
  catalog: Pick<CatalogPlanView, "id" | "name">[];
}

interface OwnRequest {
  id: string;
  status: string;
  requestedPlanId: string | null;
}

/**
 * CompRequestCard — tenant entry point for a complimentary-access
 * request (B4). Functional labels only; the request lands in the
 * comp_requests queue for review. Shows the business's own latest
 * request status when one exists.
 */
export default function CompRequestCard({ catalog }: CompRequestCardProps) {
  const [planId, setPlanId] = useState("");
  const [note, setNote] = useState("");
  const [own, setOwn] = useState<OwnRequest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/comp-request");
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setOwn(data.request ?? null);
        }
      } catch {
        /* status line stays empty — the form still works */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/comp-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(planId ? { requestedPlanId: planId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "comp_request_failed");
        setSubmitting(false);
        return;
      }
      setOwn(data.request ?? null);
    } catch {
      setError("comp_request_failed");
    }
    setSubmitting(false);
  }

  const pending = own?.status === "pending";

  return (
    <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
      <h2 className="text-lg font-semibold text-rbai-text">
        Request complimentary access
      </h2>

      {loaded && own && (
        <p className="text-sm text-rbai-text-light mt-2">
          Status: {own.status}
          {own.requestedPlanId ? ` · Plan: ${own.requestedPlanId}` : ""}
        </p>
      )}

      {error && (
        <div className="mt-4 rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {!pending && (
        <div className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="comp-request-plan"
              className="block text-sm font-medium text-rbai-text"
            >
              Plan
            </label>
            <select
              id="comp-request-plan"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-rbai-border bg-rbai-bg px-3 py-2.5 text-sm text-rbai-text"
            >
              <option value="">—</option>
              {catalog.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="comp-request-note"
              className="block text-sm font-medium text-rbai-text"
            >
              Note
            </label>
            <textarea
              id="comp-request-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              className="mt-1 block w-full rounded-lg border border-rbai-border bg-rbai-bg px-3 py-2.5 text-sm text-rbai-text"
            />
          </div>
          <button
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-rbai-primary text-white font-medium py-2.5 px-6 text-sm hover:opacity-90 transition-colors disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit
          </button>
        </div>
      )}
    </div>
  );
}
