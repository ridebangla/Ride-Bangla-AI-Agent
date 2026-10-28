/**
 * Widget siteKey cache + graceful turn-failure text (moved out of the
 * route file 2026-10-28: Next 16 route modules may not export
 * non-handler symbols — the validator fails the build. Behaviour
 * unchanged; the route and its tests import this module now).
 */

export type SiteKeyBusiness = { id: string; name: string; isInternalAccount?: unknown };
export const businessBySiteKeyCache = new Map<
  string,
  { at: number; business: SiteKeyBusiness }
>();

/** Test-only: clear the siteKey cache between cases (same pattern as
 *  the provider breakers' __resetProviderBreakers). */
export function __resetWidgetSiteKeyCache(): void {
  businessBySiteKeyCache.clear();
}

/**
 * AI-perfection round (2026-10-23), FIX-A support: stale-read accessor
 * for the siteKey cache. Returns the cached business REGARDLESS of
 * TTL — including a stale entry — or null when this instance never
 * resolved the siteKey. Used ONLY by the turn-failure path to answer
 * a pure greeting while the data layer is down; the live gate path
 * keeps using getBusinessBySiteKeyCached with its TTL semantics
 * unchanged.
 */
export function getStaleBusinessBySiteKey(
  siteKey: string
): SiteKeyBusiness | null {
  const hit = businessBySiteKeyCache.get(siteKey);
  return hit ? hit.business : null;
}

const GRACEFUL_TURN_TEXT = {
  bn: "দুঃখিত, এই মুহূর্তে আপনার বার্তাটির উত্তর দিতে একটু সমস্যা হচ্ছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন, অথবা জরুরি হলে আমাদের টিমের সঙ্গে সরাসরি যোগাযোগ করুন।",
  en: "I'm sorry, I'm having a little trouble answering your message right now. Please try again in a moment, or contact our team directly if it's urgent.",
} as const;

/** Graceful turn-failure text in the visitor's language (Bengali script
 *  in their message → Bengali; anything else → English). */
export function gracefulTurnResponseText(messageText: string): string {
  return /[\u0980-\u09FF]/.test(messageText || "")
    ? GRACEFUL_TURN_TEXT.bn
    : GRACEFUL_TURN_TEXT.en;
}

