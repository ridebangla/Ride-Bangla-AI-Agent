import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifySessionToken } from "@/lib/auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getSubscription } from "@/lib/subscription";
import { TRIAL_DAYS } from "@/lib/plans";
import ReviewsSection from "@/components/marketing/reviews-section";
import {
  ArrowRight,
  Bot,
  Check,
  Camera,
  Clock,
  Globe,
  MessageCircle,
  MessagesSquare,
  Phone,
  Send,
  Share2,
  ShoppingBag,
  Sparkles,
  UserCheck,
  Zap,
} from "lucide-react";

export const dynamic = "force-dynamic";


const SOFTWARE_APP_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Ride Bangla AI Agent",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://ai.ridebangla.bd",
  image: "https://ai.ridebangla.bd/agent-avatar.png",
  description:
    "AI customer-service agent SaaS for businesses: 24/7 instant chat support, WhatsApp/Facebook/Instagram/Telegram automation, website & landing-page builder, product catalog, order handling, and a lead engine — one subscription, everything included.",
  offers: {
    "@type": "Offer",
    price: "19",
    priceCurrency: "USD",
    description: "Plans from $19/month. First month free, no credit card.",
  },
  provider: {
    "@type": "Organization",
    name: "Ride Bangla",
    url: "https://ridebangla.bd",
  },
};

// Root: logged-out visitors see the SaaS marketing landing page; logged-in
// users go to their dashboard (or /billing when their trial/subscription is
// inactive). The middleware leaves `/` (exact) public so this page can decide.
export default async function RootPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("rbai-token")?.value;
  if (token) {
    const payload = await verifySessionToken(token);
    if (payload) {
      const admin = await getUnscopedPrisma().admin.findUnique({
        where: { id: payload.userId },
        select: { businessId: true },
      });
      if (admin) {
        if (admin.businessId) {
          const sub = await getSubscription(admin.businessId);
          if (!sub.isActive) redirect("/billing");
        }
        redirect("/dashboard");
      }
    }
  }
  // The reviews section needs the platform's own public siteKey; resolve it
  // server-side (logged-out visitors never authenticate).
  let reviewsSiteKey: string | null = null;
  try {
    const biz = await getUnscopedPrisma().business.findUnique({
      where: { slug: "ride-bangla" },
      select: { siteKey: true },
    });
    reviewsSiteKey = biz?.siteKey ?? null;
  } catch {
    reviewsSiteKey = null;
  }
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(SOFTWARE_APP_JSON_LD),
        }}
      />
      <MarketingLanding reviewsSiteKey={reviewsSiteKey} />
    </>
  );
}

const STEPS = [
  {
    icon: Globe,
    title: "Connect your business",
    desc: "Give us your website URL, paste some text, upload a file, or answer a short guided Q&A — whichever is easiest.",
  },
  {
    icon: Sparkles,
    title: "The AI learns",
    desc: "Your agent studies your products, prices, hours, policies and FAQs, building its own knowledge base and catalog.",
  },
  {
    icon: MessagesSquare,
    title: "It talks to your customers",
    desc: "24/7 instant replies on your website, WhatsApp, Facebook, Instagram and Telegram — like your best employee, always on.",
  },
];

const FEATURES = [
  {
    icon: MessagesSquare,
    title: "Every channel, one agent",
    desc: "Website chat widget, WhatsApp, Facebook, Instagram and Telegram — customers reach you wherever they already are.",
  },
  {
    icon: ShoppingBag,
    title: "Product catalog",
    desc: "The AI knows your products and prices, shows rich product cards in chat, and helps customers choose.",
  },
  {
    icon: Zap,
    title: "Order handling",
    desc: "Takes orders conversationally — including advance-payment flows — and hands everything to you neatly organized.",
  },
  {
    icon: Phone,
    title: "Photos, voice & video",
    desc: "Customers can send photos, voice notes and videos. The AI understands them and can match photos to your catalog.",
  },
  {
    icon: UserCheck,
    title: "Human takeover anytime",
    desc: "Flip one switch and the AI goes fully silent — customers talk directly to you. Flip it back and the AI resumes, reading the full history.",
  },
  {
    icon: Bot,
    title: "Keeps every customer",
    desc: "Trained to never let a customer walk away: instant answers, smart alternatives when something is unavailable, and warm follow-ups.",
  },
];

const PLANS = [
  {
    name: "Starter",
    price: "$19",
    desc: "For small businesses getting started with AI support.",
    features: ["1 website widget + 1 social channel", "1,000 AI messages / month", "Product catalog", "Email support"],
  },
  {
    name: "Growth",
    price: "$49",
    desc: "For growing businesses that live on customer chat.",
    features: ["Everything in Starter", "3 social channels", "5,000 AI messages / month", "Order handling + advance payments", "Priority support"],
    popular: true,
  },
  {
    name: "Pro",
    price: "$99",
    desc: "For high-volume businesses and teams.",
    features: ["Everything in Growth", "All social channels", "15,000 AI messages / month", "Team inbox + roles", "Advanced analytics", "Dedicated support"],
  },
];

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
    q: "I'm not technical. Can I still use this?",
    a: "Yes. Setup is a guided wizard: paste your website URL or answer a few questions, review what the AI learned, and you're live. No code, no integrations to configure yourself.",
  },
  {
    q: "Who owns my business data?",
    a: "You do. Your knowledge base, catalog, customers and conversations belong to your business and are isolated per tenant.",
  },
];

