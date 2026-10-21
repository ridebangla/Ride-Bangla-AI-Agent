"use client";

/**
 * WebsitesManager — Settings > Websites (owner directive 2026-10-21).
 *
 * A business adds ALL its websites here: the agent fetches and learns
 * from each one. The add pattern is exactly the owner's: ONE input row;
 * once a site is in the list, a (+) plus control reveals the row again
 * for the next one — never a grid of empty fields. Each site shows its
 * honest learning status (pages fetched / entries learned, or the real
 * reason a fetch failed).
 *
 * Below the list sits the no-website path: an application for website
 * creation, fulfilled by the Ride Bangla IT Team as a separate service
 * (unrelated to the subscription), with the business's own request
 * statuses shown back to them here.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Globe,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  CheckCircle,
  AlertCircle,
  Clock,
  ExternalLink,
  Hammer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

interface WebsiteItem {
  id: string;
  url: string;
  host: string;
  status: "pending" | "indexed" | "failed";
  statusReason: string | null;
  pageCount: number | null;
  entryCount: number | null;
  addedAt: string;
  lastIndexedAt: string | null;
}

interface WebsiteRequest {
  id: string;
  businessName: string;
  contactName: string;
  contactPhone: string;
  siteType: string;
  notes: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const inputClass =
  "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow";

const SITE_TYPES = [
  { id: "business", label: "Business / company website" },
  { id: "ecommerce", label: "Online shop (e-commerce)" },
  { id: "portfolio", label: "Portfolio / personal" },
  { id: "restaurant", label: "Restaurant / food" },
  { id: "other", label: "Something else" },
];

function WebsiteStatusChip({ site }: { site: WebsiteItem }) {
  if (site.status === "indexed") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border bg-emerald-100 text-emerald-800 border-emerald-200">
        <CheckCircle className="h-3.5 w-3.5" />
        Learned · {site.pageCount ?? 0} pages · {site.entryCount ?? 0} entries
      </span>
    );
  }
  if (site.status === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border bg-red-100 text-red-800 border-red-200">
        <AlertCircle className="h-3.5 w-3.5" />
        Couldn&apos;t fetch — {site.statusReason || "please re-check"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border bg-amber-100 text-amber-800 border-amber-200">
      <Clock className="h-3.5 w-3.5" />
      Not learned yet — press Re-check
    </span>
  );
}

function RequestStatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    new: {
      label: "Received — our IT team will contact you",
      cls: "bg-amber-100 text-amber-800 border-amber-200",
    },
    contacted: {
      label: "Our team is in touch with you",
      cls: "bg-blue-100 text-blue-800 border-blue-200",
    },
    in_progress: {
      label: "Your website is being built",
      cls: "bg-blue-100 text-blue-800 border-blue-200",
    },
    delivered: {
      label: "Website delivered",
      cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
    },
    closed: {
      label: "Closed",
      cls: "bg-slate-100 text-slate-600 border-slate-200",
    },
  };
  const s = map[status] || map.new;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border",
        s.cls
      )}
    >
      {status === "delivered" ? (
        <CheckCircle className="h-3.5 w-3.5" />
      ) : (
        <Clock className="h-3.5 w-3.5" />
      )}
      {s.label}
    </span>
  );
}

export default function WebsitesManager() {
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<WebsiteItem[]>([]);
  const [requests, setRequests] = useState<WebsiteRequest[]>([]);

  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    businessName: "",
    contactName: "",
    contactPhone: "",
    siteType: "business",
    notes: "",
  });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [formDone, setFormDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wRes, rRes] = await Promise.all([
        fetch("/api/business/websites"),
        fetch("/api/business/website-requests"),
      ]);
      if (wRes.ok) {
        const j = await wRes.json();
        setSites(j.websites || []);
      }
      if (rRes.ok) {
        const j = await rRes.json();
        setRequests(j.requests || []);
      }
    } catch {
      // Keep whatever we have; the sections render their empty states.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addWebsite() {
    if (!newUrl.trim() || addBusy) return;
    setAddBusy(true);
    setAddError("");
    try {
      const res = await fetch("/api/business/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddError(j.error || "Couldn't add that website.");
        return;
      }
      setSites((prev) => [...prev, j.website]);
      setNewUrl("");
      setAdding(false);
    } catch {
      setAddError("Couldn't add that website. Please try again.");
    } finally {
      setAddBusy(false);
    }
  }

  async function reindex(site: WebsiteItem) {
    if (rowBusy) return;
    setRowBusy(site.id);
    setRowError("");
    try {
      const res = await fetch("/api/business/websites", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: site.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError(j.error || "Couldn't re-check that website.");
        return;
      }
      setSites((prev) => prev.map((s) => (s.id === site.id ? j.website : s)));
    } catch {
      setRowError("Couldn't re-check that website. Please try again.");
    } finally {
      setRowBusy(null);
    }
  }

  async function remove(site: WebsiteItem) {
    if (rowBusy) return;
    setRowBusy(site.id);
    setRowError("");
    try {
      const res = await fetch(
        `/api/business/websites?id=${encodeURIComponent(site.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setRowError(j.error || "Couldn't remove that website.");
        return;
      }
      setSites((prev) => prev.filter((s) => s.id !== site.id));
    } catch {
      setRowError("Couldn't remove that website. Please try again.");
    } finally {
      setRowBusy(null);
    }
  }

  async function submitRequest() {
    if (formBusy) return;
    setFormBusy(true);
    setFormError("");
    try {
      const res = await fetch("/api/business/website-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(j.error || "Couldn't submit your application.");
        return;
      }
      setRequests((prev) => [j.request, ...prev]);
      setFormDone(true);
      setShowForm(false);
    } catch {
      setFormError("Couldn't submit your application. Please try again.");
    } finally {
      setFormBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-rbai-text-light py-8">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your websites…
      </div>
    );
  }

  const showInput = adding || sites.length === 0;

  return (
    <div className="space-y-8">
      {/* ------------------------- Website list ------------------------- */}
      <div>
        <h3 className="text-lg font-semibold text-rbai-text flex items-center gap-2">
          <Globe className="h-5 w-5" /> Your websites
        </h3>
        <p className="text-sm text-rbai-text-light mt-1">
          {t("websites.intro")}
        </p>

        <div className="mt-4 space-y-3">
          {sites.map((site) => (
            <div
              key={site.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-rbai-border bg-rbai-bg px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <a
                  href={site.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-rbai-primary hover:underline"
                >
                  {site.host}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <div className="text-xs text-rbai-text-light truncate">
                  {site.url}
                </div>
              </div>
              <WebsiteStatusChip site={site} />
              <button
                type="button"
                onClick={() => reindex(site)}
                disabled={rowBusy === site.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rbai-border px-3 py-2 text-xs font-semibold text-rbai-text hover:bg-rbai-surface disabled:opacity-50"
              >
                {rowBusy === site.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Re-check
              </button>
              <button
                type="button"
                onClick={() => remove(site)}
                disabled={rowBusy === site.id}
                aria-label={`Remove ${site.host}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rbai-border px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            </div>
          ))}

          {rowError && (
            <div className="flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4" /> {rowError}
            </div>
          )}

          {showInput ? (
            <div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  className={inputClass}
                  placeholder="yourwebsite.com"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addWebsite();
                  }}
                  inputMode="url"
                  disabled={addBusy}
                />
                <button
                  type="button"
                  onClick={addWebsite}
                  disabled={addBusy || !newUrl.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-rbai-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
                >
                  {addBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {addBusy ? "Adding & learning…" : "Add website"}
                </button>
                {sites.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      setAddError("");
                    }}
                    disabled={addBusy}
                    className="rounded-lg border border-rbai-border px-4 py-2.5 text-sm font-semibold text-rbai-text hover:bg-rbai-surface disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {addError && (
                <div className="mt-2 flex items-center gap-2 text-sm text-red-700">
                  <AlertCircle className="h-4 w-4" /> {addError}
                </div>
              )}
              <p className="mt-2 text-xs text-rbai-text-light">
                We fetch the site&apos;s public pages right away so your
                agent can learn from them.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-dashed border-rbai-border px-4 py-2.5 text-sm font-semibold text-rbai-primary hover:bg-rbai-surface"
            >
              <Plus className="h-4 w-4" /> Add another website
            </button>
          )}
        </div>
      </div>

      {/* --------------------- Website creation --------------------- */}
      <div className="rounded-lg border border-rbai-border bg-rbai-bg p-5">
        <h3 className="text-lg font-semibold text-rbai-text flex items-center gap-2">
          <Hammer className="h-5 w-5" /> No website yet?
        </h3>
        <p className="text-sm text-rbai-text-light mt-1">
          {t("websites.no_website_note")}
        </p>

        {requests.length > 0 && (
          <div className="mt-4 space-y-2">
            {requests.map((req) => (
              <div
                key={req.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-rbai-border px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-rbai-text">
                    {req.businessName} —{" "}
                    {SITE_TYPES.find((t) => t.id === req.siteType)?.label ||
                      req.siteType}
                  </div>
                  <div className="text-xs text-rbai-text-light">
                    Applied {new Date(req.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <RequestStatusChip status={req.status} />
              </div>
            ))}
          </div>
        )}

        {formDone && (
          <div className="mt-4 flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle className="h-4 w-4" />
            Application received — our IT team will contact you on the
            number you gave.
          </div>
        )}

        {!showForm ? (
          <button
            type="button"
            onClick={() => {
              setShowForm(true);
              setFormDone(false);
            }}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-rbai-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            <Hammer className="h-4 w-4" /> Apply for website creation
          </button>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold text-rbai-text">
                Business name
              </span>
              <input
                className={cn(inputClass, "mt-1")}
                value={form.businessName}
                onChange={(e) =>
                  setForm({ ...form, businessName: e.target.value })
                }
                placeholder="Your business name"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-rbai-text">
                Contact person
              </span>
              <input
                className={cn(inputClass, "mt-1")}
                value={form.contactName}
                onChange={(e) =>
                  setForm({ ...form, contactName: e.target.value })
                }
                placeholder="Who should we talk to?"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-rbai-text">
                Phone / WhatsApp
              </span>
              <input
                className={cn(inputClass, "mt-1")}
                value={form.contactPhone}
                onChange={(e) =>
                  setForm({ ...form, contactPhone: e.target.value })
                }
                placeholder="+8801XXXXXXXXX"
                inputMode="tel"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-rbai-text">
                What kind of website?
              </span>
              <select
                className={cn(inputClass, "mt-1")}
                value={form.siteType}
                onChange={(e) =>
                  setForm({ ...form, siteType: e.target.value })
                }
              >
                {SITE_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-semibold text-rbai-text">
                Anything we should know? (optional)
              </span>
              <textarea
                className={cn(inputClass, "mt-1")}
                rows={3}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Pages you need, colours you like, examples…"
              />
            </label>
            {formError && (
              <div className="sm:col-span-2 flex items-center gap-2 text-sm text-red-700">
                <AlertCircle className="h-4 w-4" /> {formError}
              </div>
            )}
            <div className="sm:col-span-2 flex gap-2">
              <button
                type="button"
                onClick={submitRequest}
                disabled={
                  formBusy ||
                  form.businessName.trim().length < 2 ||
                  form.contactName.trim().length < 2 ||
                  form.contactPhone.trim().length < 6
                }
                className="inline-flex items-center gap-2 rounded-lg bg-rbai-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {formBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Hammer className="h-4 w-4" />
                )}
                Submit application
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                disabled={formBusy}
                className="rounded-lg border border-rbai-border px-4 py-2.5 text-sm font-semibold text-rbai-text hover:bg-rbai-surface disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
