"use client";

import { Header } from "@/components/layout/header";
import {
  Target,
  Settings2,
  Radar,
  Users,
  MailOpen,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Plus,
  AlertTriangle,
  Plug,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

const cardClass = "bg-rbai-surface rounded-xl border border-rbai-border p-4";
const inputClass =
  "w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary text-rbai-text";
const labelClass = "block text-xs font-medium text-rbai-text-light mb-1";
const primaryBtn =
  "flex items-center gap-2 px-4 py-2 bg-rbai-primary text-white rounded-lg hover:bg-rbai-primary-dark transition-colors text-sm font-medium disabled:opacity-50";
const ghostBtn =
  "flex items-center gap-2 px-3 py-2 border border-rbai-border rounded-lg text-sm text-rbai-text hover:border-rbai-primary hover:text-rbai-primary transition-colors disabled:opacity-50";

interface LeadSettingsData {
  icp: { industries: string[]; companySize: string; titles: string[]; geography: string[] };
  mailboxProvider: string;
  mailboxConnected: boolean;
  mailboxUser: string;
  hasMailboxSecret: boolean;
  aiBackend: string;
  aiBackendConnected: boolean;
  maxDailySends: number;
}

interface ScanData {
  id: string;
  name: string;
  status: string;
  requestedAt: string | null;
  completedAt: string | null;
  stats: { discovered?: number; profiled?: number; scored?: number };
  error: string;
}

interface LeadData {
  id: string;
  name: string;
  domain: string;
  website: string;
  industry: string;
  companySize: string;
  location: string;
  contactName: string;
  contactTitle: string;
  contactEmail: string;
  contactEmailStatus: string;
  icpScore: number;
  status: string;
  personalizationNotes: string;
}

interface DraftData {
  id: string;
  leadId: string;
  step: number;
  toEmail: string;
  subject: string;
  body: string;
  status: string;
  gateCheck: { ok?: boolean; reasons?: string[] };
  approvedBy: string;
  sentAt: string | null;
}

function SectionTitle({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-3">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-rbai-primary/10 text-rbai-primary">{icon}</div>
        <div>
          <h2 className="font-semibold text-rbai-text">{title}</h2>
          <p className="text-xs text-rbai-text-light mt-0.5">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export default function LeadEnginePage() {
  const [settings, setSettings] = useState<LeadSettingsData | null>(null);
  const [scans, setScans] = useState<ScanData[]>([]);
  const [leads, setLeads] = useState<LeadData[]>([]);
  const [drafts, setDrafts] = useState<DraftData[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ICP form
  const [industries, setIndustries] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [titles, setTitles] = useState("");
  const [geography, setGeography] = useState("");
  // Credentials form
  const [mailboxProvider, setMailboxProvider] = useState("none");
  const [mailboxUser, setMailboxUser] = useState("");
  const [mailboxSecret, setMailboxSecret] = useState("");
  const [aiBackend, setAiBackend] = useState("none");
  // Scan form
  const [scanName, setScanName] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [minScore, setMinScore] = useState(0);
  const [reviewDraft, setReviewDraft] = useState<DraftData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, scRes, lRes, dRes] = await Promise.all([
        fetch("/api/lead-settings"),
        fetch("/api/lead-scans?limit=20"),
        fetch(`/api/leads?limit=50&status=${statusFilter}&minScore=${minScore}`),
        fetch("/api/lead-drafts?limit=50"),
      ]);
      if (!sRes.ok) throw new Error("Could not load Lead Engine settings.");
      const s = await sRes.json();
      setSettings(s);
      setIndustries((s.icp?.industries ?? []).join(", "));
      setCompanySize(s.icp?.companySize ?? "");
      setTitles((s.icp?.titles ?? []).join(", "));
      setGeography((s.icp?.geography ?? []).join(", "));
      setMailboxProvider(s.mailboxProvider ?? "none");
      setMailboxUser(s.mailboxUser ?? "");
      setAiBackend(s.aiBackend ?? "none");
      const sc = await scRes.json();
      setScans(sc.items ?? sc.data ?? []);
      const l = await lRes.json();
      setLeads(l.items ?? l.data ?? []);
      const d = await dRes.json();
      setDrafts(d.items ?? d.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, minScore]);

  useEffect(() => {
    load();
  }, [load]);

  const configured =
    !!settings && settings.mailboxConnected && settings.aiBackendConnected;

  async function saveIcp() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/lead-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          icp: {
            industries: splitList(industries),
            companySize,
            titles: splitList(titles),
            geography: splitList(geography),
          },
        }),
      });
      if (!res.ok) throw new Error("Could not save ICP.");
      setNotice("Ideal customer profile saved.");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function connectServices() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/lead-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailboxProvider,
          mailboxUser,
          ...(mailboxSecret ? { mailboxSecret } : {}),
          aiBackend,
          aiBackendConnected: aiBackend !== "none",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save connections.");
      setMailboxSecret("");
      setNotice(
        data.mailboxConnected && data.aiBackendConnected
          ? "Lead Engine connected and ready."
          : "Connections saved. Connect both a mailbox and an AI backend to activate."
      );
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestScan() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/lead-scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: scanName }),
      });
      if (!res.ok) throw new Error("Could not request scan.");
      setScanName("");
      setNotice(
        "Scan requested. The Lead Engine service picks it up and writes discovered businesses here."
      );
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewAction(id: string, action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/lead-drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        const reasons = data.reasons ? `: ${data.reasons.join("; ")}` : "";
        throw new Error((data.error || "Review failed") + reasons);
      }
      setReviewDraft(null);
      setNotice(
        action === "approve"
          ? "Draft approved. It will be sent by the Lead Engine service after a final gate check."
          : "Draft rejected."
      );
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  }

  async function setLeadStatus(id: string, status: string) {
    try {
      await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      load();
    } catch {
      /* triage is best-effort */
    }
  }

  if (loading) {
    return (
      <>
        <Header title="Lead Engine" subtitle="Outbound prospecting, powered by Harvey" />
        <div className="p-6 text-sm text-rbai-text-light">Loading Lead Engine…</div>
      </>
    );
  }

  return (
    <>
      <Header title="Lead Engine" subtitle="Outbound prospecting, powered by Harvey" />
      <div className="p-6 space-y-6 overflow-y-auto">
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {notice}
          </div>
        )}

        {/* Credential gate */}
        {!configured && (
          <div className={cardClass}>
            <SectionTitle
              icon={<Plug size={18} />}
              title="Connect the Lead Engine"
              description="The engine runs on your mailbox and your AI subscription. Until both are connected, nothing is discovered and nothing is sent — no fake leads, ever."
            />
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Mailbox provider</label>
                <select
                  className={inputClass}
                  value={mailboxProvider}
                  onChange={(e) => setMailboxProvider(e.target.value)}
                >
                  <option value="none">Not connected</option>
                  <option value="gmail">Gmail / Google Workspace</option>
                  <option value="microsoft">Microsoft 365</option>
                  <option value="smtp">Generic SMTP</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>AI backend</label>
                <select
                  className={inputClass}
                  value={aiBackend}
                  onChange={(e) => setAiBackend(e.target.value)}
                >
                  <option value="none">Not connected</option>
                  <option value="claude">Claude subscription (Claude Code)</option>
                  <option value="codex">ChatGPT subscription (Codex)</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Mailbox username / email</label>
                <input
                  className={inputClass}
                  value={mailboxUser}
                  onChange={(e) => setMailboxUser(e.target.value)}
                  placeholder="you@yourcompany.com"
                />
              </div>
              <div>
                <label className={labelClass}>
                  Mailbox password / app password{" "}
                  {settings?.hasMailboxSecret ? "(already set — leave blank to keep)" : ""}
                </label>
                <input
                  className={inputClass}
                  type="password"
                  value={mailboxSecret}
                  onChange={(e) => setMailboxSecret(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="mt-4">
              <button className={primaryBtn} disabled={busy} onClick={connectServices}>
                <Plug size={16} /> Save connections
              </button>
            </div>
            <p className="text-xs text-rbai-text-light mt-3 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              Use a dedicated sending mailbox on a secondary domain and warm it up
              before any outreach. Cold-email deliverability and local law compliance
              are your responsibility.
            </p>
          </div>
        )}

        {/* ICP */}
        <div className={cardClass}>
          <SectionTitle
            icon={<Settings2 size={18} />}
            title="Ideal customer profile"
            description="You confirm what the engine looks for. Discovery only targets these."
            action={
              <button className={ghostBtn} disabled={busy} onClick={saveIcp}>
                Save ICP
              </button>
            }
          />
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Industries (comma separated)</label>
              <input className={inputClass} value={industries} onChange={(e) => setIndustries(e.target.value)} placeholder="Restaurants, Dental clinics" />
            </div>
            <div>
              <label className={labelClass}>Company size</label>
              <input className={inputClass} value={companySize} onChange={(e) => setCompanySize(e.target.value)} placeholder="5-50 employees" />
            </div>
            <div>
              <label className={labelClass}>Titles (comma separated)</label>
              <input className={inputClass} value={titles} onChange={(e) => setTitles(e.target.value)} placeholder="Owner, Marketing Manager" />
            </div>
            <div>
              <label className={labelClass}>Geography (comma separated)</label>
              <input className={inputClass} value={geography} onChange={(e) => setGeography(e.target.value)} placeholder="Dhaka, Bangladesh" />
            </div>
          </div>
        </div>

        {/* Scans */}
        <div className={cardClass}>
          <SectionTitle
            icon={<Radar size={18} />}
            title="Discovery scans"
            description="Request a scan. The Lead Engine service discovers businesses, profiles their sites and scores them against your ICP."
          />
          <div className="flex gap-2 mb-4">
            <input
              className={inputClass}
              value={scanName}
              onChange={(e) => setScanName(e.target.value)}
              placeholder="Scan name (optional)"
            />
            <button className={primaryBtn} disabled={busy || !configured} onClick={requestScan}>
              <Plus size={16} /> Request scan
            </button>
          </div>
          {!configured && (
            <p className="text-xs text-rbai-text-light mb-3">
              Connect the Lead Engine above before requesting scans.
            </p>
          )}
          {scans.length === 0 ? (
            <p className="text-sm text-rbai-text-light">No scans yet.</p>
          ) : (
            <div className="space-y-2">
              {scans.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-lg border border-rbai-border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-rbai-text">{s.name}</p>
                    <p className="text-xs text-rbai-text-light">
                      {s.stats?.discovered ?? 0} discovered · {s.stats?.scored ?? 0} scored
                      {s.error ? ` · Error: ${s.error}` : ""}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium px-2 py-1 rounded-full",
                      s.status === "completed" && "bg-emerald-100 text-emerald-700",
                      s.status === "failed" && "bg-red-100 text-red-700",
                      (s.status === "requested" || s.status === "running") &&
                        "bg-amber-100 text-amber-700",
                      s.status === "draft" && "bg-slate-100 text-slate-600"
                    )}
                  >
                    {s.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Leads */}
        <div className={cardClass}>
          <SectionTitle
            icon={<Users size={18} />}
            title="Leads"
            description="Businesses discovered and scored against your ICP (0–100)."
            action={
              <div className="flex gap-2">
                <select className={inputClass} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 130 }}>
                  <option value="all">All statuses</option>
                  <option value="new">New</option>
                  <option value="contacted">Contacted</option>
                  <option value="replied">Replied</option>
                  <option value="meeting">Meeting</option>
                  <option value="closed">Closed</option>
                  <option value="lost">Lost</option>
                </select>
                <select className={inputClass} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} style={{ width: 120 }}>
                  <option value={0}>Any score</option>
                  <option value={50}>50+</option>
                  <option value={70}>70+</option>
                  <option value={85}>85+</option>
                </select>
                <button className={ghostBtn} onClick={() => load()} title="Refresh">
                  <RefreshCw size={16} />
                </button>
              </div>
            }
          />
          {leads.length === 0 ? (
            <p className="text-sm text-rbai-text-light">
              No leads yet. Request a discovery scan above — the engine writes results here.
            </p>
          ) : (
            <div className="space-y-2">
              {leads.map((l) => (
                <div key={l.id} className="rounded-lg border border-rbai-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-rbai-text">
                        {l.name}{" "}
                        <span className="text-xs font-normal text-rbai-text-light">
                          {l.industry} · {l.location}
                        </span>
                      </p>
                      <p className="text-xs text-rbai-text-light">
                        {l.contactName} · {l.contactTitle} · {l.contactEmail || "no email"}{" "}
                        {l.contactEmailStatus === "verified" ? "(verified)" : `(${l.contactEmailStatus})`}
                      </p>
                      {l.personalizationNotes && (
                        <p className="text-xs text-rbai-text-light mt-1 italic">{l.personalizationNotes}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-lg font-bold text-rbai-primary">{l.icpScore}</span>
                      <select
                        className={inputClass}
                        style={{ width: 120 }}
                        value={l.status}
                        onChange={(e) => setLeadStatus(l.id, e.target.value)}
                      >
                        <option value="new">New</option>
                        <option value="contacted">Contacted</option>
                        <option value="replied">Replied</option>
                        <option value="meeting">Meeting</option>
                        <option value="closed">Closed</option>
                        <option value="lost">Lost</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Outbox — the human gate */}
        <div className={cardClass}>
          <SectionTitle
            icon={<MailOpen size={18} />}
            title="Outbox — your approval desk"
            description="Nothing sends without you. Review each draft one by one; approving arms it for the engine, which re-checks the safety gate at send time."
          />
          {drafts.length === 0 ? (
            <p className="text-sm text-rbai-text-light">
              No drafts yet. Drafts appear here after the engine writes email sequences for scored leads.
            </p>
          ) : (
            <div className="space-y-2">
              {drafts.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border border-rbai-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-rbai-text truncate">{d.subject || "(no subject)"}</p>
                    <p className="text-xs text-rbai-text-light">
                      To {d.toEmail} · step {d.step}
                      {d.gateCheck && d.gateCheck.ok === false && " · gate failed"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={cn(
                        "text-xs font-medium px-2 py-1 rounded-full",
                        d.status === "approved" && "bg-emerald-100 text-emerald-700",
                        d.status === "sent" && "bg-blue-100 text-blue-700",
                        d.status === "rejected" && "bg-slate-100 text-slate-600",
                        d.status === "failed" && "bg-red-100 text-red-700",
                        d.status === "draft" && "bg-amber-100 text-amber-700"
                      )}
                    >
                      {d.status}
                    </span>
                    {d.status === "draft" && (
                      <button className={ghostBtn} onClick={() => setReviewDraft(d)}>
                        Review
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Review modal */}
        {reviewDraft && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-rbai-surface rounded-xl border border-rbai-border max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5">
              <h3 className="font-semibold text-rbai-text mb-1">Review draft</h3>
              <p className="text-xs text-rbai-text-light mb-3">
                To {reviewDraft.toEmail} · step {reviewDraft.step}
              </p>
              <p className="text-sm font-medium text-rbai-text mb-2">{reviewDraft.subject}</p>
              <pre className="whitespace-pre-wrap text-sm text-rbai-text bg-rbai-bg rounded-lg p-3 border border-rbai-border mb-3">
                {reviewDraft.body}
              </pre>
              {reviewDraft.gateCheck && reviewDraft.gateCheck.ok === false && (
                <p className="text-xs text-red-600 mb-3">
                  Gate check failed: {(reviewDraft.gateCheck.reasons ?? []).join("; ")}
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <button className={ghostBtn} disabled={busy} onClick={() => setReviewDraft(null)}>
                  <XCircle size={16} /> Close
                </button>
                <button
                  className="flex items-center gap-2 px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors text-sm font-medium disabled:opacity-50"
                  disabled={busy}
                  onClick={() => reviewAction(reviewDraft.id, "reject")}
                >
                  <XCircle size={16} /> Reject
                </button>
                <button
                  className={primaryBtn}
                  disabled={busy}
                  onClick={() => reviewAction(reviewDraft.id, "approve")}
                >
                  <CheckCircle2 size={16} /> Approve & arm
                </button>
              </div>
              <p className="text-xs text-rbai-text-light mt-3 flex items-start gap-1.5">
                <Clock size={14} className="mt-0.5 shrink-0" />
                Approving arms the draft for sending by the Lead Engine service, which
                runs the deterministic safety gate again at send time. You can reject
                any draft — rejected drafts are never sent.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
