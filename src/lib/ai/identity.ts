/**
 * identity.ts — per-business identity resolution + identity fast-path.
 *
 * DOCTRINE (owner 2026-10-24 14:17 + live bug 2026-10-25 ~00:49):
 * a customer who buys a plan gives their business name — the agent CONVERTS
 * into that business, talks about ITS own products and ITS business, and
 * NEVER about Ride Bangla (or any other business) unless the surface IS
 * that business. An unconfigured business gets an honest "not configured
 * yet" answer, never another business's services.
 *
 * PURE MODULE: no imports, no DB, no LLM. The engine wires it in (see
 * ID-02); this file is what the trap-test harness executes directly.
 *
 * SCOPE NOTES (do not widen silently):
 * - NO salesman/closing/client-finding instruction is added here. The
 *   pre-launch audit (PA-03) records that tension as an owner decision;
 *   this fix is identity-only and does not resolve it.
 * - NO prices, plans, or features are stated for the AI Agent product
 *   beyond what the local repo itself evidences (README: an AI
 *   customer-support agent for businesses, Bengali + English, 24/7,
 *   WhatsApp / email / phone channels). The local copy has NO plans
 *   table, so plan/price questions are NOT answered from this module —
 *   the prompt line forbids inventing them. At apply time on fresh HEAD,
 *   pull plan facts from HEAD's plans.ts (or leave them unanswered).
 * - "Portal" mode is EXPLICIT (opts.portal), never inferred from a name
 *   match: a tenant that happens to share a word with the platform name
 *   must never be re-labelled as the platform, and the platform business
 *   must never leak its delivery description into product answers. At
 *   apply time on fresh HEAD, the portal surface must pass portal:true
 *   only for the platform holder business (HEAD's isCompanyBusiness).
 */

export type IdentityMode = "portal" | "tenant" | "unconfigured";

export type IdentityQuestion =
  | "who"
  | "business_name"
  | "services"
  | "are_you_ride_bangla";

export interface BusinessIdentityInput {
  /** Business.name — the name registered at signup (may be null). */
  businessName?: string | null;
  /** Settings.businessName — the tenant-edited display name (may be null). */
  settingsName?: string | null;
  /** True only if a Settings row already existed (not auto-created). */
  settingsExisted: boolean;
  businessDesc?: string | null;
  /** Number of active knowledge entries for this business. */
  knowledgeCount: number;
  /** Number of available catalog items for this business (0 if unknown). */
  catalogCount: number;
  /** Explicit portal-surface flag (see header). Never name-derived. */
  portal?: boolean;
}

export interface BusinessIdentity {
  mode: IdentityMode;
  /** Display name, or "" when no usable name exists (unconfigured). */
  displayName: string;
  /**
   * True when the business has SOMETHING of its own to talk about
   * (description, knowledge, or catalog). False => services answers must
   * be the honest not-set-up-yet path, never invented or borrowed.
   */
  configured: boolean;
}

/** Schema default for Settings.businessName — a sentinel, never a real name. */
const PLACEHOLDER_NAME = "My Business";

function cleanName(value?: string | null): string {
  const v = (value ?? "").trim();
  if (!v || v === PLACEHOLDER_NAME) return "";
  return v;
}

/**
 * Resolve which business the agent speaks as.
 *
 * Priority: portal flag > configured settings name > registered
 * Business.name > unconfigured. A settings name only counts when the row
 * pre-existed: an auto-created row carries the "My Business" default and
 * must never become the spoken identity.
 */
export function resolveBusinessIdentity(
  input: BusinessIdentityInput
): BusinessIdentity {
  if (input.portal) {
    return { mode: "portal", displayName: "Ride Bangla AI Agent", configured: true };
  }
  const fromSettings =
    input.settingsExisted ? cleanName(input.settingsName) : "";
  const displayName = fromSettings || cleanName(input.businessName);
  if (!displayName) {
    return { mode: "unconfigured", displayName: "", configured: false };
  }
  const configured =
    (input.businessDesc ?? "").trim().length > 0 ||
    input.knowledgeCount > 0 ||
    input.catalogCount > 0;
  return { mode: "tenant", displayName, configured };
}

/** "bn" when any Bengali character is present, else "en". */
export function detectIdentityLanguage(text: string): "bn" | "en" {
  return /[\u0980-\u09FF]/.test(text) ? "bn" : "en";
}

/**
 * Normalise for phrase matching: lowercase, strip punctuation (including
 * the Bengali danda), collapse whitespace. "তুমি কি Ride Bangla?" and
 * "tumi ki ride bangla" both become "তুমি কি ride bangla" / plain form.
 */
