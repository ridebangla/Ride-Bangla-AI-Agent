/**
 * landing-copy.ts — rule-based copy generation for auto landing pages,
 * plus the LLM refinement seam.
 *
 * The generator builds every text block on a hosted landing page from the
 * business's own data (name, description, catalog, knowledge base). No fake
 * data is ever invented: when information is missing, the copy degrades to
 * honest generic phrasing ("Contact us for details").
 *
 * LLM REFINEMENT (premium polish): `refineCopyWithAI()` calls the model
 * when any provider key resolves (per-site `settings.aiKeys` first, then
 * GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY from the environment) and
 * gracefully returns the rule-based input unchanged when no key resolves
 * (or when the call fails) — never hardcode keys; keys live only in the
 * environment or the Admin-SDK-read settings doc, never client-side.
 */

import { LANDING_THEME_IDS, type LandingThemeId } from "./landing-themes";

export interface LandingBusiness {
  name: string;
  tagline?: string | null;
  brandColor?: string | null;
  logoUrl?: string | null;
  slug: string;
  siteKey: string;
  websiteUrl?: string | null;
  landingPublished?: boolean | null;
}

export interface LandingProduct {
  name: string;
  description?: string | null;
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  categoryName?: string | null;
}

export interface LandingKnowledge {
  title: string;
  content: string;
  category?: string | null;
}

export interface LandingCopy {
  tagline: string;
  heroSubtext: string;
  aboutHeading: string;
  aboutText: string;
  productsHeading: string;
  contactHeading: string;
  footerLine: string;
}

/**
 * AI-refined copy overrides persisted on the business doc
 * (`businesses.landingAiCopy`). Only non-empty strings override the
 * rule-based copy at render time (see applyAiCopyOverrides).
 */
export interface LandingAiCopy {
  tagline?: string | null;
  heroSubtext?: string | null;
  aboutHeading?: string | null;
  aboutText?: string | null;
  productsHeading?: string | null;
  contactHeading?: string | null;
  footerLine?: string | null;
  /** Theme the model judged best-fitting for this business type. */
  suggestedTheme?: string | null;
  enhancedAt?: string | null;
}

/** Merge persisted AI overrides over rule-based copy (non-empty wins). */
export function applyAiCopyOverrides(copy: LandingCopy, ai: LandingAiCopy | null | undefined): LandingCopy {
  if (!ai) return copy;
  const pick = (base: string, override?: string | null) =>
    typeof override === "string" && override.trim() ? override.trim() : base;
  return {
    tagline: pick(copy.tagline, ai.tagline),
    heroSubtext: pick(copy.heroSubtext, ai.heroSubtext),
    aboutHeading: pick(copy.aboutHeading, ai.aboutHeading),
    aboutText: pick(copy.aboutText, ai.aboutText),
    productsHeading: pick(copy.productsHeading, ai.productsHeading),
    contactHeading: pick(copy.contactHeading, ai.contactHeading),
    footerLine: pick(copy.footerLine, ai.footerLine),
  };
}

/** First sentence of a text, capped at `max` chars without cutting words. */
function firstSentence(text: string, max = 140): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const m = cleaned.match(/^[^.!?]+[.!?]/);
  const sentence = (m ? m[0] : cleaned).trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim() + "…";
}

/**
 * Rule-based tagline: explicit tagline wins; otherwise the first sentence
 * of the business description; otherwise an honest generic line.
 */
export function generateTagline(
  business: { name: string; tagline?: string | null },
  businessDesc?: string | null
): string {
  const explicit = (business.tagline ?? "").trim();
  if (explicit) return explicit.slice(0, 160);
  const fromDesc = firstSentence(businessDesc ?? "");
  if (fromDesc) return fromDesc;
  return "Quality products and friendly service — chat with us anytime.";
}

