/**
 * /p/[slug] — public auto-generated landing page for businesses WITHOUT
 * their own website (user decision 8).
 *
 * Thin shell: loads the landing data (fail-closed), builds the SEO meta,
 * and hands off to the premium themed renderer (theme-page.tsx). All
 * visual design lives in the theme system (`src/lib/landing-themes.ts`).
 *
 * Visibility rule (fail-closed): only `landingPublished` pages render —
 * anything else is a 404.
 */

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { getLandingData, buildLandingMeta, type PublicLandingData } from "@/lib/landing";
import { ThemeLandingPage } from "./theme-page";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

async function load(slug: string): Promise<PublicLandingData> {
  const data = await getLandingData(slug);
  if (!data || !data.business.landingPublished) notFound();
  return data;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const data = await getLandingData(slug);
  if (!data || !data.business.landingPublished) return { title: "Page not found" };
  const meta = buildLandingMeta(data);
  return {
    title: meta.title,
    description: meta.description,
    openGraph: {
      title: meta.ogTitle,
      description: meta.ogDescription,
      ...(meta.ogImage ? { images: [{ url: meta.ogImage }] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: meta.ogTitle,
      description: meta.ogDescription,
      ...(meta.ogImage ? { images: [meta.ogImage] } : {}),
    },
  };
}

export default async function LandingPage({ params }: PageProps) {
  const { slug } = await params;
  const data = await load(slug);

  // Absolute origin for the widget assets (works behind Vercel/proxy).
  const headerList = await headers();
  const host =
    headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "ai.ridebangla.bd";
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const origin = `${proto}://${host}`;
  const widgetSrc = `${origin}/widget/ride-bangla-chat.js`;

  return <ThemeLandingPage data={data} origin={origin} widgetSrc={widgetSrc} />;
}
