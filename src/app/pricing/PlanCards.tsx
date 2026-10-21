"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import {
  PLAN_META,
  TRIAL_DAYS,
  isPaidPlanId,
  type PaidPlanId,
  type BillingInterval,
} from "@/lib/plans";
import type { CatalogPlanView } from "@/lib/plan-catalog";

// Pricing doctrine (user decision 2026-10-19): ALL-IN-ONE — every plan
// includes the COMPLETE platform (AI agent, Facebook automation,
// website/landing-page builder, order handling). Plans differ by
// VOLUME/LIMITS only. The lead engine is a coming module: listed as
// included/coming, never claimed as live.
const PLATFORM_INCLUDED = "Full platform: AI agent, Facebook automation, website builder, order handling";
const LEAD_ENGINE = "Lead engine — coming soon, included";
const TRIAL_LINE = `${TRIAL_DAYS}-day free trial — no credit card`;

/** The messages feature line — dynamic from the plan's messagesPerMonth. */
function messagesLine(messagesPerMonth: number): string {
  return `${messagesPerMonth.toLocaleString("en-US")} AI messages / month`;
}

// Code-plan feature copy, split around the (now dynamic) messages line.
// The lines themselves are the pre-existing hardcoded copy — unchanged.
const CODE_FEATURES: Record<PaidPlanId, { pre: string[]; post: string[] }> = {
  starter: {
    pre: [TRIAL_LINE, PLATFORM_INCLUDED, LEAD_ENGINE, "1 website widget + 1 social channel"],
    post: ["50 products · 1 landing page · 1 seat", "Email support"],
  },
  growth: {
    pre: [TRIAL_LINE, PLATFORM_INCLUDED, LEAD_ENGINE, "1 website widget + 3 social channels"],
    post: ["500 products · 3 landing pages · 3 seats", "Priority support"],
  },
  pro: {
    pre: [TRIAL_LINE, PLATFORM_INCLUDED, LEAD_ENGINE, "1 website widget + all social channels"],
    post: ["Unlimited products · 10 landing pages · 10 seats", "Dedicated support"],
  },
};

const PAID_CARDS: {
  id: PaidPlanId;
  desc: string;
  cta: string;
  popular?: boolean;
}[] = [
  { id: "starter", desc: PLAN_META.starter.tagline, cta: "Choose Starter" },
  { id: "growth", desc: PLAN_META.growth.tagline, popular: true, cta: "Choose Growth" },
  { id: "pro", desc: PLAN_META.pro.tagline, cta: "Choose Pro" },
];

const TRIAL_FEATURES = [
  `${TRIAL_DAYS}-day free trial — no credit card`,
  "Full AI agent — every feature unlocked",
  "1 website chat widget",
  "All social channels",
  "1,000 AI conversations",
  "No credit card required",
];

interface OfferInfo {
  name: string;
  /** ISO string. */
  endsAt: string;
  effectivePriceUsd: number;
  regularPriceUsd: number;
}

interface CardModel {
  id: string;
  name: string;
  desc: string;
  cta: string;
  popular?: boolean;
  features: string[];
  messagesPerMonth: number;
  monthlyPriceUsd: number;
  yearlyPriceUsd: number;
  monthlyOffer: OfferInfo | null;
  yearlyOffer: OfferInfo | null;
}

/** Legacy cards: exactly today's rendering, from the code catalog. */
function legacyCards(): CardModel[] {
  return PAID_CARDS.map((c) => ({
    id: c.id,
    name: PLAN_META[c.id].name,
    desc: c.desc,
    cta: c.cta,
    popular: c.popular,
    features: [
      ...CODE_FEATURES[c.id].pre,
      messagesLine(PLAN_META[c.id].messagesPerMonth),
      ...CODE_FEATURES[c.id].post,
    ],
    messagesPerMonth: PLAN_META[c.id].messagesPerMonth,
    monthlyPriceUsd: PLAN_META[c.id].priceUsd,
    yearlyPriceUsd: PLAN_META[c.id].yearlyPriceUsd,
    monthlyOffer: null,
    yearlyOffer: null,
  }));
}

/**
 * Cards from the server-fetched effective catalog view-model. Code plans
 * keep their existing feature lists (messages line dynamic); panel-created
 * plans render ONLY the lines built from admin-entered data (name,
 * tagline, prices, messagesPerMonth) plus the component's already-existing
 * shared lines (trial line, platform-included line, lead-engine line) —
 * no invented feature copy.
 */
function viewCards(plans: CatalogPlanView[]): CardModel[] {
  return plans.map((p) => {
    const code = isPaidPlanId(p.id) ? p.id : null;
    const features = code
      ? [
          ...CODE_FEATURES[code].pre,
          messagesLine(p.messagesPerMonth),
          ...CODE_FEATURES[code].post,
        ]
      : [TRIAL_LINE, PLATFORM_INCLUDED, LEAD_ENGINE, messagesLine(p.messagesPerMonth)];
    return {
      id: p.id,
      name: p.name,
      desc: p.tagline,
      cta: `Choose ${p.name}`,
      popular: code === "growth",
      features,
      messagesPerMonth: p.messagesPerMonth,
      monthlyPriceUsd: p.monthly.regularPriceUsd,
      yearlyPriceUsd: p.yearly.regularPriceUsd,
      monthlyOffer: p.monthly.offer,
      yearlyOffer: p.yearly.offer,
    };
  });
}