export function normalizeIdentityText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[?!।.,:;""''"()\[\]—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TRAP_MARKERS = [
  "are you",
  "are u",
  "r u",
  "you are",
  "তুমি কি",
  "আপনি কি",
  "তুমি",
  "আপনি",
];

const BUSINESS_NAME_PHRASES = [
  "তোমার বিজনেসের নাম কি",
  "তোমার বিজনেসের নাম কী",
  "তোমার ব্যবসার নাম কি",
  "তোমার ব্যবসার নাম কী",
  "বিজনেসের নাম কি",
  "বিজনেসের নাম কী",
  "ব্যবসার নাম কি",
  "what is your business name",
  "what is the name of your business",
  "name of your business",
  "your business name",
  "তোমার নাম কি",
  "তোমার নাম কী",
  "what is your name",
  "your name",
];

const SERVICES_PHRASES = [
  "তোমার মূল সার্ভিস গুলো কি কি",
  "তোমার মূল সার্ভিসগুলো কি কি",
  "তোমার মূল সার্ভিস গুলো কী কী",
  "মূল সার্ভিস গুলো কি কি",
  "মূল সার্ভিসগুলো কি কি",
  "তোমার সার্ভিস গুলো কি কি",
  "তোমার সার্ভিসগুলো কি কি",
  "তোমাদের সার্ভিস কি কি",
  "সার্ভিস গুলো কি কি",
  "what are your main services",
  "what services do you offer",
  "what services do you provide",
  "services do you offer",
  "what do you offer",
  "your main services",
];

const WHO_PHRASES = [
  "তুমি কে",
  "কে তুমি",
  "আপনি কে",
  "who are you",
  "what are you",
  "who r u",
];

function containsPhrase(normalized: string, phrases: string[]): boolean {
  return phrases.some((p) => normalized.includes(p));
}

/**
 * Classify an identity question, or null for anything else. The
 * "are you Ride Bangla?" trap is checked FIRST: in the old code it fell
 * through to a prompt that opened with the platform name (pre-launch
 * audit PA-02 / AT-1). Matching is contains-based, so polite wrappers
 * ("আচ্ছা, তুমি কে বলো তো") still hit the fast path.
 */
export function classifyIdentityQuestion(text: string): IdentityQuestion | null {
  const n = normalizeIdentityText(text);
  if (!n) return null;
  if (
    n.includes("ride bangla") &&
    TRAP_MARKERS.some((m) => n.includes(m))
  ) {
    return "are_you_ride_bangla";
  }
  if (containsPhrase(n, BUSINESS_NAME_PHRASES)) return "business_name";
  if (containsPhrase(n, SERVICES_PHRASES)) return "services";
  if (containsPhrase(n, WHO_PHRASES)) return "who";
  return null;
}

export interface IdentityAnswerOptions {
  /** The business's own services, when the caller has them (fixtures /
   * catalog). Never pass another business's services here. */
  services?: string[];
  /** The business's own description; honest fallback for services. */
  businessDesc?: string | null;
}

function listServicesBn(name: string, services: string[]): string {
  return `${name}-এর মূল সার্ভিসগুলো: ${services.join(", ")}।`;
}

function listServicesEn(name: string, services: string[]): string {
  return `${name}'s main services are: ${services.join(", ")}.`;
}

/**
 * Templated fast-path answer. NO LLM call, so no prompt can leak the
 * wrong business into it. Denials name "Ride Bangla" ONLY to deny it;
 * they never enumerate delivery services (ride/food/courier/grocery).
 */
