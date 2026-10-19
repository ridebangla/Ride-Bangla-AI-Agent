import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Check, Minus } from "lucide-react";

export const metadata = {
  title: "Pricing — Ride Bangla AI Agent",
  description:
    "Simple, honest pricing: 10-day free trial, then Starter $19, Growth $49 or Pro $99 per month. Cancel anytime.",
};

const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price: "$19",
    desc: "For small businesses getting started with AI support.",
    cta: "Start free trial",
    features: [
      "10-day free trial — no credit card",
      "1 website chat widget",
      "2 social channels",
      "1,000 AI conversations / month",
      "Product catalog",
      "Email support",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    price: "$49",
    desc: "For growing businesses that live on customer chat.",
    popular: true,
    cta: "Start free trial",
    features: [
      "10-day free trial — no credit card",
      "Everything in Starter",
      "All social channels",
      "10,000 AI conversations / month",
      "Order handling + advance payments",
      "Auto landing-page builder",
      "Priority support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$99",
    desc: "For high-volume businesses and teams.",
    cta: "Start free trial",
    features: [
      "10-day free trial — no credit card",
      "Everything in Growth",
      "Unlimited AI conversations",
      "Team inbox + roles",
      "Advanced analytics",
      "Dedicated support",
    ],
  },
];

// Feature comparison table. `true` = included, `false` = not included,
// string = a specific limit/value shown in the cell.
const COMPARE_ROWS: { label: string; values: (boolean | string)[] }[] = [
  { label: "10-day free trial (no credit card)", values: [true, true, true] },
  { label: "Website chat widget", values: [true, true, true] },
  { label: "Connected channels", values: ["2 social channels", "All social channels", "All social channels"] },
  { label: "AI conversations / month", values: ["1,000", "10,000", "Unlimited"] },
  { label: "Product catalog", values: [true, true, true] },
  { label: "Order handling + advance payments", values: [false, true, true] },
  { label: "Auto landing-page builder", values: [false, true, true] },
  { label: "Team inbox + roles", values: [false, false, true] },
  { label: "Analytics", values: ["Basic", "Advanced", "Advanced"] },
  { label: "Support", values: ["Email", "Priority", "Dedicated"] },
];

const FAQS = [
  {
    q: "Do I need a credit card for the trial?",
    a: "No. The 10-day free trial needs nothing but your business name and email. You only pay if you decide to continue.",
  },
  {
    q: "What happens when my trial ends?",
    a: "The AI agent pauses for your business and your dashboard points you to Billing. Your data is kept — nothing is deleted — and everything resumes the moment you subscribe.",
  },
  {
    q: "How do payments work?",
    a: "Checkout is handled securely by Stripe. We never see or store your card details. You can update your card, change plans, or cancel anytime from the billing portal inside your dashboard.",
  },
  {
    q: "Can I change plans later?",
    a: "Yes. Upgrade, downgrade, or cancel from Billing in your dashboard at any time — changes apply from your next billing cycle.",
  },
  {
    q: "Is there an annual plan?",
    a: "Monthly billing for now. Annual plans with a discount are coming — contact us if you'd like one and we'll set it up for you.",
  },
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

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      {/* Nav */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/agent-avatar.png"
              alt="Ride Bangla AI Agent"
              width={36}
              height={36}
              className="rounded-lg"
            />
            <span className="font-bold text-lg">Ride Bangla AI Agent</span>
          </Link>
          <nav className="flex items-center gap-4 sm:gap-6 text-sm">
            <Link href="/#how" className="hidden sm:inline text-slate-600 hover:text-slate-900">
              How it works
            </Link>
            <Link href="/login" className="text-slate-600 hover:text-slate-900">
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-[#4A7C9B] text-white font-medium px-4 py-2 text-sm hover:bg-[#2D5A7B] transition-colors"
            >
              Start free trial
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 pt-16 pb-8 text-center">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          Simple, honest pricing
        </h1>
        <p className="text-slate-500 mt-4 text-lg max-w-2xl mx-auto">
          Start free for 10 days. Then pick the plan that fits — cancel anytime,
          keep your data either way.
        </p>
      </section>

      {/* Plan cards */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
        <div className="grid md:grid-cols-3 gap-6 items-stretch">
          {PLANS.map((plan) => (
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
                <span className="text-4xl font-bold">{plan.price}</span>
                <span className="text-slate-500 text-sm"> / month</span>
              </p>
              <p className="text-sm text-slate-500 mt-2">{plan.desc}</p>
              <ul className="mt-6 space-y-2.5 text-sm text-slate-600 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href={`/signup?plan=${plan.id}`}
                className={`mt-8 text-center rounded-lg font-medium py-3 text-sm transition-colors ${
                  plan.popular
                    ? "bg-[#4A7C9B] text-white hover:bg-[#2D5A7B]"
                    : "border border-slate-300 text-slate-700 hover:border-[#4A7C9B] hover:text-[#4A7C9B]"
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
        <p className="text-center text-sm text-slate-500 mt-8">
          Every plan starts with the same 10-day free trial — no credit card.
          Prices in USD, billed monthly.
        </p>
      </section>

      {/* Comparison table */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 py-14">
        <h2 className="text-3xl font-bold text-center">Compare plans</h2>
        <p className="text-slate-500 text-center mt-3">
          Everything your AI agent can do, side by side.
        </p>
        <div className="mt-10 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="py-4 px-5 text-sm font-semibold text-slate-500 w-[46%]">
                  Feature
                </th>
                {PLANS.map((p) => (
                  <th key={p.id} className="py-4 px-5 text-sm font-bold text-center">
                    {p.name}
                    <span className="block text-xs font-normal text-slate-500 mt-0.5">
                      {p.price}/mo
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
          {PLANS.map((p) => (
            <Link
              key={p.id}
              href={`/signup?plan=${p.id}`}
              className="text-center rounded-lg border border-slate-300 text-slate-700 font-medium py-2.5 px-6 text-sm hover:border-[#4A7C9B] hover:text-[#4A7C9B] transition-colors"
            >
              Choose {p.name}
            </Link>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-slate-50 border-y border-slate-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20">
          <h2 className="text-3xl font-bold text-center">Pricing questions</h2>
          <div className="mt-10 space-y-4">
            {FAQS.map((f) => (
              <div key={f.q} className="bg-white border border-slate-200 rounded-xl p-6">
                <h3 className="font-semibold">{f.q}</h3>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[#0F172A] text-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center">
          <h2 className="text-3xl font-bold">Never miss another customer message</h2>
          <p className="text-slate-300 mt-4">
            Join the 10-day free trial and let your AI agent handle tonight&apos;s
            customers while you sleep.
          </p>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 mt-8 rounded-lg bg-[#4A7C9B] text-white font-medium px-8 py-3.5 hover:bg-[#2D5A7B] transition-colors"
          >
            Start free trial <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="text-xs text-slate-400 mt-4">
            No credit card · Set up in minutes · Cancel anytime
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/agent-avatar.png"
              alt="Ride Bangla AI Agent"
              width={28}
              height={28}
              className="rounded-lg"
            />
            <span className="font-semibold text-slate-700">Ride Bangla AI Agent</span>
          </Link>
          <div className="flex items-center gap-6">
            <Link href="/" className="hover:text-slate-900">Home</Link>
            <Link href="/signup" className="hover:text-slate-900">Sign up</Link>
            <Link href="/login" className="hover:text-slate-900">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
