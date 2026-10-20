import Link from "next/link";
import Image from "next/image";

export const metadata = {
  title: "Privacy Policy — Ride Bangla AI Agent",
  description:
    "How Ride Bangla AI Agent collects, uses, and protects your data.",
  alternates: { canonical: "https://ai.ridebangla.bd/privacy" },
  openGraph: {
    title: "Privacy Policy — Ride Bangla AI Agent",
    description:
      "How Ride Bangla AI Agent collects, uses, and protects your data.",
    url: "https://ai.ridebangla.bd/privacy",
    siteName: "Ride Bangla AI Agent",
    type: "website",
    images: [
      {
        url: "https://ai.ridebangla.bd/agent-avatar.png",
        width: 680,
        height: 680,
        alt: "Ride Bangla AI Agent",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Privacy Policy — Ride Bangla AI Agent",
    description:
      "How Ride Bangla AI Agent collects, uses, and protects your data.",
    images: ["https://ai.ridebangla.bd/agent-avatar.png"],
  },
};

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: "1. Who we are",
    body: [
      "Ride Bangla AI Agent (\"the Service\") is operated by Ride Bangla, based in Faridpur, Bangladesh. The Service is available at ai.ridebangla.bd and helps businesses handle customer conversations across their website and social channels with an AI agent.",
      "If you have any question about this policy, contact us at info@ridebangla.bd.",
    ],
  },
  {
    heading: "2. Data we collect",
    body: [
      "Account data: when you sign up we collect your name, business name, email address, and password (passwords are stored securely by Firebase Authentication and never in our database in readable form).",
      "Business data: the information you give us about your business — website URL, business description, products and prices, business hours, location, contact details, and any text or files you upload so the AI can learn your business.",
      "Conversation data: messages between your AI agent and your customers, including text, images, voice notes, and videos shared in those conversations, plus order details customers place through the agent.",
      "Payment data: when you pay manually (bank transfer, Binance Pay, Bybit, OKX, or WeChat Pay) we collect the transaction ID or hash and the payment screenshot you submit so our team can verify the payment. We never see or store your bank login credentials or exchange passwords.",
      "Usage data: basic technical information such as pages visited, actions taken in the dashboard, device and browser type, and approximate location derived from IP address, used to operate and improve the Service.",
    ],
  },
  {
    heading: "3. How we use your data",
    body: [
      "We use your data only to provide and improve the Service: to create and run your AI agent, to let it answer your customers from your business knowledge, to process subscriptions and verify payments, to provide support, and to keep the Service secure.",
      "We do not sell your personal data. We do not use your customers' conversations to train shared models, and we do not share one business's data with another business.",
    ],
  },
  {
    heading: "4. Where your data is stored",
    body: [
      "Your data is stored in Firebase (Firestore database and Firebase Authentication), operated by Google, on Google Cloud infrastructure. Data may be processed in data centers outside Bangladesh. Backups are kept for operational recovery.",
    ],
  },
  {
    heading: "5. Connected platforms (WhatsApp, Meta, Google)",
    body: [
      "When you connect channels such as WhatsApp, Facebook, Instagram, or X, the Service exchanges messages with those platforms on your behalf. Those platforms process message content under their own privacy policies (WhatsApp Business, Meta, and Google policies respectively). You are responsible for having a lawful basis to let the AI reply to your customers on those channels, and for any consents your local law requires.",
      "If you sign in with a Google account or use Google services through the Service, Google's Privacy Policy applies to Google's own processing of that data.",
    ],
  },
  {
    heading: "6. Cookies",
    body: [
      "We use strictly necessary cookies to keep you signed in (a session token) and to remember preferences such as your dashboard theme. We do not use advertising or cross-site tracking cookies. Your browser settings can block cookies, but the dashboard will not work without the session cookie.",
    ],
  },
  {
    heading: "7. Data retention",
    body: [
      "We keep your account and business data for as long as your account is active. Conversation data is kept so your agent and your team can refer back to it; you can delete conversations from your dashboard. If you close your account, we delete or anonymize your personal data within 90 days, except where we must keep limited records for legal, tax, or fraud-prevention reasons.",
    ],
  },
  {
    heading: "8. Your rights",
    body: [
      "You may ask us at any time to see, correct, export, or delete your personal data by writing to info@ridebangla.bd. We will respond within a reasonable time. Deleting your account also deletes your business's knowledge base, catalog, and conversation history.",
    ],
  },
  {
    heading: "9. Security",
    body: [
      "We protect your data with encrypted connections (HTTPS), Firebase Authentication for sign-in, tenant-isolated database access so one business can never see another's data, and audit logging of sensitive admin actions. No system is perfectly secure, but we work continuously to keep your data safe.",
    ],
  },
  {
    heading: "10. Children's privacy",
    body: [
      "The Service is a business tool and is not directed at children under 13. We do not knowingly collect data from children.",
    ],
  },
  {
    heading: "11. Changes to this policy",
    body: [
      "We may update this policy as the Service grows. When we do, we will update the \"Last updated\" date below and, for significant changes, notify account owners by email or dashboard notice.",
    ],
  },
  {
    heading: "12. Contact",
    body: [
      "Ride Bangla — Faridpur, Bangladesh. Email: info@ridebangla.bd. Website: ai.ridebangla.bd.",
    ],
  },
];

export default function PrivacyPage() {
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
        <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="text-slate-500 mt-3 text-sm">Last updated: October 19, 2026</p>
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
            <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
