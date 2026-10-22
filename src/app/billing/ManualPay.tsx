"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Check, Copy } from "lucide-react";
import {
  PLAN_META,
  PAID_PLANS,
  type BillingInterval,
} from "@/lib/plans";
import type {
  ManualPaymentMethod,
  ManualMethodId,
} from "@/lib/manual-payments";
import type { CatalogPlanView } from "@/lib/plan-catalog";

/**
 * ManualPay — the "Pay manually" section on /billing (Phase 4b).
 *
 * Shows each ENABLED user-configured method (bank transfer details, crypto
 * pay IDs/UIDs) plus the plan amount and a reference code.
 * The customer pays on their own, then submits a claim with BOTH required
 * proofs: transaction ID and a payment screenshot.
 *
 * Screenshot handling (honest, pre-Blaze): Firebase Storage is unavailable
 * until Blaze billing is paid, so the image is compressed client-side to a
 * <=400KB JPEG and stored as a base64 data URL in the claim doc (stays under
 * Firestore's 1MB doc limit). TODO post-Blaze: upload to Firebase Storage
 * and store the download URL instead.
 */

const MAX_SCREENSHOT_BYTES = 400 * 1024;

interface ManualPayProps {
  methods: ManualPaymentMethod[];
  defaultPlan: string;
  reference: string;
  canPay: boolean;
  /** Effective catalog view-model (panel-driven plans + live offers).
   *  When absent/empty, the code catalog renders exactly as before. */
  catalog?: CatalogPlanView[];
}

/** Code-catalog fallback view (no offers) — today's exact behaviour. */
const FALLBACK_CATALOG: CatalogPlanView[] = PAID_PLANS.map((id) => ({
  id,
  name: PLAN_META[id].name,
  tagline: PLAN_META[id].tagline,
  messagesPerMonth: PLAN_META[id].messagesPerMonth,
  active: true,
  source: "code",
  monthly: { regularPriceUsd: PLAN_META[id].priceUsd, offer: null },
  yearly: { regularPriceUsd: PLAN_META[id].yearlyPriceUsd, offer: null },
}));

function fmtPrice(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtEnds(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image file."));
    };
    img.src = url;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(blob);
  });
}

/** Compress to a <=400KB JPEG data URL. Throws an honest error when the
 *  image cannot be brought under the cap. */
async function compressScreenshot(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file (PNG or JPEG).");
  }
  const img = await loadImage(file);
  const MAX_DIM = 1024;
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process images.");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.85, 0.65, 0.45]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality)
    );
    if (blob && blob.size <= MAX_SCREENSHOT_BYTES) {
      return blobToDataUrl(blob);
    }
  }
  throw new Error(
    "That screenshot is still larger than 400 KB after compression. Please use a smaller or clearer screenshot — a cropped image of just the payment confirmation works best."
  );
}