// Feature comparison table (code plans only — its rows carry code-plan
// limits that panel-created plans have no data for). `true` = included,
// `false` = not included, string = a specific limit/value shown.
// All-in-one doctrine: the table differentiates on LIMITS, not features.
function compareRows(cards: CardModel[]): { label: string; values: (boolean | string)[] }[] {
  // Per-code-plan limit values (pre-existing copy), keyed by plan id so a
  // deactivated code plan simply drops its column.
  const byPlan = (table: Record<string, string>) =>
    cards.map((c) => table[c.id] ?? "—");
  const allTrue = cards.map(() => true);
  return [
    { label: `${TRIAL_DAYS}-day free trial (no credit card)`, values: allTrue },
    { label: "AI agent — the complete platform", values: allTrue },
    { label: "Facebook automation", values: allTrue },
    { label: "Website / landing-page builder", values: allTrue },
    { label: "Order handling + advance payments", values: allTrue },
    { label: "Lead engine", values: cards.map(() => "Coming soon") },
    { label: "Social channels", values: byPlan({ starter: "1", growth: "3", pro: "All" }) },
    {
      label: "AI messages / month",
      values: cards.map((c) => c.messagesPerMonth.toLocaleString("en-US")),
    },
    { label: "Products", values: byPlan({ starter: "50", growth: "500", pro: "Unlimited" }) },
    { label: "Landing pages", values: byPlan({ starter: "1", growth: "3", pro: "10" }) },
    { label: "Seats", values: byPlan({ starter: "1", growth: "3", pro: "10" }) },
    { label: "Support", values: byPlan({ starter: "Email", growth: "Priority", pro: "Dedicated" }) },
  ];
}

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

/**
 * PlanCards — the interactive pricing section: Free Trial card + paid
 * cards with a Monthly/Yearly toggle + comparison table.
 *
 * The Free Trial is a SEPARATE card ($0, trial-only) whose CTA goes only to
 * /signup. Paid-card CTAs go to /billing for THAT plan + interval (checkout),
 * never to the trial flow — no shared/confused state between trial and
 * Starter. Prices come from the shared plan catalog so they can never drift
 * from what checkout actually charges.
 *
 * When the server passes the effective catalog view-model (`plans` prop),
 * names/taglines/prices/message allowances come from it (panel-driven),
 * and a live offer renders as: offer price prominent, regular price
 * struck through, the offer's own name + its end date. Without the prop,
 * rendering is exactly the code catalog, as before.
 */
export default function PlanCards({ plans }: { plans?: CatalogPlanView[] }) {
  const router = useRouter();
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  const cards = plans ? viewCards(plans) : legacyCards();
  const codeOnly = cards.length > 0 && cards.every((c) => isPaidPlanId(c.id));

  const offerFor = (card: CardModel) =>
    interval === "yearly" ? card.yearlyOffer : card.monthlyOffer;
  const regularFor = (card: CardModel) =>
    interval === "yearly" ? card.yearlyPriceUsd : card.monthlyPriceUsd;
  const displayPrice = (card: CardModel) =>
    offerFor(card)?.effectivePriceUsd ?? regularFor(card);
  const monthlyEquiv = (card: CardModel) =>
    ((offerFor(card)?.effectivePriceUsd ?? card.yearlyPriceUsd) / 12).toFixed(2);
  // The "2 months free" yearly framing is only claimed when the plan's
  // yearly price really is 10x its monthly price.
  const twoMonthsFree = (card: CardModel) =>
    card.yearlyPriceUsd === card.monthlyPriceUsd * 10;

  // Paid plan CTA → checkout for THAT plan + interval. The pick is saved to
  // localStorage too, so it survives the login/signup redirect for visitors
  // who don't have an account yet (/billing reads it on load).
  const choosePaidPlan = (id: string) => {
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

      {/* Plan cards: Free Trial + paid plans */}
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

          {cards.map((plan) => {
            const offer = offerFor(plan);
            return (
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
                <h2 className="font-semibold text-lg">{plan.name}</h2>
                <p className="mt-3">
                  <span className="text-4xl font-bold">
                    ${fmtPrice(displayPrice(plan))}
                  </span>
                  {offer && (
                    <span className="text-lg text-slate-500 line-through ml-2">
                      ${fmtPrice(regularFor(plan))}
                    </span>
                  )}
                  <span className="text-slate-700 text-sm">
                    {interval === "yearly" ? " / year" : " / month"}
                  </span>
                </p>
                {offer && (
                  <p className="mt-1.5 text-sm">
                    <span className="font-semibold text-emerald-700">
                      {offer.name}
                    </span>{" "}
                    <span className="text-slate-700">
                      ends {fmtEnds(offer.endsAt)}
                    </span>
                  </p>
                )}
                {interval === "yearly" && twoMonthsFree(plan) && (
                  <p className="mt-1.5 text-sm">
                    <span className="inline-block rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold px-2.5 py-0.5">
                      2 months free
                    </span>{" "}
                    <span className="text-slate-700">
                      — just ${monthlyEquiv(plan)}/mo
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
            );
          })}
        </div>
        <p className="text-center text-sm text-slate-700 mt-8">
          Every paid plan starts with the same {TRIAL_DAYS}-day free trial — no
          credit card. Prices in USD — billed monthly, or yearly with 2 months
          free.
        </p>
      </section>

      {/* Comparison table (code plans — its rows carry code-plan limits) */}
      {codeOnly && (
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
                  {cards.map((p) => (
                    <th key={p.id} className="py-4 px-5 text-sm font-bold text-center">
                      {p.name}
                      <span className="block text-xs font-normal text-slate-700 mt-0.5">
                        ${fmtPrice(displayPrice(p))}
                        {interval === "yearly" ? "/yr" : "/mo"}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareRows(cards).map((row, i) => (
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
            {cards.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => choosePaidPlan(p.id)}
                className="text-center rounded-lg border border-slate-300 text-slate-700 font-medium py-2.5 px-6 text-sm hover:border-[#4A7C9B] hover:text-[#4A7C9B] transition-colors"
              >
                Choose {p.name}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
