/**
 * landing-copy.ts — Phase 2: rule-based copy generation for auto landing pages.
 *
 * The generator builds every text block on a hosted landing page from the
 * business's own data (name, description, catalog, knowledge base). No fake
 * data is ever invented: when information is missing, the copy degrades to
 * honest generic phrasing ("Contact us for details").
 *
 * OPENAI UPGRADE SEAM (Phase 3): `refineCopyWithAI()` is the single place
 * where an LLM pass plugs in. It checks `process.env.OPENAI_API_KEY` and
 * gracefully falls back to the rule-based text when the key is absent —
 * never hardcode keys; the key lives only in the environment.
 */

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

/**
 * LLM refinement seam. When `OPENAI_API_KEY` is set, Phase 3 may call the
 * model here to polish the rule-based copy; until then (and whenever the
 * key is missing) the input is returned unchanged — the page always works.
 *
 * NOTE: no key is ever hardcoded. `process.env.OPENAI_API_KEY` only.
 */
export async function refineCopyWithAI(
  copy: LandingCopy,
  _businessName: string
): Promise<LandingCopy> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Graceful fallback: rule-based copy is the production path today.
    return copy;
  }
  // Phase 3 upgrade point: send `copy` + business context to the model and
  // return the polished result. Kept as an explicit no-op-plus-hook so the
  // rule-based path stays the tested, working default.
  return copy;
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
