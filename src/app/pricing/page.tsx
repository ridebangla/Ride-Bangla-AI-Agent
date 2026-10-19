import Link from "next/link";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
import PlanCards from "./PlanCards";
import { TRIAL_DAYS } from "@/lib/plans";

export const metadata = {
  title: "Pricing — Ride Bangla AI Agent",
  description:
    "Simple, honest pricing: ${TRIAL_DAYS}-day free trial, then Starter $19, Growth $49 or Pro $99 per month — or yearly with 2 months free. Cancel anytime.",
};

const FAQS = [
  {
    q: "Do I need a credit card for the trial?",
    a: `No. The ${TRIAL_DAYS}-day free trial needs nothing but your business name and email. You only pay if you decide to continue.`,
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
    a: "Yes — switch to Yearly on this page and you pay for 10 months but get 12 (2 months free). Starter $190/year, Growth $490/year, Pro $990/year.",
  },
];

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
          Start free for {TRIAL_DAYS} days. Then pick the plan that fits —
          cancel anytime, keep your data either way.
        </p>
      </section>

      {/* Plan cards + comparison (client: Monthly/Yearly toggle) */}
      <PlanCards />

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
            Join the {TRIAL_DAYS}-day free trial and let your AI agent handle
            tonight&apos;s customers while you sleep.
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
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
