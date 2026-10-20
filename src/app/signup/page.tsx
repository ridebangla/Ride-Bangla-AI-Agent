"use client";

import { useEffect, useState } from "react";
import { TRIAL_DAYS } from "@/lib/plans";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Check,
  Clock,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { GoogleButton } from "@/components/auth/google-button";

const TRIAL_POINTS = [
  `${TRIAL_DAYS}-day free trial — no credit card required`,
  "One-tap Google signup — no long forms, no tech setup",
  "Done-for-you setup: our team connects your channels for you",
  "You never need an API key — we handle all of that",
  "AI learns your business, handles orders and replies 24/7",
];

// Plan names/prices shown when the visitor arrives from /pricing?plan=<id>.
// Read from window.location on mount (no Suspense boundary needed).
const PLAN_INFO: Record<string, { name: string; price: string }> = {
  starter: { name: "Starter", price: "$19/month" },
  growth: { name: "Growth", price: "$49/month" },
  pro: { name: "Pro", price: "$99/month" },
};
const PLAN_INFO_YEARLY: Record<string, { name: string; price: string }> = {
  starter: { name: "Starter", price: "$190/year (2 months free)" },
  growth: { name: "Growth", price: "$490/year (2 months free)" },
  pro: { name: "Pro", price: "$990/year (2 months free)" },
};

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [chosenPlan, setChosenPlan] = useState<string | null>(null);
  const [chosenInterval, setChosenInterval] = useState<"monthly" | "yearly">(
    "monthly"
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const plan = params.get("plan");
    const interval = params.get("interval");
    if (plan && PLAN_INFO[plan]) {
      const yearly = interval === "yearly";
      setChosenPlan(plan);
      setChosenInterval(yearly ? "yearly" : "monthly");
      // Remember the pick so /billing can highlight it after signup.
      try {
        localStorage.setItem("rbai-chosen-plan", plan);
        if (yearly) localStorage.setItem("rbai-chosen-interval", "yearly");
        else localStorage.removeItem("rbai-chosen-interval");
      } catch {
        /* storage unavailable — the signup note already showed the plan */
      }
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Email + password only — no form-filling at signup. The business
      // details come later, inside the dashboard (Done-for-You Setup).
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Signup failed. Please try again.");
        setLoading(false);
        return;
      }
      router.replace("/dashboard");
    } catch {
      setError("Network error. Check your connection and try again.");
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow";

  return (
    <div className="min-h-screen bg-rbai-bg flex">
      {/* Left: brand pitch */}
      <div className="hidden lg:flex w-[44%] flex-col justify-between bg-[#0F172A] text-white p-12 relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            background:
              "radial-gradient(600px circle at 20% 20%, #4A7C9B 0%, transparent 60%), radial-gradient(500px circle at 80% 90%, #2D5A7B 0%, transparent 60%)",
          }}
        />
        <div className="relative">
          <Link href="/" className="flex items-center gap-3">
            <Image
              src="/agent-avatar.png"
              alt="Ride Bangla AI Agent"
              width={44}
              height={44}
              className="rounded-xl"
            />
            <span className="font-bold text-lg">Ride Bangla AI Agent</span>
          </Link>
          <h1 className="text-4xl font-bold leading-tight mt-14">
            Your AI customer-service agent,
            <span className="text-[#A8D0E6]"> working 24/7</span>
          </h1>
          <p className="text-slate-300 mt-4 max-w-md">
            Start your free {TRIAL_DAYS}-day trial today. Sign up in one tap —
            then our team sets everything up for you.
          </p>
          <ul className="mt-8 space-y-3.5">
            {TRIAL_POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm text-slate-200">
                <span className="mt-0.5 rounded-full bg-emerald-500/20 p-1">
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative flex items-center gap-6 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" /> {TRIAL_DAYS}-day free trial
          </span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> No credit card needed
          </span>
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" /> Cancel anytime
          </span>
        </div>
      </div>

      {/* Right: form */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="lg:hidden flex items-center gap-3 mb-8 justify-center">
            <Image
              src="/agent-avatar.png"
              alt="Ride Bangla AI Agent"
              width={40}
              height={40}
              className="rounded-xl"
            />
            <span className="font-bold text-lg text-rbai-text">
              Ride Bangla AI Agent
            </span>
          </div>

          <div className="bg-rbai-surface rounded-2xl shadow-lg border border-rbai-border p-8">
            <div className="mb-7">
              <h2 className="text-2xl font-bold text-rbai-text">
                Start your free trial
              </h2>
              <p className="text-rbai-text-light text-sm mt-1">
                {TRIAL_DAYS} days free. No credit card, no setup forms — after
                you join, our team sets everything up for you.
              </p>
              {chosenPlan && (
                <p className="mt-3 rounded-lg bg-rbai-primary-50 border border-rbai-primary/20 px-3.5 py-2.5 text-sm text-rbai-text">
                  You picked the{" "}
                  <span className="font-semibold">
                    {PLAN_INFO[chosenPlan].name} plan (
                    {(chosenInterval === "yearly" ? PLAN_INFO_YEARLY : PLAN_INFO)[chosenPlan].price})
                  </span>
                  . Your {TRIAL_DAYS}-day free trial starts now — the plan
                  applies when you subscribe from Billing.
                </p>
              )}
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700 mb-5">
                {error}
              </div>
            )}

            {/* Google first — one tap, straight into the dashboard */}
            <GoogleButton
              endpoint="/api/auth/google"
              label="Continue with Google"
              onError={setError}
            />
            <p className="text-xs text-rbai-text-light mt-2.5 text-center">
              গুগল দিয়ে এক ট্যাপে অ্যাকাউন্ট খুলুন — কোনো ফর্ম নেই। / One tap
              with Google — no forms at all.
            </p>

            <div className="flex items-center gap-3 my-6">
              <span className="h-px flex-1 bg-rbai-border" />
              <span className="text-xs text-rbai-text-light">
                or sign up with email
              </span>
              <span className="h-px flex-1 bg-rbai-border" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-rbai-text mb-1.5"
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  placeholder="you@yourbusiness.com"
                />
                <p className="text-xs text-rbai-text-light mt-1.5">
                  This email signs you into your AI Agent dashboard.
                </p>
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-rbai-text mb-1.5"
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                  placeholder="At least 8 characters"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-rbai-primary text-white font-medium py-2.5 text-sm hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Creating your workspace...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <MessagesSquare className="h-4 w-4" />
                    Create account — start free trial
                  </span>
                )}
              </button>
            </form>

            <p className="text-rbai-text text-xs mt-5 font-semibold text-center">
              আপনার কোনো API key লাগবে না — আমাদের টিম সব সেটআপ করে দেবে। /
              You never need an API key — our team sets everything up for you.
            </p>
            <p className="text-rbai-text-light text-xs mt-2 text-center">
              Your password is stored securely by Firebase Authentication and
              never in our database.
            </p>
            <p className="text-rbai-text-light text-sm mt-3 text-center">
              Already have an account?{" "}
              <Link
                href="/login"
                className="text-rbai-primary font-medium hover:underline"
              >
                Log in
              </Link>
            </p>
            <p className="text-rbai-text-light text-xs mt-4 text-center">
              By creating an account, you agree to our{" "}
              <Link href="/terms" className="text-rbai-primary hover:underline">
                Terms &amp; Conditions
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-rbai-primary hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