export function generateLandingCopy(
  business: LandingBusiness,
  businessDesc: string | null,
  products: LandingProduct[],
  knowledge: LandingKnowledge[]
): LandingCopy {
  const tagline = generateTagline(business, businessDesc);

  // About: prefer knowledge entries from an "about"-ish category, else the
  // highest-priority entries, else the business description.
  const aboutEntry =
    knowledge.find((k) =>
      /about|who we are|our story/i.test(`${k.category ?? ""} ${k.title}`)
    ) ?? knowledge[0];
  const aboutText = aboutEntry
    ? firstSentence(aboutEntry.content, 420)
    : businessDesc
      ? firstSentence(businessDesc, 420)
      : `${business.name} — contact us to learn more about what we offer.`;

  const productCount = products.length;
  const heroSubtext =
    productCount > 0
      ? `Browse our ${productCount} product${productCount === 1 ? "" : "s"} and services below, or start a chat — our AI assistant replies instantly.`
      : "Start a chat below — our AI assistant replies instantly and will help you with whatever you need.";

  return {
    tagline,
    heroSubtext,
    aboutHeading: `About ${business.name}`,
    aboutText,
    productsHeading: "Our Products & Services",
    contactHeading: "Get in Touch",
    footerLine: `© ${new Date().getFullYear()} ${business.name}. All rights reserved.`,
  };
}

/* ------------------------------------------------------------------ */
/* LLM refinement seam                                                 */
/* ------------------------------------------------------------------ */

/** Context given to the model so it can write business-specific copy. */
export interface AICopyContext {
  businessName: string;
  businessDesc?: string | null;
  tagline?: string | null;
  brandColor?: string | null;
  products: Array<{
    name: string;
    description?: string | null;
    price?: number | null;
    currency?: string | null;
    categoryName?: string | null;
  }>;
  categories: string[];
  knowledgeTitles: string[];
  currentTheme?: string | null;
}

export interface AIRefineResult {
  copy: LandingCopy;
  /** Theme id the model judged best-fitting, or null. */
  suggestedTheme: LandingThemeId | null;
  /** False whenever the key is missing or the call failed — input returned. */
  aiEnhanced: boolean;
  /** Machine-readable reason when not enhanced: "no-key" | "invalid" | "error". */
  note?: string;
}

const FIELD_CAPS: Record<keyof Omit<LandingCopy, never>, number> = {
  tagline: 160,
  heroSubtext: 220,
  aboutHeading: 80,
  aboutText: 480,
  productsHeading: 60,
  contactHeading: 60,
  footerLine: 120,
};

function cleanField(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return null;
  return v.slice(0, cap);
}

/**
 * Validate + sanitize raw model JSON into a LandingCopy. Pure and
 * unit-tested. Returns null when the payload is unusable (caller then
 * falls back to the rule-based input).
 */
export function sanitizeAiCopyResult(
  raw: unknown,
  fallback: LandingCopy
): { copy: LandingCopy; suggestedTheme: LandingThemeId | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const copy: LandingCopy = { ...fallback };
  let touched = 0;
  (Object.keys(FIELD_CAPS) as Array<keyof typeof FIELD_CAPS>).forEach((k) => {
    const v = cleanField(r[k], FIELD_CAPS[k]);
    if (v) {
      copy[k] = v;
      touched += 1;
    }
  });
  if (touched === 0) return null;
  const st = typeof r.suggestedTheme === "string" ? r.suggestedTheme.trim() : "";
  const suggestedTheme = (LANDING_THEME_IDS as readonly string[]).includes(st)
    ? (st as LandingThemeId)
    : null;
  return { copy, suggestedTheme };
}

const AI_SYSTEM_PROMPT = `You are a senior landing-page copywriter for small businesses in Bangladesh. Rewrite the provided draft copy so it sounds premium, warm, and specific — never generic.

Hard rules:
- Use ONLY facts present in the business data. Never invent prices, addresses, phone numbers, awards, years in business, or customer claims.
- Keep the same meaning and language as the draft (if the draft is in Bengali, write in Bengali).
- Return ONLY a JSON object with exactly these keys: tagline, heroSubtext, aboutHeading, aboutText, productsHeading, contactHeading, footerLine, suggestedTheme.
- suggestedTheme must be one of: modern-minimal, bold-color, elegant-serif, dark-premium. Pick the one that best fits the business type (e.g. bakery/sweets -> elegant-serif or bold-color; tech/gadgets -> bold-color or dark-premium; fashion/boutique -> elegant-serif; general store/services -> modern-minimal; premium/luxury -> dark-premium).
- Respect the length caps: tagline <= 160 chars, heroSubtext <= 220, aboutText <= 480, headings <= 80.`;

