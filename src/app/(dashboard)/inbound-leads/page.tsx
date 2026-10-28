"use client";

/**
 * Inbound Leads — dashboard page for THIS business's inbound pipeline.
 *
 * This page is deliberately SEPARATE from /leads ("Lead Engine"): that
 * page serves the OUTBOUND Harvey pipeline. This page serves inbound
 * leads only (customers who showed buying/booking interest), from
 * /api/inbound-leads, with three views: a 6-stage pipeline, a searchable
 * list, and a Today list (who to call today, plus overdue follow-ups).
 *
 * All user-facing labels on this page are PROPOSALS for owner approval
 * (no invented copy is silently shipped); stage keys come from the
 * shared pure module so the page can never drift from the API contract.
 * This page never confirms an order and never quotes a fare or price.
 */

import { Header } from "@/components/layout/header";
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  INBOUND_LEAD_STAGES,
  INBOUND_LEAD_STAGE_LABELS,
  type InboundLeadStage,
} from "@/lib/inbound-leads";

const cardClass = "bg-rbai-surface rounded-xl border border-rbai-border p-4";
const inputClass =
  "w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary text-rbai-text";
const labelClass = "block text-xs font-medium text-rbai-text-light mb-1";
const primaryBtn =
  "flex items-center gap-2 px-4 py-2 bg-rbai-primary text-white rounded-lg hover:bg-rbai-primary-dark transition-colors text-sm font-medium disabled:opacity-50";
const ghostBtn =
  "flex items-center gap-2 px-3 py-2 border border-rbai-border rounded-lg text-sm text-rbai-text hover:border-rbai-primary hover:text-rbai-primary transition-colors disabled:opacity-50";

interface LeadRow {
  id: string;
  name: string;
  phone: string;
  interest: string;
  note: string;
  followUpDate: string | null;
  source: string;
  channel: string;
  stage: string;
  assignedToId: string | null;
  assignedToName: string;
  createdAt: string;
}

interface MemberRow {
  id: string;
  name: string;
}

type View = "pipeline" | "list" | "today";

const NEXT_STAGE: Record<string, InboundLeadStage | null> = {
  new: "contacted",
  contacted: "interested",
  interested: "quoted",
  quoted: "won",
  won: null,
  lost: null,
};

