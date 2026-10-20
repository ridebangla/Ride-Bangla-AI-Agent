import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import { ThemeInit } from "@/components/theme-init";
import "./globals.css";

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const SITE_URL = "https://ai.ridebangla.bd";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Ride Bangla AI Agent — AI Customer Support & Social Automation SaaS",
  description:
    "AI customer service agent for businesses: instant 24/7 chat support, WhatsApp / Facebook / Instagram / Telegram automation, and a no-code admin dashboard. Built by Ride Bangla.",
  keywords: [
    "AI customer support",
    "AI chatbot SaaS",
    "customer service AI",
    "WhatsApp automation",
    "Facebook auto reply",
    "Instagram DM automation",
    "Telegram bot for business",
    "AI agent platform",
    "Ride Bangla",
  ],
  alternates: {
    canonical: SITE_URL + "/",
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "Ride Bangla AI Agent — AI Customer Support & Social Automation SaaS",
    description:
      "AI customer service agent for businesses: instant 24/7 chat support, WhatsApp / Facebook / Instagram / Telegram automation, and a no-code admin dashboard.",
    url: SITE_URL + "/",
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
    title: "Ride Bangla AI Agent — AI Customer Support & Social Automation SaaS",
    description:
      "AI customer service agent for businesses: instant 24/7 chat support, WhatsApp / Facebook / Instagram / Telegram automation, and a no-code admin dashboard.",
    images: [SITE_URL + "/agent-avatar.png"],
  },
  manifest: "/manifest.webmanifest",
    icons: {
    // New agent-mascot favicon (multi-size .ico + PNG fallbacks). Brand
    // artwork (agent-avatar.png) is untouched elsewhere on purpose.
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  // GOOGLE SEARCH CONSOLE: set NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION in the
  // Vercel env vars and redeploy — the verification meta tag renders ONLY
  // when the env var is set. Never hardcode a verification code here.
  ...(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
    ? {
        verification: {
          google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
        },
      }
    : {}),
};

const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Ride Bangla",
  url: "https://ridebangla.bd",
  logo: SITE_URL + "/agent-avatar.png",
  sameAs: [
    "https://www.facebook.com/share/g/1CfmiTzv1D/",
    "https://youtube.com/@ridebangla-0",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="h-full">
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(ORGANIZATION_JSON_LD),
            }}
          />
          <Providers>
            <ThemeInit />
            {children}
          </Providers>
        </body>
    </html>
  );
}
