"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2 } from "lucide-react";
import { PAID_PLANS, PLAN_META, type PaidPlanId } from "@/lib/plans";

interface BillingActionsProps {
  subscriptionStatus: string;
  plan: string;
  isActive: boolean;
  billingConfigured: boolean;
  /** True when the viewer's role may move money (settings:update). */
  canPay: boolean;
}

/**
 * BillingActions — the interactive half of /billing (client component).
 * Calls the real Stripe wiring (/api/billing/checkout, /api/billing/portal)
 * and redirects the browser to Stripe. When billing is not configured yet,
 * renders an honest "being connected" note instead of fake buttons.
 */
export default function BillingActions({
  subscriptionStatus,
  plan,
  isActive,
  billingConfigured,
  canPay,
}: BillingActionsProps) {
  const [loadingPlan, setLoadingPlan] = useState<PaidPlanId | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<"success" | "cancelled" | null>(null);
  // The plan the visitor picked on /pricing before signing up (if any).
  const [chosenPlan, setChosenPlan] = useState<string | null>(null);
  // Billing interval picked on /pricing ("monthly" | "yearly"); monthly default.
  const [chosenInterval, setChosenInterval] = useState<"monthly" | "yearly">(
    "monthly"
  );

  // Stripe redirects back here with ?checkout=success|cancelled.
  // /pricing links here with ?plan=<id>&interval=<monthly|yearly>; the URL
  // wins, localStorage (set by /pricing before the login/signup redirect)
  // is the fallback.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("checkout");
    if (q === "success") setNotice("success");
    else if (q === "cancelled") setNotice("cancelled");
    const save = (k: string, v: string) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* storage unavailable */
      }
    };
    const qp = params.get("plan");
    if (qp && (PAID_PLANS as readonly string[]).includes(qp)) {
      setChosenPlan(qp);
      save("rbai-chosen-plan", qp);
    } else {
      try {
        const stored = localStorage.getItem("rbai-chosen-plan");
        if (stored && (PAID_PLANS as readonly string[]).includes(stored)) {
          setChosenPlan(stored);
        }
      } catch {
        /* storage unavailable */
      }
    }
    const qi = params.get("interval");
    if (qi === "yearly" || qi === "monthly") {
      setChosenInterval(qi);
      save("rbai-chosen-interval", qi);
    } else {
      try {
        if (localStorage.getItem("rbai-chosen-interval") === "yearly") {
          setChosenInterval("yearly");
        }
      } catch {
        /* storage unavailable */
      }
    }
  }, []);

  async function startCheckout(selected: PaidPlanId) {
    setError("");
    setLoadingPlan(selected);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: selected, interval: chosenInterval }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Could not start checkout.");
        setLoadingPlan(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Network error. Check your connection and try again.");
      setLoadingPlan(null);
    }
  }

  async function openPortal() {
    setError("");
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Could not open the billing portal.");
        setPortalLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Network error. Check your connection and try again.");
      setPortalLoading(false);
    }
  }

  const isPaidPlan =
    plan === "starter" || plan === "growth" || plan === "pro";
  const showPlanPicker =
    billingConfigured &&
    canPay &&
    (subscriptionStatus === "trialing" ||
      (!isActive && subscriptionStatus !== "past_due"));
  const showPortalButton =
    billingConfigured && canPay && isPaidPlan && isActive;

  return (
    <div>
      {notice === "success" && (
        <div className="mb-6 rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800 flex items-start gap-2.5">
          <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
          <span>
            Payment successful — your subscription is now active and the AI
            agent is running for your business.
          </span>
        </div>
      )}
      {notice === "cancelled" && (
        <div className="mb-6 rounded-xl bg-slate-50 border border-slate-200 p-4 text-sm text-slate-600">
          Checkout was cancelled — no charge was made. Your trial and data are
          untouched.
        </div>
      )}

      {subscriptionStatus === "past_due" && (
        <div className="mb-6 rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
          <p className="font-semibold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Your last payment failed
          </p>
          <p className="mt-1">
            The AI agent keeps running while Stripe retries the payment
            automatically. To fix it now, update your payment method — if
            retries keep failing, the subscription will pause instead of
            charging you unexpectedly.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {!billingConfigured ? (
        /* Honest placeholder: no keys yet, so no fake buttons. */
        <div className="flex items-start gap-4">
          <span className="p-3 rounded-xl bg-rbai-primary-50 text-rbai-primary shrink-0">
            <CreditCard className="h-6 w-6" />
          </span>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-rbai-text">
              {isActive ? "Upgrade or manage payment" : "Reactivate your subscription"}
            </h2>
            <p className="text-sm text-rbai-text-light mt-1">
              Online payments are being connected right now — your{" "}
              {subscriptionStatus === "trialing" ? "trial continues" : "data is kept"}{" "}
              and nothing is lost. Once checkout is live you&apos;ll be able
              to pay securely by card and pick Starter ($19), Growth ($49) or
              Pro ($99) per month.
            </p>
            <p className="text-xs text-rbai-text-light mt-3">
              No payment buttons are shown until real checkout is connected —
              we never fake a payment screen.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-4">
          <span className="p-3 rounded-xl bg-rbai-primary-50 text-rbai-primary shrink-0">
            <CreditCard className="h-6 w-6" />
          </span>
          <div className="flex-1">
            {!canPay ? (
              <>
                <h2 className="text-lg font-semibold text-rbai-text">
                  Billing
                </h2>
                <p className="text-sm text-rbai-text-light mt-1">
                  Only your workspace admin can subscribe or manage payments.
                  Ask an admin to visit this page.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-rbai-text">
                  {subscriptionStatus === "past_due"
                    ? "Fix your payment"
                    : showPortalButton
                      ? "Manage your subscription"
                      : isActive
                        ? "Subscribe to a plan"
                        : "Reactivate your subscription"}
                </h2>
                <p className="text-sm text-rbai-text-light mt-1">
                  {showPortalButton
                    ? "Update your card, change plans, view invoices, or cancel — handled securely by Stripe."
                    : "Secure card checkout by Stripe. We never see or store your card details."}
                </p>

                {showPortalButton && (
                  <button
                    onClick={openPortal}
                    disabled={portalLoading}
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-rbai-primary text-white font-medium py-2.5 px-6 text-sm hover:opacity-90 transition-colors disabled:opacity-50"
                  >
                    {portalLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {portalLoading ? "Opening…" : "Manage subscription"}
                  </button>
                )}

                {subscriptionStatus === "past_due" && (
                  <button
                    onClick={openPortal}
                    disabled={portalLoading}
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-rbai-primary text-white font-medium py-2.5 px-6 text-sm hover:opacity-90 transition-colors disabled:opacity-50"
                  >
                    {portalLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {portalLoading ? "Opening…" : "Update payment method"}
                  </button>
                )}

                {showPlanPicker && (
                  <>
                    <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {PAID_PLANS.map((p) => (
                        <button
                          key={p}
                          onClick={() => startCheckout(p)}
                          disabled={loadingPlan !== null}
                          className={`rounded-xl border p-4 text-left transition-colors disabled:opacity-50 ${
                            plan === p && isActive
                              ? "border-rbai-primary bg-rbai-primary-50"
                              : "border-rbai-border bg-rbai-bg hover:border-rbai-primary"
                          }`}
                        >
                          <span className="flex items-center justify-between">
                            <span className="font-semibold text-rbai-text text-sm">
                              {PLAN_META[p].name}
                            </span>
                            {loadingPlan === p ? (
                              <Loader2 className="h-4 w-4 animate-spin text-rbai-primary" />
                            ) : chosenPlan === p ? (
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-rbai-primary bg-rbai-primary-50 border border-rbai-primary/20 rounded-full px-2 py-0.5">
                                Your pick
                              </span>
                            ) : null}
                          </span>
                          <span className="block mt-1 text-lg font-bold text-rbai-text">
                            $
                            {chosenInterval === "yearly"
                              ? PLAN_META[p].yearlyPriceUsd
                              : PLAN_META[p].priceUsd}
                            <span className="text-xs font-normal text-rbai-text-light">
                              {" "}
                              {chosenInterval === "yearly" ? "/ year" : "/ month"}
                            </span>
                          </span>
                          {chosenInterval === "yearly" && (
                            <span className="block mt-0.5 text-[11px] font-medium text-emerald-700">
                              2 months free
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-rbai-text-light mt-3">
                      {subscriptionStatus === "trialing"
                        ? "Subscribing now ends the trial countdown — the AI keeps running without a pause."
                        : "Reactivating restores the AI agent immediately — your business data was kept."}{" "}
                      <Link href="/pricing" className="text-rbai-primary hover:underline">
                        Compare plans
                      </Link>
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
