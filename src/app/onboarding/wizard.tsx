"use client";

import { useRef, useState } from "react";
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
  MessageCircleQuestion,
  PencilLine,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";

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

type Method = "url" | "text" | "guided" | "file";

const METHODS: { id: Method; icon: React.ElementType; title: string; desc: string }[] = [
  {
    id: "url",
    icon: Globe,
    title: "From my website",
    desc: "We fetch your homepage and key pages and learn your business automatically.",
  },
  {
    id: "text",
    icon: FileText,
    title: "Paste text",
    desc: "Paste anything: your menu, price list, about-us text, FAQs.",
  },
  {
    id: "guided",
    icon: MessageCircleQuestion,
    title: "Answer a few questions",
    desc: "A short guided Q&A: what you sell, hours, location, contact, policies.",
  },
  {
    id: "file",
    icon: Upload,
    title: "Upload a text file",
    desc: "Upload a .txt or .md file with your business information.",
  },
];

const inputClass =
  "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow";

export default function OnboardingWizard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"method" | "input" | "review">("method");
  const [method, setMethod] = useState<Method | null>(null);

  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [fields, setFields] = useState({
    businessName: "",
    whatYouSell: "",
    hours: "",
    location: "",
    contact: "",
    policies: "",
  });

  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [qa, setQa] = useState<QAPair[]>([]);
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [saving, setSaving] = useState(false);

  function pickMethod(m: Method) {
    setMethod(m);
    setError("");
    setStep("input");
  }

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
      if (!url.trim()) return setError("Please enter your website URL.");
      analyze({ url: url.trim() });
    } else if (method === "text") {
      if (pastedText.trim().length < 20)
        return setError("Please paste at least a few sentences about your business.");
      analyze({ text: pastedText, sourceName: "Pasted text" });
    } else if (method === "file") {
      if (fileText.trim().length < 20)
        return setError("Please choose a text file first.");
      analyze({ text: fileText, sourceName: fileName || "Uploaded file" });
    } else {
      const answered = Object.values(fields).some((v) => v.trim().length >= 3);
      if (!answered)
        return setError("Please answer at least one question.");
      analyze({ fields });
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/onboarding/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qa, products }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't save. Please try again.");
        setSaving(false);
        return;
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
              How do you want to give us your business info?
            </h1>
            <p className="text-rbai-text-light text-center mt-2 mb-8">
              Pick whichever is easiest — the AI learns from it and starts
              answering your customers.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  Your website URL
                </h2>
                <p className="text-sm text-rbai-text-light mt-1 mb-4">
                  We&apos;ll fetch your homepage and key pages (about, services,
                  pricing, contact…) on the same site.
                </p>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="yourbusiness.com"
                  inputMode="url"
                  className={inputClass}
                />
              </div>
            )}

            {method === "text" && (
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
              </div>
            )}

            {method === "file" && (
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
              </div>
            )}

            {method === "guided" && (
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 space-y-4">
                <h2 className="font-semibold text-rbai-text text-lg">
                  Tell us about your business
                </h2>
                {(
                  [
                    ["businessName", "Business name", "e.g. Dhaka Cake House"],
                    ["whatYouSell", "What do you sell or offer?", "e.g. Custom cakes, pastries, party orders"],
                    ["hours", "Business hours", "e.g. Open daily 9am – 10pm"],
                    ["location", "Location / delivery area", "e.g. Mirpur, Dhaka — delivery all over Dhaka"],
                    ["contact", "Contact info", "e.g. Phone, WhatsApp, Facebook page"],
                    ["policies", "Policies (returns, refunds, delivery)", "e.g. 50% advance for custom orders"],
                  ] as const
                ).map(([key, label, ph]) => (
                  <div key={key}>
                    <label className="block text-sm font-medium text-rbai-text mb-1.5">
                      {label}
                    </label>
                    <textarea
                      value={fields[key]}
                      onChange={(e) =>
                        setFields({ ...fields, [key]: e.target.value })
                      }
                      rows={key === "businessName" ? 1 : 2}
                      placeholder={ph}
                      className={`${inputClass} resize-y`}
                    />
                  </div>
                ))}
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
                    : "Structuring your info…"}
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
              </div>
              <button
                onClick={() => setStep("input")}
                className="flex items-center gap-1.5 text-sm text-rbai-text-light hover:text-rbai-text shrink-0 mt-1"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            </div>

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
                    <Check className="h-4 w-4" /> Save and go to dashboard
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
