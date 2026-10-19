import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import ContactBody from "./body";

const SITE_URL = "https://ai.ridebangla.bd";

export const metadata: Metadata = {
  title: "Contact Us — Ride Bangla AI Agent",
  description:
    "যোগাযোগ করুন — Questions, payment issues or feedback? Contact the Ride Bangla AI Agent support team by form, email, phone or hotline.",
  alternates: { canonical: SITE_URL + "/contact" },
  openGraph: {
    title: "Contact Us — Ride Bangla AI Agent",
    description:
      "Questions, payment issues or feedback? Contact the Ride Bangla AI Agent support team.",
    url: SITE_URL + "/contact",
    siteName: "Ride Bangla AI Agent",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Contact Us — Ride Bangla AI Agent",
    description:
      "Questions, payment issues or feedback? Contact the Ride Bangla AI Agent support team.",
  },
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      {/* Header — same as the marketing site */}
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
            <a href="/#how" className="hover:text-slate-900">How it works</a>
            <a href="/#features" className="hover:text-slate-900">Features</a>
            <a href="/#pricing" className="hover:text-slate-900">Pricing</a>
            <a href="/#faq" className="hover:text-slate-900">FAQ</a>
            <Link href="/contact" className="text-slate-900 font-medium">Contact</Link>
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
      <section className="bg-[#0F172A] text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold">
            যোগাযোগ করুন <span className="text-slate-400 font-medium">/ Contact Us</span>
          </h1>
          <p className="text-slate-300 mt-3 max-w-xl mx-auto">
            প্রশ্ন, পেমেন্ট সমস্যা বা মতামত — নিচের ফর্মটি পূরণ করুন, আমাদের টিম
            শীঘ্রই উত্তর দেবে। / Questions, payment issues or feedback — fill in
            the form below and our team will get back to you.
          </p>
        </div>
      </section>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <ContactBody />
      </main>

      {/* Footer — same as the marketing site */}
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
            <span className="text-xs text-slate-400">by Ride Bangla</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-500">
            <Link href="/signup" className="hover:text-slate-900">Sign up</Link>
            <Link href="/login" className="hover:text-slate-900">Log in</Link>
            <Link href="/contact" className="hover:text-slate-900">Contact</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
            <a href="https://ridebangla.bd" className="hover:text-slate-900">
              ridebangla.bd
            </a>
          </div>
          <p className="text-xs text-slate-400">
            © {new Date().getFullYear()} Ride Bangla Limited. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
