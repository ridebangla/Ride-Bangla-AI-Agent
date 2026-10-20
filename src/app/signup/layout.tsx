import type { Metadata } from "next";
import { TRIAL_DAYS } from "@/lib/plans";

const SITE_URL = "https://ai.ridebangla.bd";

// The signup page is a client component and cannot export metadata, so its
// unique SEO metadata lives in this server layout.
export const metadata: Metadata = {
  title: "Sign up free — Ride Bangla AI Agent",
  description: `Start your ${TRIAL_DAYS}-day free trial of Ride Bangla AI Agent — AI customer support and WhatsApp / Facebook / Instagram automation for your business. No credit card required.`,
  alternates: { canonical: SITE_URL + "/signup" },
  openGraph: {
    title: "Sign up free — Ride Bangla AI Agent",
    description: `Start your ${TRIAL_DAYS}-day free trial. No credit card required — our team sets everything up for you.`,
    url: SITE_URL + "/signup",
    siteName: "Ride Bangla AI Agent",
    type: "website",
    images: [
      {
        url: SITE_URL + "/agent-avatar.png",
        width: 680,
        height: 680,
        alt: "Ride Bangla AI Agent",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sign up free — Ride Bangla AI Agent",
    description: `Start your ${TRIAL_DAYS}-day free trial. No credit card required.`,
    images: [SITE_URL + "/agent-avatar.png"],
  },
};

export default function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
