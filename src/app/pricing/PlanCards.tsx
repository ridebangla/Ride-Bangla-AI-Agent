"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import {
  PLAN_META,
  TRIAL_DAYS,
  type PaidPlanId,
  type BillingInterval,
} from "@/lib/plans";

// Pricing doctrine (user decision 2026-10-19): ALL-IN-ONE — every plan
// includes the COMPLETE platform (AI agent, Facebook automation,
// website/landing-page builder, order handling). Plans differ by
// VOLUME/LIMITS only. The lead engine is a coming module: listed as
// included/coming, never claimed as live.
const PLATFORM_INCLUDED = "Full platform: AI agent, Facebook automation, website builder, order handling";
const LEAD_ENGINE = "Lead engine — coming soon, included";

const PAID_CARDS: {
  id: PaidPlanId;
  desc: string;
  cta: string;
  popular?: boolean;
  features: string[];
}[] = [
  {
    id: "starter",
    desc: PLAN_META.starter.tagline,
    cta: "Choose Starter",
    features: [
      `${TRIAL_DAYS}-day free trial — no credit card`,
      PLATFORM_INCLUDED,
      LEAD_ENGINE,
      "1 website widget + 1 social channel",
      "1,000 AI messages / month",
      "50 products · 1 landing page · 1 seat",
      "Email support",
    ],
  },
  {
    id: "growth",
    desc: PLAN_META.growth.tagline,
    popular: true,
    cta: "Choose Growth",
    features: [
      `${TRIAL_DAYS}-day free trial — no credit card`,
      PLATFORM_INCLUDED,
      LEAD_ENGINE,
      "1 website widget + 3 social channels",
      "5,000 AI messages / month",
      "500 products · 3 landing pages · 3 seats",
      "Priority support",
    ],
  },
  {
    id: "pro",
    desc: PLAN_META.pro.tagline,
    cta: "Choose Pro",
    features: [
      `${TRIAL_DAYS}-day free trial — no credit card`,
      PLATFORM_INCLUDED,
      LEAD_ENGINE,
      "1 website widget + all social channels",
      "15,000 AI messages / month",
      "Unlimited products · 10 landing pages · 10 seats",
      "Dedicated support",
    ],
  },
];

const TRIAL_FEATURES = [
  `${TRIAL_DAYS}-day free trial — no credit card`,
  "Full AI agent — every feature unlocked",
  "1 website chat widget",
  "All social channels",
  "1,000 AI conversations",
  "No credit card required",
];

// Feature comparison table (paid plans). `true` = included,
// `false` = not included, string = a specific limit/value shown.
// All-in-one doctrine: the table differentiates on LIMITS, not features.
// Facebook automation, the website builder, the AI agent and order handling
// are included (✓) in every plan; the lead engine is honestly marked as
// coming soon (it is not live yet).
const COMPARE_ROWS: { label: string; values: (boolean | string)[] }[] = [
  { label: `${TRIAL_DAYS}-day free trial (no credit card)`, values: [true, true, true] },
  { label: "AI agent — the complete platform", values: [true, true, true] },
  { label: "Facebook automation", values: [true, true, true] },
  { label: "Website / landing-page builder", values: [true, true, true] },
  { label: "Order handling + advance payments", values: [true, true, true] },
  { label: "Lead engine", values: ["Coming soon", "Coming soon", "Coming soon"] },
  { label: "Social channels", values: ["1", "3", "All"] },
  { label: "AI messages / month", values: ["1,000", "5,000", "15,000"] },
  { label: "Products", values: ["50", "500", "Unlimited"] },
  { label: "Landing pages", values: ["1", "3", "10"] },
  { label: "Seats", values: ["1", "3", "10"] },
  { label: "Support", values: ["Email", "Priority", "Dedicated"] },
];

function CompareCell({ value }: { value: boolean | string }) {
  if (value === true)
    return (
      <span className="inline-flex justify-center w-full">
        <Check className="h-5 w-5 text-emerald-500" aria-label="Included" />
      </span>
    );
  if (value === false)
    return (
      <span className="inline-flex justify-center w-full">
        <Minus className="h-5 w-5 text-slate-300" aria-label="Not included" />
      </span>
    );
  return <span className="text-sm text-slate-700 font-medium">{value}</span>;
}

/**
 * PlanCards — the interactive pricing section: Free Trial card + 3 paid
 * cards with a Monthly/Yearly toggle + comparison table.
 *
 * The Free Trial is a SEPARATE card ($0, trial-only) whose CTA goes only to
 * /signup. Paid-card CTAs go to /billing for THAT plan + interval (checkout),
 * never to the trial flow — no shared/confused state between trial and
 * Starter. Prices come from the shared plan catalog so they can never drift
 * from what checkout actually charges.
 */
