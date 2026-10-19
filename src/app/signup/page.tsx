"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Bot,
  Check,
  Clock,
  Globe,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const TRIAL_POINTS = [
  "10-day free trial — no credit card required",
  "AI learns your business from your website or a short Q&A",
  "Chat widget for your website + WhatsApp, Facebook, Instagram, Telegram",
  "Product catalog, order handling and 24/7 customer replies",
];

// Plan names/prices shown when the visitor arrives from /pricing?plan=<id>.
// Read from window.location on mount (no Suspense boundary needed).
const PLAN_INFO: Record<string, { name: string; price: string }> = {
  starter: { name: "Starter", price: "$19/month" },
  growth: { name: "Growth", price: "$49/month" },
  pro: { name: "Pro", price: "$99/month" },
};

export default function SignupPage() {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [chosenPlan, setChosenPlan] = useState<string | null>(null);

  useEffect(() => {
    const plan = new URLSearchParams(window.location.search).get("plan");
    if (plan && PLAN_INFO[plan]) {
      setChosenPlan(plan);
      // Remember the pick so /billing can highlight it after signup.
      try {
        localStorage.setItem("rbai-chosen-plan", plan);
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
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName, email, password, websiteUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Signup failed. Please try again.");
        setLoading(false);
        return;
      }
      router.replace("/onboarding");
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
            Start your free 10-day trial today. Connect your website, let the
            AI learn your business, and never miss a customer message again.
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
            <Clock className="h-3.5 w-3.5" /> 10-day free trial
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
                10 days free. No credit card. Set up in minutes.
              </p>
              {chosenPlan && (
                <p className="mt-3 rounded-lg bg-rbai-primary-50 border border-rbai-primary/20 px-3.5 py-2.5 text-sm text-rbai-text">
                  You picked the{" "}
                  <span className="font-semibold">
                    {PLAN_INFO[chosenPlan].name} plan ({PLAN_INFO[chosenPlan].price})
                  </span>
                  . Your 10-day free trial starts now — the plan applies when
                  you subscribe from Billing.
                </p>
              )}
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="businessName"
                  className="block text-sm font-medium text-rbai-text mb-1.5"
                >
                  Business name
                </label>
                <div className="relative">
                  <Bot className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-rbai-text-light" />
                  <input
                    id="businessName"
                    type="text"
                    required
                    minLength={2}
                    maxLength={100}
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    className={`${inputClass} pl-9`}
                    placeholder="e.g. Dhaka Cake House"
                  />
                </div>
              </div>

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

              <div>
                <label
                  htmlFor="websiteUrl"
                  className="block text-sm font-medium text-rbai-text mb-1.5"
                >
                  Website URL{" "}
                  <span className="font-normal text-rbai-text-light">
                    (optional)
                  </span>
                </label>
                <div className="relative">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-rbai-text-light" />
                  <input
                    id="websiteUrl"
                    type="text"
                    inputMode="url"
                    value={websiteUrl}
                    onChange={(e) => setWebsiteUrl(e.target.value)}
                    className={`${inputClass} pl-9`}
                    placeholder="yourbusiness.com"
                  />
                </div>
                <p className="text-xs text-rbai-text-light mt-1.5">
                  The AI can learn your business from your website during setup.
                </p>
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
                  {error}
                </div>
              )}

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

            <p className="text-rbai-text-light text-xs mt-5 text-center">
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
          </div>
        </div>
      </div>
    </div>
  );
}