async function apiJson(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function InboundLeadsPage() {
  const [view, setView] = useState<View>("pipeline");
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [today, setToday] = useState<LeadRow[]>([]);
  const [overdue, setOverdue] = useState<LeadRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [analytics, setAnalytics] = useState<Record<string, unknown> | null>(null);
  const [windowDays, setWindowDays] = useState("7");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    phone: "",
    interest: "",
    note: "",
    followUpDate: "",
  });
  const [formError, setFormError] = useState("");

  const loadLeads = useCallback(async () => {
    const q = new URLSearchParams();
    if (search.trim()) q.set("search", search.trim());
    if (stageFilter !== "all") q.set("stage", stageFilter);
    q.set("limit", "100");
    const data = await apiJson(`/api/inbound-leads?${q.toString()}`);
    setLeads(Array.isArray(data.data) ? data.data : []);
  }, [search, stageFilter]);

  const loadToday = useCallback(async () => {
    const data = await apiJson("/api/inbound-leads?view=today");
    setToday(Array.isArray(data.today) ? data.today : []);
    setOverdue(Array.isArray(data.overdue) ? data.overdue : []);
  }, []);

  const loadAnalytics = useCallback(async () => {
    const data = await apiJson(
      `/api/analytics/inbound-leads?window=${windowDays}`,
    );
    setAnalytics(data);
  }, [windowDays]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const membersData = await apiJson("/api/team/members?limit=100").catch(
        () => ({ data: [] }),
      );
      setMembers(Array.isArray(membersData.data) ? membersData.data : []);
      await Promise.all([loadLeads(), loadToday(), loadAnalytics()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load inbound leads.");
    } finally {
      setLoading(false);
    }
  }, [loadLeads, loadToday, loadAnalytics]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function patchLead(id: string, body: Record<string, unknown>) {
    setError("");
    try {
      await apiJson("/api/inbound-leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      await Promise.all([loadLeads(), loadToday()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    }
  }

  async function createLead(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    try {
      await apiJson("/api/inbound-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          phone: form.phone,
          interest: form.interest,
          note: form.note,
          followUpDate: form.followUpDate || null,
        }),
      });
      setForm({ name: "", phone: "", interest: "", note: "", followUpDate: "" });
      await Promise.all([loadLeads(), loadToday()]);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save lead.");
    }
  }

  function downloadCsv() {
    window.open("/api/inbound-leads?format=csv", "_blank");
  }

  function leadCard(lead: LeadRow) {
    const next = NEXT_STAGE[lead.stage] ?? null;
    return (
      <div key={lead.id} className="rounded-lg border border-rbai-border p-3 bg-rbai-bg">
        <p className="text-sm font-medium text-rbai-text">
          {lead.name || "(No name)"}
        </p>
        {lead.phone ? (
          <p className="text-xs text-rbai-text-light mt-0.5">{lead.phone}</p>
        ) : null}
        {lead.interest ? (
          <p className="text-sm text-rbai-text mt-1">{lead.interest}</p>
        ) : null}
        {lead.followUpDate ? (
          <p className="text-xs text-rbai-text-light mt-1">
            Follow up: {lead.followUpDate}
          </p>
        ) : null}
        {lead.assignedToName ? (
          <p className="text-xs text-rbai-text-light">
            Assigned to: {lead.assignedToName}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {next ? (
            <button
              type="button"
              className={ghostBtn}
              onClick={() => void patchLead(lead.id, { stage: next })}
            >
              Move to {INBOUND_LEAD_STAGE_LABELS[next]}
            </button>
          ) : null}
          {lead.stage !== "won" && lead.stage !== "lost" ? (
            <>
              <button
                type="button"
                className={ghostBtn}
                onClick={() => void patchLead(lead.id, { stage: "won" })}
              >
                Mark Won
              </button>
              <button
                type="button"
                className={ghostBtn}
                onClick={() => void patchLead(lead.id, { stage: "lost" })}
              >
                Mark Lost
              </button>
            </>
          ) : null}
        </div>
        <select
          aria-label={`Assign ${lead.name || "lead"}`}
          className={cn(inputClass, "mt-2")}
          value={lead.assignedToId ?? ""}
          onChange={(e) =>
            void patchLead(lead.id, {
              assignedToId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const analyticsNumbers = analytics
    ? ([
        ["Messages handled", analytics.messagesHandled],
        ["AI replies", analytics.repliesByAi],
        ["Team replies", analytics.repliesByTeam],
        ["Customers", analytics.customers],
        ["Finished alone by AI", analytics.conversationsFinishedAloneByAi],
        ["Needed a human", analytics.conversationsNeedingHuman],
      ] as const)
    : [];

  return (
    <div className="space-y-6">
      <Header
        title="Inbound Leads"
        description="Customers of this business who showed buying or booking interest — not the outbound Lead Engine."
      />
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div className={cardClass}>
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <h2 className="text-sm font-semibold text-rbai-text">
            Business analytics
          </h2>
          <select
            aria-label="Analytics window"
            className="px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg text-rbai-text"
            value={windowDays}
            onChange={(e) => setWindowDays(e.target.value)}
          >
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-3">
          {analyticsNumbers.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-rbai-border p-3">
              <p className="text-2xl font-semibold text-rbai-text">
                {typeof value === "number" ? value : "—"}
              </p>
              <p className="text-xs text-rbai-text-light mt-0.5">{label}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-rbai-text-light mt-3">
          Counts are this business&apos;s own records only. Handoff reasons
          always cover the last 30 days; busiest times are in UTC.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["pipeline", "Pipeline"],
            ["list", "List"],
            ["today", "Today"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            className={cn(
              ghostBtn,
              view === v && "border-rbai-primary text-rbai-primary font-medium",
            )}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
        <button type="button" className={ghostBtn} onClick={downloadCsv}>
          Download CSV
        </button>
        <button type="button" className={ghostBtn} onClick={() => void loadAll()}>
          Refresh
        </button>
      </div>

      {view === "list" ? (
        <div className={cardClass}>
          <div className="flex flex-wrap gap-2 mb-4">
            <input
              className={inputClass}
              placeholder="Search name, phone or interest…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: 320 }}
            />
            <select
              aria-label="Filter by stage"
              className="px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg text-rbai-text"
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value)}
            >
              <option value="all">All stages</option>
              {INBOUND_LEAD_STAGES.map((s) => (
                <option key={s} value={s}>
                  {INBOUND_LEAD_STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {leads.map((l) => leadCard(l))}
          </div>
          {!loading && leads.length === 0 ? (
            <p className="text-sm text-rbai-text-light">No leads match.</p>
          ) : null}
        </div>
      ) : null}

      {view === "pipeline" ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {INBOUND_LEAD_STAGES.map((stage) => (
            <div key={stage} className={cardClass}>
              <h3 className="text-sm font-semibold text-rbai-text mb-3">
                {INBOUND_LEAD_STAGE_LABELS[stage]}
              </h3>
              <div className="space-y-3">
                {leads
                  .filter((l) => l.stage === stage)
                  .map((l) => leadCard(l))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {view === "today" ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-rbai-text mb-3">
              Call today
            </h3>
            <div className="space-y-3">{today.map((l) => leadCard(l))}</div>
            {today.length === 0 ? (
              <p className="text-sm text-rbai-text-light">
                Nobody is due for a follow-up today.
              </p>
            ) : null}
          </div>
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-rbai-text mb-3">
              Overdue
            </h3>
            <div className="space-y-3">{overdue.map((l) => leadCard(l))}</div>
            {overdue.length === 0 ? (
              <p className="text-sm text-rbai-text-light">
                No overdue follow-ups.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <form className={cardClass} onSubmit={createLead}>
        <h2 className="text-sm font-semibold text-rbai-text mb-3">
          Add a lead manually
        </h2>
        {formError ? (
          <p className="text-sm text-red-700 mb-2">{formError}</p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="lead-name">Name</label>
            <input
              id="lead-name"
              className={inputClass}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="lead-phone">Phone</label>
            <input
              id="lead-phone"
              className={inputClass}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="lead-interest">
              What they want
            </label>
            <input
              id="lead-interest"
              className={inputClass}
              value={form.interest}
              onChange={(e) => setForm({ ...form, interest: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="lead-note">Note</label>
            <textarea
              id="lead-note"
              className={inputClass}
              rows={2}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="lead-followup">
              Follow-up date
            </label>
            <input
              id="lead-followup"
              type="date"
              className={inputClass}
              value={form.followUpDate}
              onChange={(e) =>
                setForm({ ...form, followUpDate: e.target.value })
              }
            />
          </div>
        </div>
        <button type="submit" className={cn(primaryBtn, "mt-4")}>
          Save lead
        </button>
        <p className="text-xs text-rbai-text-light mt-2">
          If an open lead already exists for this customer, the details are
          added to it instead of creating a duplicate.
        </p>
      </form>
    </div>
  );
}