export default function PlanCards() {
  const router = useRouter();
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  const priceFor = (id: PaidPlanId) =>
    interval === "yearly" ? PLAN_META[id].yearlyPriceUsd : PLAN_META[id].priceUsd;
  const monthlyEquiv = (id: PaidPlanId) =>
    (PLAN_META[id].yearlyPriceUsd / 12).toFixed(2);

  // Paid plan CTA → checkout for THAT plan + interval. The pick is saved to
  // localStorage too, so it survives the login/signup redirect for visitors
  // who don't have an account yet (/billing reads it on load).
  const choosePaidPlan = (id: PaidPlanId) => {
    try {
      localStorage.setItem("rbai-chosen-plan", id);
      localStorage.setItem("rbai-chosen-interval", interval);
    } catch {
      /* storage unavailable — the URL params still carry the choice */
    }
    router.push(`/billing?plan=${id}&interval=${interval}`);
  };

  return (
    <>
      {/* All-in-one doctrine banner */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 text-center">
        <p className="inline-block rounded-full bg-[#F7FBFD] border border-[#4A7C9B]/30 px-5 py-2.5 text-sm text-slate-700">
          <span className="font-semibold text-[#2D5A7B]">All-in-one:</span>{" "}
          every plan includes everything — Facebook automation,
          website/landing-page builder, your own AI agent, lead engine{" "}
          <span className="text-slate-700">(coming soon)</span>. You only
          choose how much volume you need.
        </p>
      </div>

      {/* Billing interval toggle */}
      <div className="flex justify-center mt-2">
        <div
          role="group"
          aria-label="Billing interval"
          className="inline-flex items-center rounded-full border border-slate-300 bg-white p-1"
        >
          {(["monthly", "yearly"] as BillingInterval[]).map((iv) => (
            <button
              key={iv}
              type="button"
              onClick={() => setInterval(iv)}
              aria-pressed={interval === iv}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
                interval === iv
                  ? "bg-[#4A7C9B] text-white"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {iv === "monthly" ? "Monthly" : "Yearly"}
              {iv === "yearly" && (
                <span
                  className={`ml-1.5 text-xs font-semibold ${
                    interval === "yearly" ? "text-white/90" : "text-emerald-600"
                  }`}
                >
                  2 months free
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards: Free Trial + 3 paid plans */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
          {/* Free Trial — its own card, NOT a paid plan. CTA → /signup only. */}
          <div className="relative rounded-2xl border-2 border-dashed border-[#4A7C9B]/50 bg-[#F7FBFD] p-8 flex flex-col">
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#4A7C9B] text-white text-xs font-semibold px-4 py-1 rounded-full">
              Free trial
            </span>
            <h2 className="font-semibold text-lg">Free Trial</h2>
            <p className="mt-3">
              <span className="text-4xl font-bold">$0</span>
              <span className="text-slate-700 text-sm"> / {TRIAL_DAYS} days</span>
            </p>
            <p className="text-sm text-slate-700 mt-2">
              Try everything free for {TRIAL_DAYS} days — no credit card.
            </p>
            <ul className="mt-6 space-y-2.5 text-sm text-slate-600 flex-1">
              {TRIAL_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className="mt-8 text-center rounded-lg font-medium py-3 text-sm bg-[#4A7C9B] text-white hover:bg-[#2D5A7B] transition-colors"
            >
              Start free trial
            </Link>
          </div>

          {PAID_CARDS.map((plan) => (
            <div
              key={plan.id}
              className={`relative rounded-2xl border p-8 flex flex-col ${
                plan.popular
                  ? "border-[#4A7C9B] shadow-xl bg-[#F7FBFD]"
                  : "border-slate-200 bg-white"
              }`}
            >
              {plan.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#4A7C9B] text-white text-xs font-semibold px-4 py-1 rounded-full">
                  Most popular
                </span>
              )}
              <h2 className="font-semibold text-lg">{PLAN_META[plan.id].name}</h2>
              <p className="mt-3">
                <span className="text-4xl font-bold">${priceFor(plan.id)}</span>
                <span className="text-slate-700 text-sm">
                  {interval === "yearly" ? " / year" : " / month"}
                </span>
              </p>
              {interval === "yearly" && (
                <p className="mt-1.5 text-sm">
                  <span className="inline-block rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold px-2.5 py-0.5">
                    2 months free
                  </span>{" "}
                  <span className="text-slate-700">
                    — just ${monthlyEquiv(plan.id)}/mo
                  </span>
                </p>
              )}
              <p className="text-sm text-slate-700 mt-2">{plan.desc}</p>
              <ul className="mt-6 space-y-2.5 text-sm text-slate-600 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => choosePaidPlan(plan.id)}
                className={`mt-8 text-center rounded-lg font-medium py-3 text-sm transition-colors ${
                  plan.popular
                    ? "bg-[#4A7C9B] text-white hover:bg-[#2D5A7B]"
                    : "border border-slate-300 text-slate-700 hover:border-[#4A7C9B] hover:text-[#4A7C9B]"
                }`}
              >
                {plan.cta}
              </button>
            </div>
          ))}
        </div>
        <p className="text-center text-sm text-slate-700 mt-8">
          Every paid plan starts with the same {TRIAL_DAYS}-day free trial — no
          credit card. Prices in USD — billed monthly, or yearly with 2 months
          free.
        </p>
      </section>

      {/* Comparison table (paid plans) */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 py-14">
        <h2 className="text-3xl font-bold text-center">Compare plans</h2>
        <p className="text-slate-700 text-center mt-3">
          Everything your AI agent can do, side by side.
        </p>
        <div className="mt-10 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="py-4 px-5 text-sm font-semibold text-slate-700 w-[46%]">
                  Feature
                </th>
                {PAID_CARDS.map((p) => (
                  <th key={p.id} className="py-4 px-5 text-sm font-bold text-center">
                    {PLAN_META[p.id].name}
                    <span className="block text-xs font-normal text-slate-700 mt-0.5">
                      ${priceFor(p.id)}
                      {interval === "yearly" ? "/yr" : "/mo"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row, i) => (
                <tr
                  key={row.label}
                  className={i % 2 === 1 ? "bg-slate-50/60" : "bg-white"}
                >
                  <td className="py-3.5 px-5 text-sm text-slate-700">{row.label}</td>
                  {row.values.map((v, j) => (
                    <td key={j} className="py-3.5 px-5 text-center">
                      <CompareCell value={v} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
          {PAID_CARDS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => choosePaidPlan(p.id)}
              className="text-center rounded-lg border border-slate-300 text-slate-700 font-medium py-2.5 px-6 text-sm hover:border-[#4A7C9B] hover:text-[#4A7C9B] transition-colors"
            >
              Choose {PLAN_META[p.id].name}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
