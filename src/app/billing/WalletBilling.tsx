"use client";

import { useRef, useState } from "react";
import Image from "next/image";
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
 * WalletBilling — the "Wallet" section on /billing (Billing Phase 2).
 *
 * Two flows, both tenant-admin only:
 *  1. "Pay from wallet" — pick a plan + interval, pay the server-computed
 *     price from the wallet balance. The subscription activates immediately
 *     (single atomic transaction). Insufficient balance => an honest 402
 *     with the exact price.
 *  2. "Deposit to wallet" — method select → USD amount → transaction ID +
 *     payment screenshot → the server returns a unique refCode, shown with
 *     "include this reference in your payment note".
 *
 * Screenshot handling (honest, pre-Blaze): the image is compressed
 * client-side to a <=400KB JPEG and stored as a base64 data URL in the
 * claim doc. TODO post-Blaze: upload to Firebase Storage instead.
 */

const MAX_SCREENSHOT_BYTES = 400 * 1024;

interface WalletBillingProps {
  balanceCents: number;
  defaultPlan: string;
  defaultInterval: BillingInterval;
  methods: ManualPaymentMethod[];
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

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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

const inputClass =
  "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light/60 focus:outline-none focus:ring-2 focus:ring-rbai-primary/40";
const labelClass =
  "block text-xs font-medium text-rbai-text-light mb-1.5";

export default function WalletBilling({
  balanceCents,
  defaultPlan,
  defaultInterval,
  methods,
  canPay,
  catalog,
}: WalletBillingProps) {
  const plans = catalog && catalog.length > 0 ? catalog : FALLBACK_CATALOG;
  // ---- Pay from wallet ----
  const [plan, setPlan] = useState<string>(defaultPlan);
  const [interval, setInterval] = useState<BillingInterval>(defaultInterval);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseMsg, setPurchaseMsg] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  // ---- Deposit to wallet ----
  const [methodId, setMethodId] = useState<ManualMethodId | "">(
    methods[0]?.id ?? ""
  );
  const [amountUsd, setAmountUsd] = useState("");
  const [txnId, setTxnId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState("");
  const [depositError, setDepositError] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [depositRefCode, setDepositRefCode] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  if (!canPay) return null;

  // Price = the catalog price for the selected plan + interval, with a
  // live offer applied when one exists — the same figure the server
  // charges in purchaseFromWallet.
  const selected = plans.find((p) => p.id === plan) ?? plans[0];
  const selectedView = selected
    ? interval === "yearly"
      ? selected.yearly
      : selected.monthly
    : null;
  const offer = selectedView?.offer ?? null;
  const priceCents = selectedView
    ? Math.round(
        (offer?.effectivePriceUsd ?? selectedView.regularPriceUsd) * 100
      )
    : 0;

  async function onPurchase() {
    setPurchaseMsg(null);
    setPurchasing(true);
    try {
      const res = await fetch("/api/wallet/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: selected?.id ?? plan, interval }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPurchaseMsg({
          kind: "error",
          text:
            typeof data.message === "string" && data.message
              ? data.message
              : "We could not complete your purchase. Please try again.",
        });
        setPurchasing(false);
        return;
      }
      setPurchaseMsg({
        kind: "ok",
        text: `Done — your ${selected?.name ?? plan} plan (${interval}) is active. New balance: ${formatUsd(data.balanceCents ?? 0)}.`,
      });
    } catch {
      setPurchaseMsg({
        kind: "error",
        text: "Network error. Check your connection and try again.",
      });
    }
    setPurchasing(false);
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDepositError("");
    setPreviewUrl("");
    setScreenshotDataUrl("");
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressScreenshot(file);
      setScreenshotDataUrl(dataUrl);
      setPreviewUrl(dataUrl);
    } catch (err) {
      setDepositError(
        err instanceof Error ? err.message : "Could not read that image."
      );
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault();
    setDepositError("");
    if (!methodId) {
      setDepositError("Please choose a payment method.");
      return;
    }
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
      setDepositError("Please enter a valid USD amount.");
      return;
    }
    if (!txnId.trim()) {
      setDepositError("The transaction ID / hash ID is required.");
      return;
    }
    if (!screenshotDataUrl) {
      setDepositError("The payment screenshot is required.");
      return;
    }
    setDepositing(true);
    try {
      const res = await fetch("/api/wallet/deposit-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: methodId,
          amountUsd: amount,
          txnId: txnId.trim(),
          screenshotDataUrl,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDepositError(
          typeof data.message === "string" && data.message
            ? data.message
            : "We could not record your claim. Please try again."
        );
        setDepositing(false);
        return;
      }
      setDepositRefCode(typeof data.refCode === "string" ? data.refCode : "");
    } catch {
      setDepositError("Network error. Check your connection and try again.");
      setDepositing(false);
    }
  }

  return (
    <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
      <h2 className="text-lg font-semibold text-rbai-text">Wallet</h2>
      <p className="text-sm text-rbai-text-light mt-1">
        Top up your wallet with a manual payment, then pay for plans from
        your balance — no card needed.
      </p>

      <div className="mt-5 rounded-xl bg-rbai-bg border border-rbai-border p-4 flex items-center justify-between">
        <span className="text-sm font-medium text-rbai-text-light">
          Current balance
        </span>
        <span className="text-2xl font-bold text-rbai-text">
          {formatUsd(balanceCents)}
        </span>
      </div>

      {/* ---- Pay from wallet ---- */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-rbai-text">Pay from wallet</h3>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="wallet-plan" className={labelClass}>
              Plan
            </label>
            <select
              id="wallet-plan"
              value={selected?.id ?? plan}
              onChange={(e) => setPlan(e.target.value)}
              className={inputClass}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="wallet-interval" className={labelClass}>
              Billing
            </label>
            <select
              id="wallet-interval"
              value={interval}
              onChange={(e) => setInterval(e.target.value as BillingInterval)}
              className={inputClass}
            >
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly (2 months free)</option>
            </select>
          </div>
        </div>
        {offer && selectedView && (
          <p className="text-xs font-medium text-emerald-700 mt-3">
            {offer.name} ·{" "}
            <span className="line-through text-rbai-text-light">
              {formatUsd(Math.round(selectedView.regularPriceUsd * 100))}
            </span>{" "}
            · ends {fmtEnds(offer.endsAt)}
          </p>
        )}
        <button
          type="button"
          onClick={onPurchase}
          disabled={purchasing || balanceCents < priceCents}
          className="mt-4 w-full rounded-lg bg-rbai-primary text-white font-medium py-2.5 px-4 text-sm hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {purchasing
            ? "Processing…"
            : `Pay ${formatUsd(priceCents)} from wallet`}
        </button>
        {balanceCents < priceCents && (
          <p className="text-xs text-rbai-text-light mt-2">
            Your balance ({formatUsd(balanceCents)}) does not cover{" "}
            {formatUsd(priceCents)} — deposit to your wallet below first.
          </p>
        )}
        {purchaseMsg && (
          <p
            className={`text-sm mt-3 ${purchaseMsg.kind === "ok" ? "text-emerald-700" : "text-red-700"}`}
          >
            {purchaseMsg.text}
          </p>
        )}
      </div>

      {/* ---- Deposit to wallet ---- */}
      <div className="mt-8 border-t border-rbai-border pt-6">
        <h3 className="text-sm font-semibold text-rbai-text">
          Deposit to wallet
        </h3>
        {methods.length === 0 ? (
          <div className="mt-3 rounded-xl bg-rbai-bg border border-rbai-border p-5 text-sm text-rbai-text-light">
            Manual payments coming soon — contact us.
          </div>
        ) : depositRefCode ? (
          <div className="mt-4 rounded-xl bg-emerald-50 border border-emerald-200 p-5">
            <p className="text-sm font-semibold text-emerald-800">
              Deposit claim submitted — thank you.
            </p>
            <p className="text-sm text-emerald-700 mt-1">
              Our team will verify your payment and credit your wallet.
            </p>
            <p className="text-sm text-emerald-700 mt-3">
              Include this reference in your payment note:
            </p>
            <p className="mt-1 font-mono text-lg font-bold text-emerald-900 tracking-wide">
              {depositRefCode}
            </p>
          </div>
        ) : (
          <form onSubmit={onDeposit} className="mt-4 space-y-4">
            <div>
              <label htmlFor="deposit-method" className={labelClass}>
                Payment method
              </label>
              <select
                id="deposit-method"
                value={methodId}
                onChange={(e) => setMethodId(e.target.value as ManualMethodId)}
                className={inputClass}
              >
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="deposit-amount" className={labelClass}>
                Amount (USD)
              </label>
              <input
                id="deposit-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
                placeholder="e.g. 50"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="deposit-txn" className={labelClass}>
                Transaction ID / hash ID
              </label>
              <input
                id="deposit-txn"
                type="text"
                value={txnId}
                onChange={(e) => setTxnId(e.target.value)}
                placeholder="e.g. bank reference no. or crypto transaction hash"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="deposit-shot" className={labelClass}>
                Payment screenshot
              </label>
              <input
                id="deposit-shot"
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={onFileChange}
                className="block w-full text-sm text-rbai-text-light file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-rbai-primary file:text-white hover:file:opacity-90"
              />
              {previewUrl && (
                <Image
                  src={previewUrl}
                  alt="Payment screenshot preview"
                  width={320}
                  height={240}
                  className="mt-3 max-h-48 w-auto rounded-lg border border-rbai-border"
                />
              )}
            </div>
            {depositError && (
              <p className="text-sm text-red-700">{depositError}</p>
            )}
            <button
              type="submit"
              disabled={depositing}
              className="w-full rounded-lg bg-rbai-primary text-white font-medium py-2.5 px-4 text-sm hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {depositing ? "Submitting…" : "Submit deposit claim"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