export function answerIdentityQuestion(
  question: IdentityQuestion,
  identity: BusinessIdentity,
  lang: "bn" | "en",
  opts: IdentityAnswerOptions = {}
): string {
  const bn = lang === "bn";
  const services = (opts.services ?? []).map((s) => s.trim()).filter(Boolean);
  const desc = (opts.businessDesc ?? "").trim();

  if (identity.mode === "portal") {
    const product = "Ride Bangla AI Agent";
    switch (question) {
      case "who":
        return bn
          ? `আমি ${product} প্রোডাক্টের সহকারী।`
          : `I am the assistant for the ${product} product.`;
      case "business_name":
        return bn
          ? `আমার বিজনেসের নাম ${product}।`
          : `My business is the ${product} product.`;
      case "services":
        return bn
          ? `${product} একটি AI কাস্টমার-সাপোর্ট প্রোডাক্ট: এটি ব্যবসার হয়ে বাংলায় ও ইংরেজিতে, ২৪/৭ গ্রাহকের প্রশ্নের উত্তর দেয় — WhatsApp, ইমেইল ও ফোন চ্যানেলে।`
          : `${product} is an AI customer-support product: it answers a business's customer questions in Bengali and English, 24/7, over WhatsApp, email and phone.`;
      case "are_you_ride_bangla":
        return bn
          ? `না, আমি Ride Bangla নই। আমি ${product} প্রোডাক্টের সহকারী।`
          : `No, I am not Ride Bangla. I am the assistant for the ${product} product.`;
    }
  }

  if (identity.mode === "unconfigured") {
    switch (question) {
      case "who":
        return bn
          ? "আমি এই বিজনেসের সহকারী, কিন্তু এই বিজনেসটি এখনো কনফিগার করা হয়নি।"
          : "I am this business's assistant, but this business has not been configured yet.";
      case "business_name":
        return bn
          ? "এই বিজনেসের নাম এখনো সেট করা হয়নি।"
          : "This business's name has not been set up yet.";
      case "services":
        return bn
          ? "এই বিজনেসের সার্ভিস এখনো সেট করা হয়নি।"
          : "This business's services have not been set up yet.";
      case "are_you_ride_bangla":
        return bn
          ? "না, আমি Ride Bangla নই। এই বিজনেসটি এখনো কনফিগার করা হয়নি।"
          : "No, I am not Ride Bangla. This business has not been configured yet.";
    }
  }

  // Tenant mode (configured or name-only).
  const name = identity.displayName;
  switch (question) {
    case "who":
      return bn ? `আমি ${name}-এর সহকারী।` : `I am the assistant for ${name}.`;
    case "business_name":
      return bn
        ? `আমার বিজনেসের নাম ${name}।`
        : `My business is ${name}.`;
    case "services": {
      if (services.length > 0) {
        return bn ? listServicesBn(name, services) : listServicesEn(name, services);
      }
      if (!identity.configured) {
        return bn
          ? `${name}-এর সার্ভিস এখনো সেট করা হয়নি।`
          : `${name}'s services have not been set up yet.`;
      }
      if (desc) {
        return bn
          ? `${name} সম্পর্কে: ${desc}`
          : `About ${name}: ${desc}`;
      }
      return bn
        ? `${name}-এর সার্ভিস এখনো সেট করা হয়নি।`
        : `${name}'s services have not been set up yet.`;
    }
    case "are_you_ride_bangla":
      // The ONLY branch that may affirm is a tenant whose own registered
      // name IS Ride Bangla (the Main/delivery business). Every other
      // tenant denies, naming its own business instead.
      if (name === "Ride Bangla") {
        return bn
          ? "হ্যাঁ, আমি Ride Bangla-এর সহকারী।"
          : "Yes, I am Ride Bangla's assistant.";
      }
      return bn
        ? `না, আমি Ride Bangla নই। আমি ${name}-এর সহকারী।`
        : `No, I am not Ride Bangla. I am the assistant for ${name}.`;
  }
}

/**
 * The identity line that replaces the old hardcoded header
 * ("You are the Ride Bangla AI Agent, ... for {businessName}") at the
 * TOP of the system prompt, so even non-fast-path turns speak as the
 * right business. It never invents prices, plans, or services.
 */
export function buildIdentityPromptLine(identity: BusinessIdentity): string {
  switch (identity.mode) {
    case "portal":
      return (
        "You are the assistant for the Ride Bangla AI Agent product — an AI " +
        "customer-support product that answers a business's customer questions " +
        "in Bengali and English, 24/7, over WhatsApp, email and phone. " +
        "Speak as that product only. Never present yourself as a delivery " +
        "business and never describe delivery services as your own. " +
        "Never invent prices, plans, or features that are not in your " +
        "knowledge base."
      );
    case "unconfigured":
      return (
        "You are an assistant for a business that has not been configured yet. " +
        "Do not name any business, do not describe any business's services, " +
        "and do not present yourself as Ride Bangla. If asked who you are " +
        "or about services, say honestly that the business is not configured yet."
      );
    default: {
      const base =
        `You are the AI assistant for ${identity.displayName} only. ` +
        `Speak as ${identity.displayName} and about ${identity.displayName}'s ` +
        `own products and services only. Never present yourself as Ride Bangla ` +
        `or any other business, and never describe another business's services ` +
        `as your own. If asked whether you are Ride Bangla, answer no — you are ` +
        `${identity.displayName}'s assistant.`;
      if (!identity.configured) {
        return (
          base +
          ` ${identity.displayName}'s services are not configured yet: never ` +
          `invent services and never borrow another business's services. If ` +
          `asked about services, say honestly they are not set up yet.`
        );
      }
      return base;
    }
  }
}
