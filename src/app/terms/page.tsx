import Link from "next/link";
import Image from "next/image";

export const metadata = {
  title: "Terms & Conditions — Ride Bangla AI Agent",
  description:
    "The terms for using Ride Bangla AI Agent: trial, subscriptions, payments, and acceptable use.",
  alternates: { canonical: "https://ai.ridebangla.bd/terms" },
  openGraph: {
    title: "Terms & Conditions — Ride Bangla AI Agent",
    description:
      "The terms for using Ride Bangla AI Agent: trial, subscriptions, payments, and acceptable use.",
    url: "https://ai.ridebangla.bd/terms",
    siteName: "Ride Bangla AI Agent",
    type: "website",
    images: [
      {
        url: "https://ai.ridebangla.bd/agent-avatar.png",
        width: 1024,
        height: 1024,
        alt: "Ride Bangla AI Agent",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Terms & Conditions — Ride Bangla AI Agent",
    description:
      "The terms for using Ride Bangla AI Agent: trial, subscriptions, payments, and acceptable use.",
    images: ["https://ai.ridebangla.bd/agent-avatar.png"],
  },
};

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: "1. Agreement",
    body: [
      "These Terms & Conditions (\"Terms\") are an agreement between you (\"you\", the business owner) and Ride Bangla, Faridpur, Bangladesh (\"we\", \"us\"), for the use of Ride Bangla AI Agent at ai.ridebangla.bd (\"the Service\"). By creating an account or using the Service, you agree to these Terms and to our Privacy Policy.",
      "If you do not agree, please do not use the Service. Contact: info@ridebangla.bd.",
    ],
  },
  {
    heading: "2. What the Service does",
    body: [
      "The Service gives your business an AI agent that talks to your customers on your website and connected channels (such as WhatsApp, Facebook, Instagram, and X), answers questions from your business knowledge, shows your products, and takes orders. Every plan includes the full platform — website chat, social automation, website/landing-page builder, product catalog, and order handling. Plans differ only by usage limits, never by locking features away.",
    ],
  },
  {
    heading: "3. Free trial",
    body: [
      "Every new business gets its first month free (a 30-day trial) with full access — no credit card required. During the trial you can connect channels, teach the AI about your business, and talk to real customers.",
      "When the trial ends without a paid subscription, the AI agent pauses for your business and your dashboard will point you to Billing. Your data is kept — nothing is deleted — and everything resumes the moment you subscribe.",
    ],
  },
  {
    heading: "4. Subscriptions and pricing",
    body: [
      "Paid plans are Starter ($19/month), Growth ($49/month), and Pro ($99/month), in USD. Yearly billing is available at 10x the monthly price (2 months free): $190, $490, and $990 per year. Prices are shown on the pricing page and may change for new subscriptions; existing subscriptions keep their price until renewal.",
      "Subscriptions are prepaid for each billing period. Each plan includes a monthly allowance of AI replies and connected channels as listed on the pricing page. If you exceed your allowance, the agent pauses new AI replies until the next cycle or until you upgrade — we will always warn you first.",
    ],
  },
  {
    heading: "5. Manual payments",
    body: [
      "We currently accept manual payments: US bank transfer, Binance Pay, Bybit, OKX, and WeChat Pay. To pay, send the amount to the payment details shown on your Billing page, then submit the transaction ID (or hash) together with a screenshot of the payment.",
      "Payments are verify-then-activate: our team checks every payment before your subscription is activated. Most verifications complete within 24 hours. If a payment cannot be verified (wrong amount, unreadable screenshot, or no matching transaction), we will ask you for correction — your subscription starts only after successful verification.",
      "You are responsible for sending the exact amount and for keeping your own proof of payment until activation is confirmed. Payments sent to wrong addresses or with missing references may be delayed or unrecoverable.",
    ],
  },
  {
    heading: "6. Refunds",
    body: [
      "Because every plan starts with a free first month (30-day trial), we encourage you to evaluate the Service before paying. Subscription payments are generally non-refundable once the billing period has started and the Service has been activated.",
      "If you were charged by mistake, paid twice, or never received the Service after a verified payment, write to info@ridebangla.bd within 14 days and we will review your case fairly. Fraudulent payments, chargebacks, or abuse of the refund process will lead to immediate account suspension.",
    ],
  },
  {
    heading: "7. Acceptable use",
    body: [
      "You agree not to use the Service for spam, fraud, harassment, or anything illegal. You are responsible for what your AI agent says to your customers — review its knowledge base and replies, and use the human-takeover switch whenever a conversation needs a person.",
      "You must have the right to use any content you upload (text, images, product photos), and you must not upload personal photos of other people or any content you do not own or have permission to use.",
    ],
  },
  {
    heading: "8. Connected platforms",
    body: [
      "When you connect WhatsApp, Meta (Facebook/Instagram), X, or Google services, you must follow those platforms' own terms and policies (including WhatsApp Business Policy and Meta Platform Terms). Violations on a connected platform — such as spammy messaging — can get your channel or account restricted by that platform, which is outside our control. We may disconnect a channel that puts the Service or other users at risk.",
    ],
  },
  {
    heading: "9. Availability and fair use",
    body: [
      "We work hard to keep the Service running reliably, but we cannot guarantee uninterrupted availability — maintenance, platform outages, or events outside our control may cause downtime. AI features depend on third-party AI providers; if a provider is unavailable, affected features degrade gracefully and resume automatically.",
      "Usage limits in your plan exist so the Service stays fast and affordable for everyone. Abusing the Service (for example, reselling one account's allowance across many businesses) is a violation of these Terms.",
    ],
  },
  {
    heading: "10. Suspension and termination",
    body: [
      "You may cancel your subscription at any time from your Billing page; the Service stays active until the end of the paid period. We may suspend or terminate accounts for non-payment after the trial, for violations of these Terms, or for fraud — with notice where reasonable.",
      "On termination, your business data is handled as described in our Privacy Policy (deletion within 90 days on request). We may keep minimal billing records as required by law.",
    ],
  },
  {
    heading: "11. Liability",
    body: [
      "The Service is provided \"as is\". To the maximum extent permitted by law, Ride Bangla is not liable for indirect or consequential losses, including lost customers or revenue, arising from the use of the Service. Our total liability for any claim is limited to the amount you paid us in the 3 months before the claim.",
    ],
  },
  {
    heading: "12. Changes to these Terms",
    body: [
      "We may update these Terms as the Service grows. We will update the \"Last updated\" date below and notify account owners of significant changes by email or dashboard notice. Continued use of the Service after changes take effect means you accept the updated Terms.",
    ],
  },
  {
    heading: "13. Contact",
    body: [
      "Ride Bangla — Faridpur, Bangladesh. Email: info@ridebangla.bd. Website: ai.ridebangla.bd.",
    ],
  },
];

export default function TermsPage() {
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
            <Link href="/pricing" className="hidden sm:inline text-slate-600 hover:text-slate-900">
              Pricing
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

      {/* Content */}
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-14">
        <h1 className="text-4xl font-bold tracking-tight">Terms &amp; Conditions</h1>
        <p className="text-slate-700 mt-3 text-sm">Last updated: October 19, 2026</p>
        <div className="mt-10 space-y-10">
          {SECTIONS.map((s) => (
            <section key={s.heading}>
              <h2 className="text-xl font-semibold">{s.heading}</h2>
              <div className="mt-3 space-y-3">
                {s.body.map((p, i) => (
                  <p key={i} className="text-slate-600 leading-relaxed text-[15px]">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-700">
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
            <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
