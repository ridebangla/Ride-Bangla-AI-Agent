import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifySessionToken } from "@/lib/auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getSubscription, TRIAL_DAYS } from "@/lib/subscription";
import { isBillingConfigured, PLAN_META, isPaidPlanId } from "@/lib/stripe";
import BillingActions from "./BillingActions";
import ManualPay from "./ManualPay";
import WalletBilling from "./WalletBilling";
import { getPublicManualPaymentMethods } from "@/lib/manual-payments";
import { getWallet } from "@/lib/wallet";
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  Crown,
  Hourglass,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Billing — Ride Bangla AI Agent",
  robots: { index: false, follow: false },
};

const PLAN_LABEL: Record<string, string> = {
  trial: "Free Trial",
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  super_admin: "Super Admin",
  unknown: "—",
};

const PLAN_PRICE_MONTHLY: Record<string, string> = {
  trial: `$0 for ${TRIAL_DAYS} days`,
  starter: "$19 / month",
  growth: "$49 / month",
  pro: "$99 / month",
};

/** Price line for the current plan + billing interval (yearly = 2 months free). */
function planPriceLine(plan: string, billingInterval: string | null): string {
  if (plan === "trial") return PLAN_PRICE_MONTHLY.trial;
  if (isPaidPlanId(plan) && billingInterval === "yearly") {
    return `$${PLAN_META[plan].yearlyPriceUsd} / year · 2 months free`;
  }
  return PLAN_PRICE_MONTHLY[plan] ?? "";
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BillingPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("rbai-token")?.value;
  const payload = token ? await verifySessionToken(token) : null;
  if (!payload) redirect("/login");

  const admin = await getUnscopedPrisma().admin.findUnique({
    where: { id: payload.userId },
    select: { businessId: true, name: true, email: true, role: true },
  });
  if (!admin) redirect("/login");

  const sub = await getSubscription(admin.businessId);
  const isSuperAdmin = admin.businessId === null;
  // Money moves only for tenant admins (mirrors the "settings:update"
  // permission required by /api/billing/checkout and /api/billing/portal).
  const canPay = admin.role === "admin";
  const billingConfigured = isBillingConfigured();
  // Manual payment methods (Phase 4b) — read via the Admin SDK (server
  // side, bypasses Firestore rules); only ENABLED methods are returned.
  // The reference code lets the team match an incoming bank/crypto
  // transfer to this claim: business slug + timestamp.
  const manualMethods = !isSuperAdmin ? await getPublicManualPaymentMethods() : [];
  let manualReference = "";
  if (!isSuperAdmin && admin.businessId) {
    const biz = await getUnscopedPrisma().business.findUnique({
      where: { id: admin.businessId },
      select: { slug: true },
    });
    const slug = biz?.slug || admin.businessId.slice(0, 8);
    manualReference = `${slug}-${Date.now().toString(36)}`;
  }
  // Wallet balance (Billing Phase 2) — server-side read via the Admin SDK;
  // getWallet never throws (zero-balance default on failure).
  const wallet =
    !isSuperAdmin && admin.businessId
      ? await getWallet(admin.businessId)
      : { balanceCents: 0 };

  return (
    <div className="min-h-screen bg-rbai-bg">
      <header className="border-b border-rbai-border bg-rbai-surface">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Image
              src="/agent-avatar.png"
              alt="Ride Bangla AI Agent"
              width={36}
              height={36}
              className="rounded-lg"
            />
            <span className="font-bold text-rbai-text">Ride Bangla AI Agent</span>
          </Link>
          {!isSuperAdmin && sub.isActive && (
            <Link
              href="/dashboard"
              className="text-sm text-rbai-primary font-medium hover:underline"
            >
              Back to dashboard
            </Link>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold text-rbai-text">Billing</h1>
        <p className="text-rbai-text-light text-sm mt-1">
          Your plan, trial status and payments — always truthful, straight from
          your subscription record.
        </p>

        {isSuperAdmin ? (
          <div className="mt-8 bg-rbai-surface border border-rbai-border rounded-2xl p-8 text-center">
            <span className="inline-flex p-4 rounded-2xl bg-amber-50 text-amber-600">
              <Crown className="h-8 w-8" />
            </span>
            <h2 className="text-lg font-semibold text-rbai-text mt-4">
              Super Admin
            </h2>
            <p className="text-sm text-rbai-text-light mt-2 max-w-md mx-auto">
              Platform administrators are never billed. Subscription checks do
              not apply to this account.
            </p>
            <Link
              href="/dashboard"
              className="inline-block mt-6 rounded-lg bg-rbai-primary text-white font-medium py-2.5 px-6 text-sm hover:opacity-90 transition-colors"
            >
              Go to dashboard
            </Link>
          </div>
        ) : (
          <>
            {/* Status card */}
            <div className="mt-8 bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-xs uppercase tracking-wide text-rbai-text-light font-medium">
                    Current plan
                  </p>
                  <h2 className="text-2xl font-bold text-rbai-text mt-1">
                    {PLAN_LABEL[sub.plan] ?? sub.plan}
                  </h2>
                  <p className="text-sm text-rbai-text-light mt-1">
                    {planPriceLine(sub.plan, sub.billingInterval)}
                  </p>
                </div>
                {sub.isActive ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-3.5 py-1.5 text-sm font-medium">
                    <BadgeCheck className="h-4 w-4" /> Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 text-red-700 border border-red-200 px-3.5 py-1.5 text-sm font-medium">
                    <AlertTriangle className="h-4 w-4" /> Expired
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
                <div className="rounded-xl bg-rbai-bg border border-rbai-border p-4 flex items-start gap-3">
                  <span className="p-2 rounded-lg bg-rbai-primary-50 text-rbai-primary">
                    <Hourglass className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-xs text-rbai-text-light font-medium">
                      Trial days remaining
                    </p>
                    <p className="text-xl font-bold text-rbai-text mt-0.5">
                      {sub.subscriptionStatus === "trialing"
                        ? `${sub.trialDaysRemaining} day${sub.trialDaysRemaining === 1 ? "" : "s"}`
                        : "—"}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl bg-rbai-bg border border-rbai-border p-4 flex items-start gap-3">
                  <span className="p-2 rounded-lg bg-rbai-primary-50 text-rbai-primary">
                    <CalendarClock className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-xs text-rbai-text-light font-medium">
                      {sub.subscriptionStatus === "trialing"
                        ? "Trial ends"
                        : "Status"}
                    </p>
                    <p className="text-xl font-bold text-rbai-text mt-0.5">
                      {sub.subscriptionStatus === "trialing"
                        ? formatDate(sub.trialEndsAt)
                        : sub.subscriptionStatus.replace(/_/g, " ")}
                    </p>
                  </div>
                </div>
              </div>

              {!sub.isActive && (
                <div className="mt-6 rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-800">
                  Your free trial has ended, so the AI agent is paused for your
                  business. Reactivate below to turn it back on — your business
                  data is kept and nothing is deleted.
                </div>
              )}
            </div>

            {/* Payments — real Stripe wiring (Phase 4). The client
                component calls /api/billing/checkout and /api/billing/portal;
                when Stripe keys are absent it says so honestly instead of
                rendering fake buttons. */}
            <div className="mt-6 bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
              <BillingActions
                subscriptionStatus={sub.subscriptionStatus}
                plan={sub.plan}
                isActive={sub.isActive}
                billingConfigured={billingConfigured}
                canPay={canPay}
              />
            </div>

            {/* Manual payments — bank transfer / crypto / WeChat Pay
                (Phase 4b). Rendered from the user-configured methods; when
                none are enabled it says so honestly. */}
            <div className="mt-6">
              <ManualPay
                methods={manualMethods}
                defaultPlan={isPaidPlanId(sub.plan) ? sub.plan : "growth"}
                reference={manualReference}
                canPay={canPay}
              />
            </div>

            {/* Wallet — top up the balance, then pay for plans from it
                (Billing Phase 2). */}
            <div className="mt-6">
              <WalletBilling
                balanceCents={wallet.balanceCents}
                defaultPlan={isPaidPlanId(sub.plan) ? sub.plan : "growth"}
                defaultInterval={
                  sub.billingInterval === "yearly" ? "yearly" : "monthly"
                }
                methods={manualMethods}
                canPay={canPay}
              />
            </div>

            <p className="text-xs text-rbai-text-light mt-6 text-center">
              Questions about billing? Contact us through your dashboard.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