/**
 * Copy control (owner directive 2026-10-22, re-audit #2): every payment
 * detail a payer must transcribe carries one — a payer who cannot copy
 * the number cannot pay. Writes the EXACT displayed value to the
 * clipboard (Clipboard API, with the legacy selection fallback for
 * non-secure contexts) and flips to a visible "Copied" confirmation.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  async function onCopy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className="inline-flex flex-none items-center gap-1 rounded-md border border-rbai-border bg-rbai-surface px-2 py-1 text-[11px] font-medium text-rbai-text-light hover:text-rbai-text transition-colors"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-rbai-text-light font-medium">{label}</span>
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-rbai-text font-mono font-medium text-right break-all">
          {value}
        </span>
        <CopyButton value={value} label={label} />
      </span>
    </div>
  );
}

function MethodCard({ method }: { method: ManualPaymentMethod }) {
  return (
    <div className="rounded-xl bg-rbai-bg border border-rbai-border p-5">
      <h3 className="font-semibold text-rbai-text">{method.label}</h3>
      <div className="mt-3 divide-y divide-rbai-border/60">
        {method.id === "us_bank" && (
          <>
            {method.bankName && (
              <DetailRow label="Bank" value={method.bankName} />
            )}
            {method.accountName && (
              <DetailRow label="Account name" value={method.accountName} />
            )}
            {method.routingNumber && (
              <DetailRow label="Routing number" value={method.routingNumber} />
            )}
            {method.accountNumber && (
              <DetailRow label="Account number" value={method.accountNumber} />
            )}
          </>
        )}
        {method.id === "binance" && method.payId && (
          <DetailRow label="Binance Pay ID" value={method.payId} />
        )}
        {(method.id === "bybit" || method.id === "okx") && method.uid && (
          <DetailRow label="UID" value={method.uid} />
        )}
        {method.note && (
          <p className="text-xs text-rbai-text-light pt-2">{method.note}</p>
        )}
      </div>
    </div>
  );
}

export default function ManualPay({
  methods,
  defaultPlan,
  reference,
  canPay,
  catalog,
}: ManualPayProps) {
  const plans = catalog && catalog.length > 0 ? catalog : FALLBACK_CATALOG;
  const [plan, setPlan] = useState<string>(defaultPlan);
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [methodId, setMethodId] = useState<ManualMethodId | "">(
    methods[0]?.id ?? ""
  );
  const [txnId, setTxnId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [claimId, setClaimId] = useState("");
  // Billing Phase 2: the server-generated refCode (RB-XXXXXXXX) — shown
  // with "include this reference in your payment note".
  const [refCode, setRefCode] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Only tenant admins move money.
  if (!canPay) return null;

  // Amount = the catalog price for the selected plan + interval, with a
  // live offer applied when one exists — the same figure the server
  // recomputes at claim time.
  const selected = plans.find((p) => p.id === plan) ?? plans[0];
  const selectedView = selected
    ? interval === "yearly"
      ? selected.yearly
      : selected.monthly
    : null;
  const offer = selectedView?.offer ?? null;
  const amount = selectedView
    ? (offer?.effectivePriceUsd ?? selectedView.regularPriceUsd)
    : 0;

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError("");
    setPreviewUrl("");
    setScreenshotDataUrl("");
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressScreenshot(file);
      setScreenshotDataUrl(dataUrl);
      setPreviewUrl(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image.");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!methodId) {
      setError("Please choose a payment method.");
      return;
    }
    if (!txnId.trim()) {
      setError("The transaction ID / hash ID is required.");
      return;
    }
    if (!screenshotDataUrl) {
      setError("The payment screenshot is required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/billing/manual-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: selected?.id ?? plan,
          interval,
          method: methodId,
          reference,
          txnId: txnId.trim(),
          screenshotDataUrl,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.message === "string" && data.message
            ? data.message
            : "We could not record your claim. Please try again."
        );
        setSubmitting(false);
        return;
      }
      setClaimId(data.claimId || "");
      setRefCode(typeof data.refCode === "string" ? data.refCode : "");
    } catch {
      setError("Network error. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
      <h2 className="text-lg font-semibold text-rbai-text">Pay manually</h2>
      <p className="text-sm text-rbai-text-light mt-1">
        Bank transfer or crypto — pay on your own, then submit
        your claim below and we&apos;ll activate your plan after verification.
      </p>

      {methods.length === 0 ? (
        <div className="mt-5 rounded-xl bg-rbai-bg border border-rbai-border p-5 text-sm text-rbai-text-light">
          Manual payments coming soon — contact us.
        </div>
      ) : claimId ? (
        <div className="mt-5 rounded-xl bg-emerald-50 border border-emerald-200 p-5">
          <p className="text-sm font-semibold text-emerald-800">
            Claim submitted — thank you.
          </p>
          <p className="text-sm text-emerald-700 mt-1">
            Our team will verify your payment and activate your plan.{" "}
            {refCode ? (
              <>
                Include this reference in your payment note:{" "}
                <span className="font-mono font-bold text-emerald-900">
                  {refCode}
                </span>{" "}
                <CopyButton value={refCode} label="reference code" />
              </>
            ) : (
              <>
                Reference:{" "}
                <span className="font-mono font-medium">{reference}</span>{" "}
                <CopyButton value={reference} label="payment reference" />
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {methods.map((m) => (
              <MethodCard key={m.id} method={m} />
            ))}
          </div>

          <form onSubmit={onSubmit} className="mt-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="mp-plan"
                  className="block text-sm font-medium text-rbai-text mb-1.5"
                >
                  Plan
                </label>
                <select
                  id="mp-plan"
                  value={selected?.id ?? plan}
                  onChange={(e) => setPlan(e.target.value)}
                  className="w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text focus:outline-none focus:ring-2 focus:ring-rbai-primary"
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — ${fmtPrice(p.monthly.regularPriceUsd)}/mo or $
                      {fmtPrice(p.yearly.regularPriceUsd)}/yr
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className="block text-sm font-medium text-rbai-text mb-1.5">
                  Billing interval
                </span>
                <div
                  role="group"
                  aria-label="Billing interval"
                  className="inline-flex rounded-lg border border-rbai-border p-1"
                >
                  {(["monthly", "yearly"] as BillingInterval[]).map((iv) => (
                    <button
                      key={iv}
                      type="button"
                      onClick={() => setInterval(iv)}
                      aria-pressed={interval === iv}
                      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                        interval === iv
                          ? "bg-rbai-primary text-white"
                          : "text-rbai-text-light hover:text-rbai-text"
                      }`}
                    >
                      {iv === "monthly" ? "Monthly" : "Yearly · 2 months free"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-rbai-bg border border-rbai-border p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-rbai-text-light font-medium">
                  Amount to pay
                </p>
                <p className="text-2xl font-bold text-rbai-text">
                  ${fmtPrice(amount)}
                  {offer && selectedView && (
                    <span className="ml-2 text-base font-normal text-rbai-text-light line-through">
                      ${fmtPrice(selectedView.regularPriceUsd)}
                    </span>
                  )}
                  <span className="text-sm font-normal text-rbai-text-light">
                    {" "}
                    USD / {interval === "yearly" ? "year" : "month"}
                  </span>
                </p>
                <div className="mt-1.5">
                  <CopyButton value={fmtPrice(amount)} label="amount" />
                </div>
                {offer && (
                  <p className="text-xs font-medium text-emerald-700 mt-1">
                    {offer.name} · ends {fmtEnds(offer.endsAt)}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs text-rbai-text-light font-medium">
                  Your payment reference
                </p>
                <p className="flex items-center justify-end gap-2 text-sm font-mono font-semibold text-rbai-text">
                  {reference}
                  <CopyButton value={reference} label="payment reference" />
                </p>
                <p className="text-xs text-rbai-text-light">
                  Include this in your transfer note
                </p>
              </div>
            </div>

            <div>
              <label
                htmlFor="mp-method"
                className="block text-sm font-medium text-rbai-text mb-1.5"
              >
                Payment method used
              </label>
              <select
                id="mp-method"
                value={methodId}
                onChange={(e) => setMethodId(e.target.value as ManualMethodId)}
                className="w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text focus:outline-none focus:ring-2 focus:ring-rbai-primary"
              >
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="mp-txn"
                className="block text-sm font-medium text-rbai-text mb-1.5"
              >
                Transaction ID / hash ID{" "}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="mp-txn"
                type="text"
                required
                maxLength={200}
                value={txnId}
                onChange={(e) => setTxnId(e.target.value)}
                placeholder="e.g. bank reference no. or crypto transaction hash"
                className="w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary"
              />
            </div>

            <div>
              <label
                htmlFor="mp-shot"
                className="block text-sm font-medium text-rbai-text mb-1.5"
              >
                Payment screenshot <span className="text-red-500">*</span>
              </label>
              <input
                ref={fileRef}
                id="mp-shot"
                type="file"
                accept="image/*"
                required
                onChange={onFileChange}
                className="w-full text-sm text-rbai-text-light file:mr-4 file:rounded-lg file:border-0 file:bg-rbai-primary file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-white hover:file:opacity-90"
              />
              <p className="text-xs text-rbai-text-light mt-1.5">
                Compressed automatically (max 400 KB). A cropped screenshot of
                just the payment confirmation works best.
              </p>
              {previewUrl && (
                <Image
                  src={previewUrl}
                  alt="Payment screenshot preview"
                  width={320}
                  height={320}
                  className="mt-3 w-40 h-auto rounded-lg border border-rbai-border"
                />
              )}
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-rbai-primary text-white font-medium py-3 text-sm hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Submitting your claim…" : "I have paid — submit claim"}
            </button>
            <p className="text-xs text-rbai-text-light text-center">
              Our team verifies every claim manually before activating the plan.
            </p>
          </form>
        </>
      )}
    </div>
  );
}
