"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import {
  PLAN_META,
  PAID_PLANS,
  type PaidPlanId,
  type BillingInterval,
} from "@/lib/plans";
import type {
  ManualPaymentMethod,
  ManualMethodId,
} from "@/lib/manual-payments";

/**
 * ManualPay — the "Pay manually" section on /billing (Phase 4b).
 *
 * Shows each ENABLED user-configured method (bank transfer details, crypto
 * pay IDs/UIDs, WeChat Pay QR) plus the plan amount and a reference code.
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
  defaultPlan: PaidPlanId;
  reference: string;
  canPay: boolean;
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="text-xs text-rbai-text-light font-medium">{label}</span>
      <span className="text-sm text-rbai-text font-mono font-medium text-right break-all">
        {value}
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
        {method.id === "wechat_pay" && method.qrImage && (
          <div className="py-2 flex flex-col items-center">
            <Image
              src={method.qrImage}
              alt={`${method.label} QR code`}
              width={320}
              height={320}
              className="w-44 sm:w-56 h-auto rounded-lg border border-rbai-border bg-white"
            />
            <span className="text-xs text-rbai-text-light mt-2">
              Scan with WeChat to pay
            </span>
          </div>
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
}: ManualPayProps) {
  const [plan, setPlan] = useState<PaidPlanId>(defaultPlan);
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

  const amount =
    interval === "yearly"
      ? PLAN_META[plan].yearlyPriceUsd
      : PLAN_META[plan].priceUsd;

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
          plan,
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
        Bank transfer, crypto, or WeChat Pay — pay on your own, then submit
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
                </span>
              </>
            ) : (
              <>
                Reference:{" "}
                <span className="font-mono font-medium">{reference}</span>
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
                  value={plan}
                  onChange={(e) => setPlan(e.target.value as PaidPlanId)}
                  className="w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text focus:outline-none focus:ring-2 focus:ring-rbai-primary"
                >
                  {PAID_PLANS.map((p) => (
                    <option key={p} value={p}>
                      {PLAN_META[p].name} — ${PLAN_META[p].priceUsd}/mo or $
                      {PLAN_META[p].yearlyPriceUsd}/yr
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
                  ${amount}
                  <span className="text-sm font-normal text-rbai-text-light">
                    {" "}
                    USD / {interval === "yearly" ? "year" : "month"}
                  </span>
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-rbai-text-light font-medium">
                  Your payment reference
                </p>
                <p className="text-sm font-mono font-semibold text-rbai-text">
                  {reference}
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
