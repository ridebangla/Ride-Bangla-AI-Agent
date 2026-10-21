"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Globe,
  Loader2,
  PencilLine,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { LANDING_THEMES, type LandingThemeId } from "@/lib/landing-themes";

interface QAPair {
  question: string;
  answer: string;
}
interface ProductDraft {
  name: string;
  price: number | null;
  currency: string;
  category?: string;
}
interface AnalyzeResult {
  businessName: string;
  qa: QAPair[];
  products: ProductDraft[];
  pagesScraped: string[];
  note: string;
}

// Two explicit paths: a business either HAS a website (we scrape it) or it
// does NOT (we build its knowledge + landing page from a guided description).
type Method = "url" | "guided";
// Inside the "no website" path the owner can still paste text or upload a
// file instead of filling the form — same analysis pipeline.
type GuidedInput = "form" | "text" | "file";

const METHODS: { id: Method; icon: React.ElementType; title: string; desc: string }[] = [
  {
    id: "url",
    icon: Globe,
    title: "আমার ওয়েবসাইট আছে / I have a website",
    desc: "ওয়েবসাইটের ঠিকানা দিন — আমরা আপনার পেজগুলো পড়ে AI-কে ব্যবসা শিখিয়ে দেব। / Enter your website URL — we fetch your pages and the AI learns your business automatically.",
  },
  {
    id: "guided",
    icon: PencilLine,
    title: "আমার ওয়েবসাইট নেই / I don't have a website",
    desc: "ব্যবসার ধরন বেছে নিয়ে সংক্ষেপে বর্ণনা দিন — AI আপনার জন্য একটি প্রিমিয়াম ল্যান্ডিং পেজ বানিয়ে দেবে; আপনি দেখে অনুমোদন দেবেন। / Choose your business category and describe it — the AI builds a premium landing page for you; you review and approve it.",
  },
];

// Common business categories (bilingual). "other" reveals a free-text input.
const CATEGORIES = [
  { value: "", label: "বেছে নিন / Choose…" },
  { value: "Restaurant & Food", label: "রেস্টুরেন্ট ও খাবার / Restaurant & Food" },
  { value: "Fashion & Clothing", label: "ফ্যাশন ও পোশাক / Fashion & Clothing" },
  { value: "Grocery & Daily Needs", label: "মুদি ও নিত্যপ্রয়োজনীয় / Grocery & Daily Needs" },
  { value: "Electronics & Gadgets", label: "ইলেকট্রনিক্স ও গ্যাজেট / Electronics & Gadgets" },
  { value: "Beauty & Cosmetics", label: "বিউটি ও কসমেটিকস / Beauty & Cosmetics" },
  { value: "Health & Pharmacy", label: "স্বাস্থ্য ও ফার্মেসি / Health & Pharmacy" },
  { value: "Education & Training", label: "শিক্ষা ও প্রশিক্ষণ / Education & Training" },
  { value: "Travel & Tourism", label: "ভ্রমণ ও পর্যটন / Travel & Tourism" },
  { value: "Real Estate", label: "রিয়েল এস্টেট / Real Estate" },
  { value: "Home Services", label: "হোম সার্ভিস / Home Services" },
  { value: "Automotive", label: "অটোমোটিভ / Automotive" },
  { value: "other", label: "অন্যান্য / Other…" },
];

const inputClass =
  "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow";

function suggestTagline(fields: { businessName: string; whatYouSell: string }): string {
  const sell = fields.whatYouSell.trim();
  const name = fields.businessName.trim();
  const base = sell || name;
  return base.slice(0, 160);
}