function buildAiUserPrompt(copy: LandingCopy, ctx: AICopyContext): string {
  const productLines = ctx.products.slice(0, 24).map((p) => {
    const price = p.price != null ? ` (${p.currency || "BDT"} ${p.price})` : "";
    const cat = p.categoryName ? ` [${p.categoryName}]` : "";
    return `- ${p.name}${price}${cat}`;
  });
  return [
    `Business: ${ctx.businessName}`,
    ctx.tagline ? `Current tagline: ${ctx.tagline}` : "",
    ctx.businessDesc ? `Description: ${ctx.businessDesc.slice(0, 600)}` : "",
    ctx.categories.length ? `Categories: ${ctx.categories.join(", ")}` : "",
    productLines.length ? `Products:\n${productLines.join("\n")}` : "Products: none listed yet",
    ctx.knowledgeTitles.length ? `Knowledge topics: ${ctx.knowledgeTitles.slice(0, 10).join(", ")}` : "",
    "",
    "Draft copy to rewrite:",
    JSON.stringify(copy),
    "",
    "Return the improved copy as JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * LLM refinement seam. When any AI provider key resolves (the site's own
 * dedicated keys first, shared env keys as fallback — see
 * src/lib/ai/providers.ts resolveSiteKeys), the model rewrites the
 * rule-based copy, picks the best-fitting theme, and tailors section
 * headings — all grounded strictly in the business's own data. When no key
 * resolves (or anything fails), the input is returned unchanged so the
 * page always renders beautifully from the premium template.
 *
 * Providers are tried in AI_PROVIDER_PRIORITY order (default
 * groq,gemini,openai) with failover. The second argument accepts the
 * legacy `businessName: string` form for backwards compatibility.
 *
 * NOTE: no key is ever hardcoded. Keys come only from the environment or
 * the business's Firestore settings (Admin-SDK read, never client-side).
 */
export async function refineCopyWithAI(
  copy: LandingCopy,
  context?: AICopyContext | string
): Promise<AIRefineResult> {
  // Dynamic import keeps this module's static graph client-safe (it is
  // also imported by the public theme renderer).
  const { completeWithFallback, hasAnyProviderKey, resolveSiteKeys } =
    await import("./ai/providers");
  const keys = await resolveSiteKeys().catch(() => null);
  if (!hasAnyProviderKey(keys)) {
    // Graceful fallback: rule-based copy + template is the production path.
    return { copy, suggestedTheme: null, aiEnhanced: false, note: "no-key" };
  }
  const ctx: AICopyContext =
    typeof context === "string"
      ? { businessName: context, products: [], categories: [], knowledgeTitles: [] }
      : (context ?? { businessName: "", products: [], categories: [], knowledgeTitles: [] });

  try {
    const completion = await completeWithFallback(
      {
        messages: [
          { role: "system", content: AI_SYSTEM_PROMPT },
          { role: "user", content: buildAiUserPrompt(copy, ctx) },
        ],
        temperature: 0.7,
        maxTokens: 1000,
        jsonMode: true,
      },
      { keys: keys ?? undefined, label: "landing-refine" }
    );
    if (!completion) {
      return { copy, suggestedTheme: null, aiEnhanced: false, note: "no-key" };
    }
    const parsed = JSON.parse(completion.text) as unknown;
    const sane = sanitizeAiCopyResult(parsed, copy);
    if (!sane) {
      return { copy, suggestedTheme: null, aiEnhanced: false, note: "invalid" };
    }
    return { copy: sane.copy, suggestedTheme: sane.suggestedTheme, aiEnhanced: true };
  } catch {
    // Any failure (network, timeout, bad JSON, all providers down) ->
    // graceful fallback.
    return { copy, suggestedTheme: null, aiEnhanced: false, note: "error" };
  }
}

/** Sanitize a brand color to a safe #rrggbb hex, falling back to teal. */
export function sanitizeBrandColor(input: unknown): string {
  const fallback = "#0B7A55";
  if (typeof input !== "string") return fallback;
  const hex = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return (
      "#" +
      hex
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    ).toUpperCase();
  }
  return fallback;
}
