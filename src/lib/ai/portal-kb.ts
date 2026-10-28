/**
 * PORTAL KB — conservative, HEAD-BUILT-PENDING-CORRECTION.
 * Repo path when applied: src/lib/ai/portal-kb.ts (NEW, pure)
 *
 * PROBLEM: the AI portal agent answers as the Ride Bangla DELIVERY
 * business because it has no business of its own — its "index" is
 * the delivery seed KB. The fix direction (portal report §2, a
 * RECOMMENDATION, not staged code) is: a distinct portal/product
 * business (own siteKey, own settings, own KB) + a conditional
 * prompt prefix (product mode vs tenant mode) + a tenant-aware
 * identity fast path.
 *
 * WHAT THIS MODULE DOES (conservative, no invented copy):
 *  - It contains ONLY product facts evidenced in-repo (portal
 *    report §3): product name "Ride Bangla AI Agent", maker "by
 *    Ride Bangla" (footer/About lines only), the layout.tsx metadata
 *    description, and the page.tsx HOW + FEATURES substance.
 *  - It NEVER lists food delivery, ride sharing, courier/parcel, or
 *    marketplace as portal services — those belong to the delivery
 *    business's surfaces, never the portal.
 *  - It NEVER quotes a plan allowance. Prices ($19/$49/$99, yearly
 *    10x monthly = 2 months free) agree across plans.ts and the
 *    marketing page and MAY be quoted; allowances do NOT agree
 *    (Starter 1,000 messages vs 1,000 conversations; Growth 5,000
 *    vs 10,000; Pro 15,000 vs Unlimited; no free-tier constant in
 *    code) and are therefore returned as UNSETTLED — the agent must
 *    say allowances are not quoted until settled, never pick one.
 *  - Trial 7 days ("no credit card required") agrees across
 *    plans.ts + signup page and may be quoted.
 *
 * WHAT IT DOES NOT DO (still owed, flagged, not faked):
 *  - It does NOT create the portal business row, siteKey, or settings
 *    doc — those are live-data / apply-time work (portal embed's
 *    siteKey -> business mapping must be confirmed live; see the
 *    report). This KB is the CONTENT for that business once it
 *    exists, not the business itself.
 *  - It does NOT write marketing copy beyond the in-repo substance
 *    above, and it does NOT invent plan wording, prices, or legal text.
 *  - ID-01 identity resolution (portal vs tenant vs unconfigured)
 *    and ID-02 engine fast-path remain the staged identity diffs
 *    (ID-02/03/04/06 apply-clean vs true HEAD); this KB plugs into
 *    ID-01's portal branch, it does not replace ID-01.
 *
 * STATUS FLAG: HEAD-BUILT-PENDING-CORRECTION — the owner corrects
 * the portal business binding, the KB wording, and the plans
 * settlement; until then this module is the conservative content
 * and the allowance guard is the safe behaviour.
 */

export const PORTAL_PRODUCT_NAME = "Ride Bangla AI Agent";
export const PORTAL_MAKER_LINE = "by Ride Bangla";

export const PORTAL_PRODUCT_DESCRIPTION =
  "AI customer service agent for businesses: instant 24/7 chat support, " +
  "WhatsApp / Facebook / Instagram / Telegram automation, and a no-code admin dashboard. Built by Ride Bangla.";

export const PORTAL_HOW_IT_WORKS: readonly string[] = [
  "Connect your business — website URL, pasted text, uploaded file, or a short guided Q&A.",
  "The AI learns — studies products, prices, hours, policies, FAQs; builds its own knowledge base and catalog.",
  "It talks to your customers — 24/7 instant replies on the website chat widget, WhatsApp, Facebook, Instagram, Telegram, like your best employee, always on.",
];

export const PORTAL_FEATURES: readonly string[] = [
  "Product catalog with rich in-chat product cards.",
  "Order handling conversationally, including advance-payment flows.",
  "Photos, voice notes and videos understood and matched to the catalog.",
  "Human takeover by one switch: AI goes fully silent, customers talk directly to the owner, and resumes reading full history.",
  "Retention behaviour: instant answers, smart alternatives when something is unavailable, warm follow-ups.",
];

/** Delivery-business services — MUST NEVER appear as portal services. */
export const PORTAL_FORBIDDEN_SERVICES: readonly string[] = [
  "food delivery",
  "ride sharing",
  "courier/parcel",
  "marketplace",
];

export function portalServicesAnswer(): string[] {
  return [...PORTAL_HOW_IT_WORKS, ...PORTAL_FEATURES];
}

export function portalAnswerMentionsForbiddenService(answer: string): boolean {
  const lower = answer.toLowerCase();
  return PORTAL_FORBIDDEN_SERVICES.some((s) => lower.includes(s));
}

export interface PortalPlanQuote {
  name: "Starter" | "Growth" | "Pro";
  monthlyUsd: number;
  yearlyUsd: number;
  trialDays: number;
  /** Allowances are UNSETTLED — never a number here, by construction. */
  allowance: "UNSETTLED — do not quote an allowance until the plans settlement lands";
}

export const PORTAL_PLANS: readonly PortalPlanQuote[] = [
  { name: "Starter", monthlyUsd: 19, yearlyUsd: 190, trialDays: 7, allowance: "UNSETTLED — do not quote an allowance until the plans settlement lands" },
  { name: "Growth", monthlyUsd: 49, yearlyUsd: 490, trialDays: 7, allowance: "UNSETTLED — do not quote an allowance until the plans settlement lands" },
  { name: "Pro", monthlyUsd: 99, yearlyUsd: 990, trialDays: 7, allowance: "UNSETTLED — do not quote an allowance until the plans settlement lands" },
];

/**
 * Plans settlement guard: any caller that wants to quote an allowance
 * gets this refusal object, not a number. The refusal names the exact
 * contradiction (messages vs conversations; Growth 5,000 vs 10,000;
 * Pro 15,000 vs Unlimited) so the owner can settle it in one pick.
 */
export function portalAllowanceGuard(): {
  quoteAllowance: false;
  reason: string;
  contradictions: readonly string[];
} {
  return {
    quoteAllowance: false,
    reason: "Plans allowances are unsettled in-repo and must not be quoted until settled.",
    contradictions: [
      "Starter: plans.ts 1,000 messages/month vs marketing page 1,000 conversations/month.",
      "Growth: plans.ts 5,000 messages/month vs marketing page 10,000 conversations/month.",
      "Pro: plans.ts 15,000 messages/month vs marketing page Unlimited conversations.",
      "Free tier: no free-tier constant exists in code; the standing 'AI approx 100 messages/month free' note is uncorroborated and must not be quoted.",
    ],
  };
}