export default function OnboardingWizard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"method" | "input" | "review">("method");
  const [method, setMethod] = useState<Method | null>(null);
  const [guidedInput, setGuidedInput] = useState<GuidedInput>("form");

  // ALL of the business's websites (owner directive 2026-10-21): one
  // input row to start, a (+) control adds more — 10 sites = 10 rows.
  const [urls, setUrls] = useState<string[]>([""]);
  // Per-site results from the last analyze run, sent to confirm so the
  // Settings website list records these sites as indexed (truthfully —
  // these counts are what the scrape actually produced).
  const [siteStats, setSiteStats] = useState<
    Array<{ url: string; pageCount: number; qaCount: number }>
  >([]);
  const [siteWarnings, setSiteWarnings] = useState<string[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [fields, setFields] = useState({
    businessName: "",
    category: "",
    customCategory: "",
    whatYouSell: "",
    location: "",
    contact: "",
    hours: "",
    policies: "",
  });

  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [qa, setQa] = useState<QAPair[]>([]);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [saving, setSaving] = useState(false);

  // Landing-page draft (only for the "no website" path): generated from the
  // description, reviewed and approved by the owner before anything goes live.
  const [landingTagline, setLandingTagline] = useState("");
  const [landingTheme, setLandingTheme] = useState<LandingThemeId>("modern-minimal");
  const [landingPublish, setLandingPublish] = useState(false);
  const [landingUrl, setLandingUrl] = useState("");
  const [landingReady, setLandingReady] = useState(false);

  function pickMethod(m: Method) {
    setMethod(m);
    setGuidedInput("form");
    setError("");
    setStep("input");
  }

  // When the review step opens for the "no website" path, load the current
  // landing settings (to prefill + show the public URL) and suggest a tagline
  // from the description. Nothing is published until the owner approves.
  useEffect(() => {
    if (step !== "review" || method !== "guided") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/landing");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const b = data.business || {};
        if (!landingReady) {
          setLandingTagline(
            typeof b.tagline === "string" && b.tagline.trim()
              ? b.tagline
              : suggestTagline(fields)
          );
          if (typeof b.landingTheme === "string" && b.landingTheme) {
            setLandingTheme(b.landingTheme as LandingThemeId);
          }
          setLandingReady(true);
        }
        if (typeof data.publicUrl === "string") setLandingUrl(data.publicUrl);
      } catch {
        // Landing preview is a bonus — the knowledge/catalog review still works.
        if (!landingReady) {
          setLandingTagline(suggestTagline(fields));
          setLandingReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, method]);

  async function analyze(payload: Record<string, unknown>) {
    setAnalyzing(true);
    setError("");
    try {
      const res = await fetch("/api/onboarding/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Analysis failed. Please try again.");
        setAnalyzing(false);
        return;
      }
      setResult(data as AnalyzeResult);
      setQa((data.qa || []) as QAPair[]);
      setProducts(
        ((data.products || []) as ProductDraft[]).map((p) => ({
          ...p,
          category: "Products",
        }))
      );
      setStep("review");
    } catch {
      setError("Network error. Check your connection and try again.");
    }
    setAnalyzing(false);
  }

  /**
   * Multi-website analyze: run the existing single-URL analyze endpoint
   * once per entered website and merge the results for one review.
   * Q&A pairs dedupe by question, products by name (first site wins).
   * A site that fails to fetch is named in the warnings — it is never
   * silently counted as learned; if EVERY site fails, the first real
   * error is shown and we stay on the input step.
   */
  async function analyzeUrls(list: string[]) {
    setAnalyzing(true);
    setError("");
    setSiteWarnings([]);
    setSiteStats([]);
    const mergedQa: QAPair[] = [];
    const seenQ = new Set<string>();
    const mergedProducts: ProductDraft[] = [];
    const seenP = new Set<string>();
    const allPages: string[] = [];
    const stats: Array<{ url: string; pageCount: number; qaCount: number }> = [];
    const warnings: string[] = [];
    let firstError = "";
    let businessName = "";
    let note = "";

    for (const u of list) {
      try {
        const res = await fetch("/api/onboarding/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: u }),
        });
        const data = await res.json();
        if (!res.ok) {
          warnings.push(u);
          if (!firstError) firstError = data.error || "Analysis failed.";
          continue;
        }
        const r = data as AnalyzeResult;
        if (!businessName && r.businessName) businessName = r.businessName;
        if (!note && r.note) note = r.note;
        let siteQa = 0;
        for (const pair of r.qa || []) {
          const key = pair.question.trim().toLowerCase();
          if (seenQ.has(key)) continue;
          seenQ.add(key);
          mergedQa.push(pair);
          siteQa++;
        }
        for (const p of r.products || []) {
          const key = p.name.trim().toLowerCase();
          if (seenP.has(key)) continue;
          seenP.add(key);
          mergedProducts.push({ ...p, category: "Products" });
        }
        allPages.push(...(r.pagesScraped || []));
        stats.push({
          url: u,
          pageCount: (r.pagesScraped || []).length,
          qaCount: siteQa,
        });
      } catch {
        warnings.push(u);
        if (!firstError) firstError = "Network error. Check your connection and try again.";
      }
    }

    setAnalyzing(false);
    if (stats.length === 0) {
      setError(firstError || "Analysis failed. Please try again.");
      return;
    }
    setResult({
      businessName,
      qa: mergedQa,
      products: mergedProducts,
      pagesScraped: allPages,
      note:
        list.length > 1
          ? `Learned from ${stats.length} of your ${list.length} websites (${allPages.length} pages). Review everything below before saving — you can add more websites any time in Settings.`
          : note,
    });
    setQa(mergedQa);
    setProducts(mergedProducts);
    setSiteStats(stats);
    setSiteWarnings(warnings);
    setStep("review");
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 500_000) {
      setError("File is too large (max 500 KB of text).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileText(String(reader.result || ""));
      setFileName(f.name);
      setError("");
    };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsText(f);
  }

  function startAnalyze() {
    if (!method) return;
    if (method === "url") {
      const list = urls.map((u) => u.trim()).filter(Boolean);
      if (list.length === 0)
        return setError("Please enter your website URL.");
      analyzeUrls(list);
      return;
    }
    // "No website" path — form, pasted text, or uploaded file.
    if (guidedInput === "text") {
      if (pastedText.trim().length < 20)
        return setError("Please paste at least a few sentences about your business.");
      analyze({ text: pastedText, sourceName: "Pasted text" });
    } else if (guidedInput === "file") {
      if (fileText.trim().length < 20)
        return setError("Please choose a text file first.");
      analyze({ text: fileText, sourceName: fileName || "Uploaded file" });
    } else {
      const answered = [fields.businessName, fields.whatYouSell].some(
        (v) => v.trim().length >= 3
      );
      if (!answered)
        return setError("Please tell us at least your business name and what you sell.");
      const resolvedCategory =
        fields.category === "other"
          ? fields.customCategory.trim()
          : fields.category;
      analyze({ fields: { ...fields, category: resolvedCategory } });
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/onboarding/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qa,
          products,
          // So the Settings website list records the sites this wizard
          // just learned from (url method only; empty otherwise).
          ...(method === "url"
            ? {
                websites: siteStats.map((s) => ({
                  url: s.url,
                  pageCount: s.pageCount,
                  entryCount: s.qaCount,
                })),
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't save. Please try again.");
        setSaving(false);
        return;
      }
      // "No website" path: publish the landing page only if the owner
      // approved it on the review screen. Nothing goes live by default.
      if (method === "guided" && landingPublish) {
        const landingRes = await fetch("/api/landing", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tagline: landingTagline.trim(),
            landingTheme,
            landingPublished: true,
          }),
        });
        if (!landingRes.ok) {
          const ldata = await landingRes.json().catch(() => ({}));
          setError(
            (ldata as { error?: string }).error ||
              "Business info saved, but the landing page could not be published. You can publish it later from the dashboard."
          );
          setSaving(false);
          return;
        }
      }
      router.replace("/dashboard");
    } catch {
      setError("Network error. Check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-rbai-bg">
      <header className="border-b border-rbai-border bg-rbai-surface">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image
              src="/agent-avatar.png"
              alt="Ride Bangla AI Agent"
              width={36}
              height={36}
              className="rounded-lg"
            />
            <div>
              <p className="font-bold text-rbai-text leading-tight">
                Teach your AI about your business
              </p>
              <p className="text-xs text-rbai-text-light">
                Step {step === "method" ? 1 : step === "input" ? 2 : 3} of 3 — you can
                skip and do this later
              </p>
            </div>
          </div>
          <Link
            href="/dashboard"
            className="text-sm text-rbai-text-light hover:text-rbai-text"
          >
            Skip for now
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10">
        {step === "method" && (
          <div className="animate-fade-in">
            <h1 className="text-2xl font-bold text-rbai-text text-center">
              আপনার ব্যবসার ওয়েবসাইট আছে? / Does your business have a website?
            </h1>
            <p className="text-rbai-text-light text-center mt-2 mb-8">
              একটি বেছে নিন — AI সেখান থেকে শিখে আপনার গ্রাহকদের উত্তর দেবে। / Pick
              one — the AI learns from it and starts answering your customers.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
              {METHODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => pickMethod(m.id)}
                  className="text-left bg-rbai-surface border border-rbai-border rounded-2xl p-6 hover:border-rbai-primary hover:shadow-md transition-all group"
                >
                  <span className="inline-flex p-3 rounded-xl bg-rbai-primary-50 text-rbai-primary group-hover:bg-rbai-primary group-hover:text-white transition-colors">
                    <m.icon className="h-6 w-6" />
                  </span>
                  <span className="block font-semibold text-rbai-text mt-4">
                    {m.title}
                  </span>
                  <span className="block text-sm text-rbai-text-light mt-1">
                    {m.desc}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "input" && method && (
          <div className="animate-fade-in max-w-2xl mx-auto">
            <button
              onClick={() => setStep("method")}
              className="flex items-center gap-1.5 text-sm text-rbai-text-light hover:text-rbai-text mb-6"
            >
              <ArrowLeft className="h-4 w-4" /> Choose a different way
            </button>

            {method === "url" && (
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6">
                <h2 className="font-semibold text-rbai-text text-lg">
                  Your website URL{urls.length > 1 ? "s" : ""}
                </h2>
                <p className="text-sm text-rbai-text-light mt-1 mb-4">
                  That&apos;s all we need — we&apos;ll fetch the homepage and key
                  pages (about, services, pricing, contact…) of each site.
                  Have more than one website? Add them all — your agent
                  learns from every one.
                </p>
                <div className="space-y-2">
                  {urls.map((u, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        value={u}
                        onChange={(e) =>
                          setUrls((prev) =>
                            prev.map((v, j) => (j === i ? e.target.value : v))
                          )
                        }
                        placeholder="yourbusiness.com"
                        inputMode="url"
                        className={inputClass}
                      />
                      {urls.length > 1 && (
                        <button
                          type="button"
                          aria-label="Remove this website"
                          onClick={() =>
                            setUrls((prev) => prev.filter((_, j) => j !== i))
                          }
                          className="shrink-0 rounded-lg border border-rbai-border px-3 text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {urls.length < 10 && (
                  <button
                    type="button"
                    onClick={() => setUrls((prev) => [...prev, ""])}
                    className="mt-3 inline-flex items-center gap-2 rounded-lg border border-dashed border-rbai-border px-4 py-2.5 text-sm font-semibold text-rbai-primary hover:bg-rbai-bg"
                  >
                    <Plus className="h-4 w-4" /> Add another website
                  </button>
                )}
              </div>
            )}

            {method === "guided" && guidedInput === "form" && (
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 space-y-4">
                <div>
                  <h2 className="font-semibold text-rbai-text text-lg">
                    Describe your business
                  </h2>
                  <p className="text-sm text-rbai-text-light mt-1">
                    From this we build your AI knowledge, your product catalog,
                    and your landing page.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-rbai-text mb-1.5">
                    Business name
                  </label>
                  <textarea
                    value={fields.businessName}
                    onChange={(e) =>
                      setFields({ ...fields, businessName: e.target.value })
                    }
                    rows={1}
                    placeholder="e.g. Dhaka Cake House"
                    className={`${inputClass} resize-y`}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-rbai-text mb-1.5">
                    ব্যবসার ধরন / Business category
                  </label>
                  <select
                    value={fields.category}
                    onChange={(e) =>
                      setFields({ ...fields, category: e.target.value })
                    }
                    className={inputClass}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  {fields.category === "other" && (
                    <input
                      value={fields.customCategory}
                      onChange={(e) =>
                        setFields({ ...fields, customCategory: e.target.value })
                      }
                      placeholder="আপনার ব্যবসার ধরন লিখুন / Type your business category"
                      maxLength={60}
                      className={`${inputClass} mt-2`}
                    />
                  )}
                </div>
                {(
                  [
                    ["whatYouSell", "What do you sell or offer?", "e.g. Custom cakes, pastries, party orders", 2],
                    ["location", "Location / delivery area", "e.g. Mirpur, Dhaka — delivery all over Dhaka", 2],
                    ["contact", "Contact / WhatsApp", "e.g. 01XXXXXXXXX, WhatsApp, Facebook page", 2],
                    ["hours", "Business hours", "e.g. Open daily 9am – 10pm", 2],
                    ["policies", "Policies (returns, refunds, delivery)", "e.g. 50% advance for custom orders", 2],
                  ] as const
                ).map(([key, label, ph, rows]) => (
                  <div key={key}>
                    <label className="block text-sm font-medium text-rbai-text mb-1.5">
                      {label}
                    </label>
                    <textarea
                      value={fields[key]}
                      onChange={(e) =>
                        setFields({ ...fields, [key]: e.target.value })
                      }
                      rows={rows}
                      placeholder={ph}
                      className={`${inputClass} resize-y`}
                    />
                  </div>
                ))}
                <div className="pt-1 flex items-center gap-4 text-sm">
                  <span className="text-rbai-text-light">Prefer another way?</span>
                  <button
                    onClick={() => { setGuidedInput("text"); setError(""); }}
                    className="flex items-center gap-1.5 text-rbai-primary font-medium hover:underline"
                  >
                    <FileText className="h-4 w-4" /> Paste text
                  </button>
                  <button
                    onClick={() => { setGuidedInput("file"); setError(""); }}
                    className="flex items-center gap-1.5 text-rbai-primary font-medium hover:underline"
                  >
                    <Upload className="h-4 w-4" /> Upload file
                  </button>
                </div>
              </div>
            )}

            {method === "guided" && guidedInput === "text" && (
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6">
                <h2 className="font-semibold text-rbai-text text-lg">
                  Paste your business info
                </h2>
                <p className="text-sm text-rbai-text-light mt-1 mb-4">
                  Menu, price list, about-us, FAQs — anything that helps the AI
                  answer customers.
                </p>
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  rows={10}
                  placeholder={"e.g.\nChocolate Cake — Tk 850\nOpen daily 9am–10pm\nDelivery inside Dhaka, charge Tk 60…"}
                  className={`${inputClass} resize-y`}
                />
                <button
                  onClick={() => { setGuidedInput("form"); setError(""); }}
                  className="mt-3 text-sm text-rbai-primary font-medium hover:underline"
                >
                  Back to the guided form
                </button>
              </div>
            )}

            {method === "guided" && guidedInput === "file" && (
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6">
                <h2 className="font-semibold text-rbai-text text-lg">
                  Upload a text file
                </h2>
                <p className="text-sm text-rbai-text-light mt-1 mb-4">
                  A .txt or .md file with your business information (max 500 KB).
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.markdown,text/plain"
                  onChange={handleFile}
                  className="hidden"
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="w-full border-2 border-dashed border-rbai-border rounded-xl py-10 flex flex-col items-center gap-2 text-rbai-text-light hover:border-rbai-primary hover:text-rbai-primary transition-colors"
                >
                  <Upload className="h-8 w-8" />
                  {fileName ? (
                    <span className="text-sm font-medium text-rbai-text">
                      {fileName}
                    </span>
                  ) : (
                    <span className="text-sm">Click to choose a file</span>
                  )}
                </button>
                <button
                  onClick={() => { setGuidedInput("form"); setError(""); }}
                  className="mt-3 text-sm text-rbai-primary font-medium hover:underline"
                >
                  Back to the guided form
                </button>
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              onClick={startAnalyze}
              disabled={analyzing}
              className="mt-6 w-full rounded-lg bg-rbai-primary text-white font-medium py-2.5 text-sm hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {analyzing ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {method === "url"
                    ? "Fetching your website…"
                    : "Building your business profile…"}
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  Continue <ArrowRight className="h-4 w-4" />
                </span>
              )}
            </button>
          </div>
        )}

        {step === "review" && result && (
          <div className="animate-fade-in">
            <div className="flex items-start justify-between gap-4 mb-2">
              <div>
                <h1 className="text-2xl font-bold text-rbai-text flex items-center gap-2">
                  <PencilLine className="h-6 w-6 text-rbai-primary" />
                  Review what the AI learned
                </h1>
                <p className="text-sm text-rbai-text-light mt-1 max-w-2xl">
                  {result.note}
                </p>
                {siteWarnings.length > 0 && (
                  <p className="text-sm text-amber-700 mt-2 max-w-2xl">
                    We couldn&apos;t fetch {siteWarnings.length === 1 ? "this website" : "these websites"}:{" "}
                    {siteWarnings.join(", ")} — the agent has not learned from{" "}
                    {siteWarnings.length === 1 ? "it" : "them"}. You can add{" "}
                    {siteWarnings.length === 1 ? "it" : "them"} again later in
                    Settings → Websites.
                  </p>
                )}
              </div>
              <button
                onClick={() => setStep("input")}
                className="flex items-center gap-1.5 text-sm text-rbai-text-light hover:text-rbai-text shrink-0 mt-1"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            </div>

            {/* Landing page preview + approval (only for the "no website" path).
                Nothing goes live unless the owner approves it here. */}
            {method === "guided" && (
              <div className="mt-8 bg-rbai-surface border border-rbai-border rounded-2xl p-6">
                <h2 className="font-semibold text-rbai-text text-lg">
                  Your new landing page
                </h2>
                <p className="text-sm text-rbai-text-light mt-1 mb-4">
                  We drafted this from your description. Review it, pick a
                  design, and approve it — it goes live only with your approval.
                </p>
                <label className="block text-sm font-medium text-rbai-text mb-1.5">
                  Tagline
                </label>
                <input
                  value={landingTagline}
                  onChange={(e) => setLandingTagline(e.target.value)}
                  placeholder="e.g. Fresh custom cakes, delivered across Dhaka"
                  maxLength={160}
                  className={inputClass}
                />
                <p className="block text-sm font-medium text-rbai-text mt-4 mb-2">
                  Design
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {LANDING_THEMES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setLandingTheme(t.id)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        landingTheme === t.id
                          ? "border-rbai-primary bg-rbai-primary-50"
                          : "border-rbai-border hover:border-rbai-primary"
                      }`}
                    >
                      <span className="block text-sm font-semibold text-rbai-text">
                        {t.name}
                      </span>
                      <span className="block text-xs text-rbai-text-light mt-0.5">
                        {t.description}
                      </span>
                    </button>
                  ))}
                </div>
                <label className="mt-5 flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={landingPublish}
                    onChange={(e) => setLandingPublish(e.target.checked)}
                    className="mt-1 h-4 w-4 accent-[#4A7C9B]"
                  />
                  <span className="text-sm text-rbai-text">
                    <span className="font-medium">Publish my landing page</span>
                    <span className="block text-rbai-text-light mt-0.5">
                      {landingUrl
                        ? `It will go live at ${landingUrl} — customers can visit it right away.`
                        : "It will go live at your public page address — customers can visit it right away."}{" "}
                      The AI also answers customers from this page.
                    </span>
                  </span>
                </label>
                <p className="text-xs text-rbai-text-light mt-4 border-t border-rbai-border pt-3">
                  পেজটি আপনার দেওয়া তথ্য থেকে একটি প্রিমিয়াম টেমপ্লেটে তৈরি হয় — আপনার
                  কোনো API কী লাগবে না; AI-এর সব সংযোগ আমাদের টিমই করে দেবে। / Your
                  page is built from your details in a premium template — no API key
                  is ever needed from you; our team handles the AI connection and
                  makes the copy even better for you.
                </p>
              </div>
            )}

            {/* Q&A editor */}
            <h2 className="font-semibold text-rbai-text mt-8 mb-3">
              Knowledge base ({qa.length})
            </h2>
            <div className="space-y-3">
              {qa.map((entry, i) => (
                <div
                  key={i}
                  className="bg-rbai-surface border border-rbai-border rounded-xl p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 space-y-2">
                      <input
                        value={entry.question}
                        onChange={(e) => {
                          const next = [...qa];
                          next[i] = { ...next[i], question: e.target.value };
                          setQa(next);
                        }}
                        placeholder="Question"
                        className={`${inputClass} font-medium`}
                      />
                      <textarea
                        value={entry.answer}
                        onChange={(e) => {
                          const next = [...qa];
                          next[i] = { ...next[i], answer: e.target.value };
                          setQa(next);
                        }}
                        placeholder="Answer"
                        rows={2}
                        className={`${inputClass} resize-y`}
                      />
                    </div>
                    <button
                      onClick={() => setQa(qa.filter((_, j) => j !== i))}
                      className="p-2 text-rbai-text-light hover:text-red-600 transition-colors"
                      aria-label="Remove entry"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              {qa.length === 0 && (
                <p className="text-sm text-rbai-text-light bg-rbai-surface border border-dashed border-rbai-border rounded-xl p-6 text-center">
                  No knowledge entries yet — add one below.
                </p>
              )}
              <button
                onClick={() => setQa([...qa, { question: "", answer: "" }])}
                className="flex items-center gap-1.5 text-sm text-rbai-primary font-medium hover:underline"
              >
                <Plus className="h-4 w-4" /> Add entry
              </button>
            </div>

            {/* Products editor */}
            <h2 className="font-semibold text-rbai-text mt-8 mb-3">
              Products ({products.length})
            </h2>
            <div className="space-y-3">
              {products.map((p, i) => (
                <div
                  key={i}
                  className="bg-rbai-surface border border-rbai-border rounded-xl p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-12 gap-2">
                      <input
                        value={p.name}
                        onChange={(e) => {
                          const next = [...products];
                          next[i] = { ...next[i], name: e.target.value };
                          setProducts(next);
                        }}
                        placeholder="Product name"
                        className={`${inputClass} sm:col-span-6 font-medium`}
                      />
                      <input
                        value={p.price === null ? "" : String(p.price)}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          const num = v === "" ? null : Number(v);
                          const next = [...products];
                          next[i] = {
                            ...next[i],
                            price: num !== null && Number.isFinite(num) ? num : null,
                          };
                          setProducts(next);
                        }}
                        placeholder="Price"
                        inputMode="decimal"
                        className={`${inputClass} sm:col-span-2`}
                      />
                      <select
                        value={p.currency}
                        onChange={(e) => {
                          const next = [...products];
                          next[i] = { ...next[i], currency: e.target.value };
                          setProducts(next);
                        }}
                        className={`${inputClass} sm:col-span-2`}
                      >
                        <option value="BDT">BDT (৳)</option>
                        <option value="USD">USD ($)</option>
                      </select>
                      <input
                        value={p.category || "Products"}
                        onChange={(e) => {
                          const next = [...products];
                          next[i] = { ...next[i], category: e.target.value };
                          setProducts(next);
                        }}
                        placeholder="Category"
                        className={`${inputClass} sm:col-span-2`}
                      />
                    </div>
                    <button
                      onClick={() => setProducts(products.filter((_, j) => j !== i))}
                      className="p-2 text-rbai-text-light hover:text-red-600 transition-colors"
                      aria-label="Remove product"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              {products.length === 0 && (
                <p className="text-sm text-rbai-text-light bg-rbai-surface border border-dashed border-rbai-border rounded-xl p-6 text-center">
                  No products detected — add them manually or skip; you can
                  manage the catalog later from the dashboard.
                </p>
              )}
              <button
                onClick={() =>
                  setProducts([
                    ...products,
                    { name: "", price: null, currency: "BDT", category: "Products" },
                  ])
                }
                className="flex items-center gap-1.5 text-sm text-rbai-primary font-medium hover:underline"
              >
                <Plus className="h-4 w-4" /> Add product
              </button>
            </div>

            {error && (
              <div className="mt-6 rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 rounded-lg bg-rbai-primary text-white font-medium py-3 text-sm hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Check className="h-4 w-4" />
                    {method === "guided" && landingPublish
                      ? "Approve and publish"
                      : "Save and go to dashboard"}
                  </span>
                )}
              </button>
              <Link
                href="/dashboard"
                className="rounded-lg border border-rbai-border bg-rbai-surface text-rbai-text font-medium py-3 px-6 text-sm hover:bg-rbai-bg transition-colors text-center flex items-center justify-center gap-2"
              >
                <X className="h-4 w-4" /> Skip
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
