/**
 * landing.ts — Phase 2: shared data fetch for auto-generated landing pages.
 *
 * Used by the public SSR route `/p/[slug]` and by GET /api/landing (the
 * dashboard editor + live preview). All reads go through the UNSCOPED
 * client on purpose: this runs before/without a tenant session (public
 * visitors), and the slug lookup is the scoping mechanism — fail-closed
 * (unknown slug => null => 404).
 *
 * Secrets are never exposed: only the public-safe settings fields are
 * returned (businessName, businessDesc, welcomeMessage).
 */

import { getUnscopedPrisma } from "./prisma";
import {
  generateLandingCopy,
  sanitizeBrandColor,
  type LandingCopy,
  type LandingProduct,
  type LandingKnowledge,
} from "./landing-copy";

export interface PublicLandingData {
  business: {
    name: string;
    slug: string;
    siteKey: string;
    tagline: string | null;
    brandColor: string;
    logoUrl: string | null;
    websiteUrl: string | null;
    landingPublished: boolean;
  };
  copy: LandingCopy;
  products: LandingProduct[];
  aboutEntries: LandingKnowledge[];
  hours: Record<string, string> | null;
  contact: {
    welcomeMessage: string;
    whatsappPhone: string | null;
    email: string | null;
  };
}

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export async function getLandingData(slug: string): Promise<PublicLandingData | null> {
  const db = getUnscopedPrisma();

  const business = (await db.business.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      siteKey: true,
      isActive: true,
      tagline: true,
      brandColor: true,
      logoUrl: true,
      websiteUrl: true,
      landingPublished: true,
    },
  })) as null | {
    id: string;
    name: string;
    slug: string;
    siteKey: string;
    isActive: boolean;
    tagline?: string | null;
    brandColor?: string | null;
    logoUrl?: string | null;
    websiteUrl?: string | null;
    landingPublished?: boolean | null;
  };
  if (!business || !business.isActive) return null;

  const [settings, categories, knowledgeEntries, hours] = await Promise.all([
    db.settings.findFirst({
      where: { businessId: business.id },
      select: { businessDesc: true, welcomeMessage: true, whatsappPhone: true, smtpFrom: true },
    }),
    db.productCategory.findMany({
      where: { businessId: business.id },
      include: {
        products: {
          where: { businessId: business.id, isAvailable: true },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
    }),
    db.knowledgeEntry.findMany({
      where: { businessId: business.id, isActive: true },
      include: { category: { select: { name: true } } },
      orderBy: { priority: "desc" },
      take: 8,
    }),
    db.businessHours.findFirst({ where: { businessId: business.id } }),
  ]);

  const products: LandingProduct[] = [];
  for (const cat of categories as Array<{
    name: string;
    products: Array<{
      name: string;
      description?: string | null;
      price?: number | null;
      currency?: string | null;
      imageUrl?: string | null;
    }>;
  }>) {
    for (const p of cat.products ?? []) {
      products.push({
        name: p.name,
        description: p.description ?? null,
        price: p.price ?? null,
        currency: p.currency ?? "BDT",
        imageUrl: p.imageUrl || null,
        categoryName: cat.name,
      });
    }
  }

  const aboutEntries: LandingKnowledge[] = (
    knowledgeEntries as Array<{
      title: string;
      content: string;
      category?: { name?: string } | null;
    }>
  ).map((e) => ({
    title: e.title,
    content: e.content,
    category: e.category?.name ?? null,
  }));

  const brandColor = sanitizeBrandColor(business.brandColor);
  const copy = generateLandingCopy(
    {
      name: business.name,
      tagline: business.tagline ?? null,
      brandColor,
      logoUrl: business.logoUrl ?? null,
      slug: business.slug,
      siteKey: business.siteKey,
      websiteUrl: business.websiteUrl ?? null,
      landingPublished: business.landingPublished ?? false,
    },
    (settings as { businessDesc?: string } | null)?.businessDesc ?? null,
    products,
    aboutEntries
  );

  let hoursMap: Record<string, string> | null = null;
  if (hours && (hours as { enabled?: boolean }).enabled) {
    hoursMap = {};
    for (const day of DAY_KEYS) {
      const v = (hours as Record<string, unknown>)[day];
      if (typeof v === "string" && v.trim()) hoursMap[day] = v.trim();
    }
    if (Object.keys(hoursMap).length === 0) hoursMap = null;
  }

  const s = (settings ?? {}) as {
    welcomeMessage?: string;
    whatsappPhone?: string;
    smtpFrom?: string;
  };

  return {
    business: {
      name: business.name,
      slug: business.slug,
      siteKey: business.siteKey,
      tagline: business.tagline ?? null,
      brandColor,
      logoUrl: business.logoUrl ?? null,
      websiteUrl: business.websiteUrl ?? null,
      landingPublished: business.landingPublished === true,
    },
    copy,
    products,
    aboutEntries,
    hours: hoursMap,
    contact: {
      welcomeMessage: s.welcomeMessage || "Hi! How can we help you today?",
      whatsappPhone: s.whatsappPhone || null,
      email: s.smtpFrom || null,
    },
  };
}
