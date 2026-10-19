"use client";

/**
 * Dashboard > Landing Page (Phase 2).
 * Edit the business's auto-generated hosted page: tagline, brand color,
 * logo, website URL (decision 11 hint), publish/unpublish — with a live
 * preview that updates as you type.
 */

import { Header } from "@/components/layout/header";
import { cn } from "@/lib/utils";
import {
  Save,
  Eye,
  Globe,
  CheckCircle,
  AlertCircle,
  Loader2,
  Copy,
  ExternalLink,
  Palette,
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

interface PreviewProduct {
  name: string;
  description?: string | null;
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  categoryName?: string | null;
}

interface PreviewData {
  business: {
    name: string;
    slug: string;
    tagline: string;
    brandColor: string;
    logoUrl: string;
    websiteUrl: string;
    landingPublished: boolean;
  };
  preview: {
    copy: { tagline: string; heroSubtext: string; aboutText: string };
    products: PreviewProduct[];
  } | null;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const f = (v: number) => (amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  const r = clamp(f((n >> 16) & 255));
  const g = clamp(f((n >> 8) & 255));
  const b = clamp(f(n & 255));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase()}`;
}

/** Scaled-down live preview of the public page, driven by the form state. */
function LivePreview({
  name,
  tagline,
  brandColor,
  logoUrl,
  products,
  heroSubtext,
  aboutText,
}: {
  name: string;
  tagline: string;
  brandColor: string;
  logoUrl: string;
  products: PreviewProduct[];
  heroSubtext: string;
  aboutText: string;
}) {
  const brand = /^#[0-9A-Fa-f]{6}$/.test(brandColor) ? brandColor : "#0B7A55";
  const dark = shade(brand, -0.25);
  const light = shade(brand, 0.88);
  const initial = (name.trim()[0] || "?").toUpperCase();
  return (
    <div className="rounded-xl border border-rbai-border overflow-hidden bg-white text-left">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="w-8 h-8 rounded-lg object-cover" />
          ) : (
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-extrabold text-sm"
              style={{ background: light, color: dark }}
            >
              {initial}
            </div>
          )}
          <span className="font-bold text-sm text-gray-900">{name}</span>
        </div>
        <span
          className="text-xs font-bold text-white px-3 py-1.5 rounded-full"
          style={{ background: brand }}
        >
          Chat with us
        </span>
      </div>
      <div
        className="px-4 py-8 text-center text-white"
        style={{ background: `linear-gradient(135deg, ${dark}, ${brand})` }}
      >
        <div className="text-xl font-extrabold mb-1.5">{name}</div>
        <div className="text-sm opacity-95 mb-1">{tagline || "Your tagline appears here"}</div>
        <div className="text-xs opacity-80 mb-4">{heroSubtext}</div>
        <span className="inline-block bg-white text-xs font-bold px-5 py-2 rounded-full" style={{ color: dark }}>
          Chat with us
        </span>
      </div>
      {products.length > 0 && (
        <div className="p-4">
          <div className="font-bold text-sm text-gray-900 mb-2">Our Products & Services</div>
          <div className="grid grid-cols-2 gap-2">
            {products.slice(0, 4).map((p, i) => (
              <div key={i} className="border border-gray-100 rounded-lg overflow-hidden">
                {p.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrl} alt="" className="w-full h-16 object-cover bg-gray-50" />
                )}
                <div className="p-2">
                  <div className="text-xs font-bold text-gray-900 truncate">{p.name}</div>
                  {p.price != null && (
                    <div className="text-xs font-extrabold" style={{ color: dark }}>
                      {p.currency || "BDT"} {p.price}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {products.length > 4 && (
            <div className="text-xs text-gray-400 mt-2">+ {products.length - 4} more on the live page</div>
          )}
        </div>
      )}
      <div className="p-4 pt-0">
        <div className="rounded-lg p-3 text-xs text-gray-700 leading-relaxed" style={{ background: light }}>
          {aboutText}
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [data, setData] = useState<PreviewData | null>(null);
  const [tagline, setTagline] = useState("");
  const [brandColor, setBrandColor] = useState("#0B7A55");
  const [logoUrl, setLogoUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [published, setPublished] = useState(false);
  const [copied, setCopied] = useState(false);

  const toast = (type: "success" | "error", message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/landing");
        if (!res.ok) throw new Error("Failed to load");
        const json: PreviewData = await res.json();
        setData(json);
        setTagline(json.business.tagline);
        setBrandColor(json.business.brandColor);
        setLogoUrl(json.business.logoUrl);
        setWebsiteUrl(json.business.websiteUrl);
        setPublished(json.business.landingPublished);
      } catch {
        toast("error", "Could not load landing page settings.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async (overrides?: { landingPublished?: boolean }) => {
    setSaving(true);
    try {
      const res = await fetch("/api/landing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tagline,
          brandColor,
          logoUrl,
          websiteUrl,
          landingPublished: overrides?.landingPublished ?? published,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      if (overrides?.landingPublished !== undefined) setPublished(overrides.landingPublished);
      toast("success", "Landing page saved.");
      // Refresh preview payload (copy/products) after save.
      const r2 = await fetch("/api/landing");
      if (r2.ok) setData(await r2.json());
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const copyUrl = async () => {
    if (!data) return;
    const url = `${window.location.origin}/p/${data.business.slug}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <Header title="Landing Page" description="Your auto-generated hosted page" />
        <div className="p-6 flex items-center gap-2 text-rbai-text-light">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  const publicUrl = data ? `/p/${data.business.slug}` : "";

  return (
    <div className="flex-1 overflow-y-auto">
      <Header
        title="Landing Page"
        description="A hosted page for your business — no website needed"
        actions={
          <div className="flex items-center gap-2">
            {published && (
              <a
                href={publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg transition-colors"
              >
                <ExternalLink className="h-4 w-4" /> View live
              </a>
            )}
            <button
              onClick={() => save()}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </button>
          </div>
        }
      />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-6xl">
        {/* Editor */}
        <div className="space-y-5">
          <div className="rounded-xl border border-rbai-border bg-rbai-surface p-5 space-y-4">
            <h3 className="font-semibold text-rbai-text flex items-center gap-2">
              <Palette className="h-4 w-4 text-rbai-primary" /> Branding
            </h3>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Business name</label>
              <input value={data?.business.name ?? ""} disabled className={cn(inputClasses, "opacity-60")} />
              <p className="text-xs text-rbai-text-light">The name is set at signup and cannot be changed here.</p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Tagline</label>
              <input
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="e.g. Fresh cakes baked daily in Dhaka"
                maxLength={160}
                className={inputClasses}
              />
              <p className="text-xs text-rbai-text-light">
                Leave empty to auto-generate from your business description.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Brand color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={/^#[0-9A-Fa-f]{6}$/.test(brandColor) ? brandColor : "#0B7A55"}
                  onChange={(e) => setBrandColor(e.target.value.toUpperCase())}
                  className="h-10 w-14 rounded-lg border border-rbai-border bg-rbai-bg cursor-pointer"
                />
                <input
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value.toUpperCase())}
                  placeholder="#0B7A55"
                  maxLength={7}
                  className={cn(inputClasses, "font-mono")}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Logo URL</label>
              <input
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://…/logo.png"
                className={inputClasses}
              />
              <p className="text-xs text-rbai-text-light">
                Leave empty to use your business initial. Image upload comes later — a direct image URL works for now.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-rbai-border bg-rbai-surface p-5 space-y-4">
            <h3 className="font-semibold text-rbai-text flex items-center gap-2">
              <Globe className="h-4 w-4 text-rbai-primary" /> Website
            </h3>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Your website URL (optional)</label>
              <input
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://your-website.com"
                className={inputClasses}
              />
              {websiteUrl.trim() ? (
                <p className="text-xs text-rbai-text-light">
                  You already have a website — this landing page is optional. It still works as a
                  standalone page with your chat widget for campaigns and sharing.
                </p>
              ) : (
                <p className="text-xs text-rbai-text-light">
                  No website? This hosted page is your online presence — share its link anywhere.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-rbai-border bg-rbai-surface p-5 space-y-3">
            <h3 className="font-semibold text-rbai-text flex items-center gap-2">
              <Eye className="h-4 w-4 text-rbai-primary" /> Publishing
            </h3>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-rbai-text">
                  {published ? "Published" : "Unpublished"}
                </div>
                <p className="text-xs text-rbai-text-light">
                  {published
                    ? `Live at ${typeof window !== "undefined" ? window.location.origin : ""}${publicUrl}`
                    : "Publish to make the page visible to the public."}
                </p>
              </div>
              <button
                onClick={() => save({ landingPublished: !published })}
                disabled={saving}
                className={cn(
                  "relative inline-flex h-7 w-12 items-center rounded-full transition-colors disabled:opacity-50",
                  published ? "bg-rbai-success" : "bg-rbai-border"
                )}
                role="switch"
                aria-checked={published}
              >
                <span
                  className={cn(
                    "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                    published ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </button>
            </div>
            {published && (
              <button
                onClick={copyUrl}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg transition-colors"
              >
                <Copy className="h-4 w-4" /> {copied ? "Copied!" : "Copy public link"}
              </button>
            )}
          </div>
        </div>

        {/* Live preview */}
        <div className="space-y-3">
          <h3 className="font-semibold text-rbai-text">Live preview</h3>
          <LivePreview
            name={data?.business.name ?? ""}
            tagline={tagline || data?.preview?.copy.tagline || ""}
            brandColor={brandColor}
            logoUrl={logoUrl}
            products={data?.preview?.products ?? []}
            heroSubtext={data?.preview?.copy.heroSubtext ?? ""}
            aboutText={data?.preview?.copy.aboutText ?? ""}
          />
          <p className="text-xs text-rbai-text-light">
            Preview updates as you type. The full page (about, hours, contact, chat widget) renders at the public link.
          </p>
        </div>
      </div>
      <ToastContainer toasts={toasts} />
    </div>
  );
}