function MarketingLanding({ reviewsSiteKey }: { reviewsSiteKey: string | null }) {
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
          <nav className="hidden md:flex items-center gap-8 text-sm text-slate-600">
            <a href="#how" className="hover:text-slate-900">How it works</a>
            <a href="#features" className="hover:text-slate-900">Features</a>
            <a href="#pricing" className="hover:text-slate-900">Pricing</a>
            <a href="#reviews" className="hover:text-slate-900">Reviews</a>
            <a href="#faq" className="hover:text-slate-900">FAQ</a>
            <Link href="/contact" className="hover:text-slate-900">Contact</Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm font-medium text-slate-700 hover:text-slate-900"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="text-sm font-medium bg-[#4A7C9B] text-white rounded-lg px-4 py-2 hover:bg-[#2D5A7B] transition-colors"
            >
              Start free trial
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-[#0F172A] text-white">
        <div
          className="absolute inset-0 opacity-30"
          style={{
            background:
              "radial-gradient(700px circle at 15% 20%, #4A7C9B 0%, transparent 60%), radial-gradient(600px circle at 85% 80%, #2D5A7B 0%, transparent 60%)",
          }}
        />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 py-20 lg:py-28 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/15 px-4 py-1.5 text-sm text-slate-200">
              <Clock className="h-4 w-4 text-[#A8D0E6]" />
              {TRIAL_DAYS}-day free trial · No credit card required
            </span>
            <h1 className="text-4xl sm:text-5xl font-bold leading-tight mt-6">
              Your AI customer-service agent that{" "}
              <span className="text-[#A8D0E6]">never sleeps</span>
            </h1>
            <p className="text-slate-300 text-lg mt-5 max-w-xl">
              Give it your website and it learns your business — products,
              prices, hours, policies. Then it chats with your customers 24/7
              on your website, WhatsApp, Facebook, Instagram and Telegram.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mt-8">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#4A7C9B] text-white font-medium px-7 py-3.5 hover:bg-[#2D5A7B] transition-colors"
              >
                Start free trial <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#how"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/25 text-white font-medium px-7 py-3.5 hover:bg-white/10 transition-colors"
              >
                See how it works
              </a>
            </div>
            <div className="flex items-center gap-6 mt-10 text-sm text-slate-300">
              <span className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-400" /> Set up in minutes
              </span>
              <span className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-400" /> No code needed
              </span>
              <span className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-400" /> Cancel anytime
              </span>
            </div>
          </div>

          {/* Chat illustration */}
          <div className="hidden lg:block">
            <div className="bg-white rounded-2xl shadow-2xl overflow-hidden max-w-md ml-auto">
              <div className="bg-[#4A7C9B] px-5 py-4 flex items-center gap-3">
                <Image
                  src="/agent-avatar.png"
                  alt="AI agent"
                  width={40}
                  height={40}
                  className="rounded-full bg-white"
                />
                <div>
                  <p className="font-semibold text-white text-sm">
                    Dhaka Cake House
                  </p>
                  <p className="text-xs text-white/80 flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 inline-block" />
                    Online — replies instantly
                  </p>
                </div>
              </div>
              <div className="p-5 space-y-3 text-sm">
                <div className="bg-slate-100 rounded-xl rounded-tl-sm px-4 py-2.5 max-w-[80%] text-slate-700">
                  Do you deliver chocolate cake today?
                </div>
                <div className="bg-[#4A7C9B] text-white rounded-xl rounded-tr-sm px-4 py-2.5 max-w-[85%] ml-auto">
                  Yes! Our Chocolate Truffle Cake (1kg) is ৳850 and we deliver
                  within 3 hours inside Dhaka. Shall I place the order for you?
                </div>
                <div className="bg-slate-100 rounded-xl rounded-tl-sm px-4 py-2.5 max-w-[80%] text-slate-700">
                  Yes please, for 6pm today
                </div>
                <div className="bg-[#4A7C9B] text-white rounded-xl rounded-tr-sm px-4 py-2.5 max-w-[85%] ml-auto">
                  Done — order confirmed for 6pm today. You&apos;ll get a
                  confirmation on WhatsApp shortly.
                </div>
              </div>
              <div className="px-5 py-4 border-t border-slate-200 flex items-center gap-2 text-sm text-slate-600">
                <MessageCircle className="h-4 w-4" />
                Powered by Ride Bangla AI Agent
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Channel strip */}
      <section className="border-b border-slate-200 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-slate-700 text-sm font-medium">
          <span className="flex items-center gap-2"><Globe className="h-4 w-4" /> Your website</span>
          <span className="flex items-center gap-2"><MessageCircle className="h-4 w-4" /> WhatsApp</span>
          <span className="flex items-center gap-2"><Share2 className="h-4 w-4" /> Facebook</span>
          <span className="flex items-center gap-2"><Camera className="h-4 w-4" /> Instagram</span>
          <span className="flex items-center gap-2"><Send className="h-4 w-4" /> Telegram</span>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
        <h2 className="text-3xl font-bold text-center">Live in three steps</h2>
        <p className="text-slate-700 text-center mt-3 max-w-2xl mx-auto">
          From signup to your first AI-handled customer conversation in minutes —
          not weeks.
        </p>
        <div className="grid md:grid-cols-3 gap-6 mt-12">
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              className="relative bg-white border border-slate-200 rounded-2xl p-7 hover:shadow-lg transition-shadow"
            >
              <span className="absolute top-5 right-6 text-5xl font-bold text-slate-100">
                {i + 1}
              </span>
              <span className="inline-flex p-3 rounded-xl bg-[#EDF5FA] text-[#4A7C9B]">
                <s.icon className="h-6 w-6" />
              </span>
              <h3 className="font-semibold text-lg mt-4">{s.title}</h3>
              <p className="text-slate-700 text-sm mt-2 leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="bg-slate-50 border-y border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
          <h2 className="text-3xl font-bold text-center">
            Everything a great support team does
          </h2>
          <p className="text-slate-700 text-center mt-3 max-w-2xl mx-auto">
            One AI agent that sells, supports and follows up — across every
            channel your customers use.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-12">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="bg-white border border-slate-200 rounded-2xl p-7 hover:shadow-lg transition-shadow"
              >
                <span className="inline-flex p-3 rounded-xl bg-[#EDF5FA] text-[#4A7C9B]">
                  <f.icon className="h-6 w-6" />
                </span>
                <h3 className="font-semibold text-lg mt-4">{f.title}</h3>
                <p className="text-slate-700 text-sm mt-2 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-7xl mx-auto px-4 sm:px-6 py-20">
        <h2 className="text-3xl font-bold text-center">Simple, honest pricing</h2>
        <p className="text-slate-700 text-center mt-3 max-w-2xl mx-auto">
          Start free for {TRIAL_DAYS} days. Then pick the plan that fits — cancel anytime.
        </p>
        <div className="grid md:grid-cols-3 gap-6 mt-12 items-stretch">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
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
              <h3 className="font-semibold text-lg">{plan.name}</h3>
              <p className="mt-3">
                <span className="text-4xl font-bold">{plan.price}</span>
                <span className="text-slate-700 text-sm"> / month</span>
              </p>
              <p className="text-sm text-slate-700 mt-2">{plan.desc}</p>
              <ul className="mt-6 space-y-2.5 text-sm text-slate-600 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={`mt-8 text-center rounded-lg font-medium py-3 text-sm transition-colors ${
                  plan.popular
                    ? "bg-[#4A7C9B] text-white hover:bg-[#2D5A7B]"
                    : "border border-slate-300 text-slate-700 hover:border-[#4A7C9B] hover:text-[#4A7C9B]"
                }`}
              >
                Start free trial
              </Link>
            </div>
          ))}
        </div>
        <p className="text-center text-sm text-slate-700 mt-8">
          Every plan starts with the same {TRIAL_DAYS}-day free trial — no credit card.
        </p>
      </section>

      {/* FAQ */}
      <section id="faq" className="bg-slate-50 border-y border-slate-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20">
          <h2 className="text-3xl font-bold text-center">Questions, answered</h2>
          <div className="mt-10 space-y-4">
            {FAQS.map((f) => (
              <div key={f.q} className="bg-white border border-slate-200 rounded-xl p-6">
                <h3 className="font-semibold">{f.q}</h3>
                <p className="text-sm text-slate-700 mt-2 leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Reviews */}
      <ReviewsSection siteKey={reviewsSiteKey} />

      {/* CTA */}
      <section className="bg-[#0F172A] text-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center">
          <h2 className="text-3xl font-bold">
            Never miss another customer message
          </h2>
          <p className="text-slate-300 mt-4">
            Join the {TRIAL_DAYS}-day free trial and let your AI agent handle tonight&apos;s
            customers while you sleep.
          </p>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 mt-8 rounded-lg bg-[#4A7C9B] text-white font-medium px-8 py-3.5 hover:bg-[#2D5A7B] transition-colors"
          >
            Start free trial <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="text-xs font-semibold text-slate-300 mt-4">
            No credit card · Set up in minutes · Cancel anytime
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Image
              src="/agent-avatar.png"
              alt="Ride Bangla AI Agent"
              width={28}
              height={28}
              className="rounded-lg"
            />
            <span className="font-semibold text-sm">
              Ride Bangla AI Agent
            </span>
            <span className="text-xs text-slate-600">by Ride Bangla</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-700">
            <Link href="/signup" className="hover:text-slate-900">Sign up</Link>
            <Link href="/login" className="hover:text-slate-900">Log in</Link>
            <Link href="/contact" className="hover:text-slate-900">Contact</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
            <a href="https://ridebangla.bd" className="hover:text-slate-900">
              ridebangla.bd
            </a>
          </div>
          <p className="text-xs text-slate-600">
            © {new Date().getFullYear()} Ride Bangla Limited. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
