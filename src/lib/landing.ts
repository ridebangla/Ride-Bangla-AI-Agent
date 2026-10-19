/**
 * landing.ts — shared data fetch for auto-generated landing pages.
 *
 * Used by the public SSR route `/p/[slug]` and by GET /api/landing (the
 * dashboard editor + live preview). All reads go through the UNSCOPED
 * client on purpose: this runs before/without a tenant session (public
 * visitors), and the slug lookup is the scoping mechanism — fail-closed
 * (unknown slug => null => 404).
 *
 * Secrets are never exposed: only the public-safe settings fields are
 * returned (businessName, businessDesc, welcomeMessage).
 *
 * Premium polish: resolves the business's visual theme
 * (`businesses.landingTheme`, falling back to the AI suggestion, then the
 * default) and merges persisted AI copy overrides (`landingAiCopy`) over
 * the rule-based copy.
 */

import { getUnscopedPrisma } from "./prisma";
import {
  generateLandingCopy,
  sanitizeBrandColor,
  applyAiCopyOverrides,
  type LandingAiCopy,
  type LandingCopy,
  type LandingProduct,
  type LandingKnowledge,
} from "./landing-copy";
import { sanitizeLandingTheme, LANDING_THEME_IDS, DEFAULT_LANDING_THEME, type LandingThemeId } from "./landing-themes";

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
  /** Resolved visual theme id (owner choice > AI suggestion > default). */
  theme: LandingThemeId;
  /** The model's theme suggestion, when one was recorded (advisory). */
  aiSuggestedTheme: LandingThemeId | null;
  copy: LandingCopy;
  products: LandingProduct[];
  /** Products grouped for beautiful category sections. */
  productGroups: { categoryName: string; products: LandingProduct[] }[];
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
      landingTheme: true,
      landingAiCopy: true,
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
    landingTheme?: string | null;
    landingAiCopy?: LandingAiCopy | null;
  };
  if (!business || !business.isActive) return null;

  const [settings, categories, uncategorized, knowledgeEntries, hours] = await Promise.all([
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
    db.product.findMany({
      where: { businessId: business.id, categoryId: null, isAvailable: true },
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
  const productGroups: { categoryName: string; products: LandingProduct[] }[] = [];
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
    const group: LandingProduct[] = [];
    for (const p of cat.products ?? []) {
      const item: LandingProduct = {
        name: p.name,
        description: p.description ?? null,
        price: p.price ?? null,
        currency: p.currency ?? "BDT",
        imageUrl: p.imageUrl || null,
        categoryName: cat.name,
      };
      products.push(item);
      group.push(item);
    }
    if (group.length > 0) productGroups.push({ categoryName: cat.name, products: group });
  }
  // Products without a category still deserve a shelf — grouped under
  // "More items" instead of being invisible.
  const loose = (
    uncategorized as Array<{
      name: string;
      description?: string | null;
      price?: number | null;
      currency?: string | null;
      imageUrl?: string | null;
    }>
  ).map((p) => ({
    name: p.name,
    description: p.description ?? null,
    price: p.price ?? null,
    currency: p.currency ?? "BDT",
    imageUrl: p.imageUrl || null,
    categoryName: null,
  }));
  for (const item of loose) products.push(item);
  if (loose.length > 0) productGroups.push({ categoryName: "More items", products: loose });

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
  const ruleCopy = generateLandingCopy(
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

  // Premium polish: AI-refined copy overrides (persisted via "Enhance with
  // AI" in the dashboard) win over the rule-based text, field by field.
  const aiCopy = (business.landingAiCopy ?? null) as LandingAiCopy | null;
  const copy = applyAiCopyOverrides(ruleCopy, aiCopy);
  const rawSuggestion =
    aiCopy && typeof aiCopy.suggestedTheme === "string" ? aiCopy.suggestedTheme.trim() : "";
  const aiSuggestedTheme = (LANDING_THEME_IDS as readonly string[]).includes(rawSuggestion)
    ? (rawSuggestion as LandingThemeId)
    : null;
  // Owner's explicit theme choice wins; otherwise the AI suggestion (if the
  // business ever ran "Enhance with AI"); otherwise the default theme.
  const theme =
    typeof business.landingTheme === "string" && business.landingTheme.trim()
      ? sanitizeLandingTheme(business.landingTheme)
      : (aiSuggestedTheme ?? DEFAULT_LANDING_THEME);

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
    theme,
    aiSuggestedTheme,
    copy,
    products,
    productGroups,
    aboutEntries,
    hours: hoursMap,
    contact: {
      welcomeMessage: s.welcomeMessage || "Hi! How can we help you today?",
      whatsappPhone: s.whatsappPhone || null,
      email: s.smtpFrom || null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* SEO meta (shared by the page's generateMetadata and the quality gate) */
/* ------------------------------------------------------------------ */

export interface LandingMeta {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string | null;
  canonicalPath: string;
}

/**
 * Build the per-page SEO meta from landing data. The public page and
 * `checkLandingQuality()` both use this so the gate verifies exactly what
 * visitors (and crawlers) receive.
 */
export function buildLandingMeta(data: PublicLandingData): LandingMeta {
  const description =
    data.copy.tagline ||
    `${data.business.name} — chat with us anytime.`;
  return {
    title: `${data.business.name} — ${data.copy.tagline}`,
    description,
    ogTitle: data.business.name,
    ogDescription: description,
    ogImage: data.business.logoUrl,
    canonicalPath: `/p/${data.business.slug}`,
  };
}
