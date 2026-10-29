/**
 * reserved-names.ts — platform-name reservation (owner approval
 * 2026-10-29 ~23:53: no NEW tenant may register, set up, onboard with,
 * or rename to the business name "Ride Bangla").
 *
 * RULE (exact-match family only, by design):
 * A name is reserved when, after normalisation, it equals one of the
 * reserved forms below. Normalisation is case-insensitive, trims and
 * collapses whitespace, strips diacritics, and drops ALL punctuation
 * and spacing — so "Ride Bangla", "RIDEBANGLA", "Ride-Bangla",
 * "Ride  Bangla", "Ride Bangla." and "Ride Bangla Ltd." all match,
 * while a genuinely different name does not.
 *
 * RESERVED FORMS (normalised):
 *   "ridebangla"          — the platform/brand name itself.
 *   "ridebanglalimited"   — the legal-entity form ("Ride Bangla
 *                           Limited"). A business calling itself this
 *                           claims to BE the company, not a customer.
 *   "ridebanglaltd"       — the abbreviated legal form ("Ride Bangla
 *                           Ltd" / "Ltd."). Same claim, same block.
 *
 * DELIBERATELY NOT BLOCKED (flagged, not silent):
 * Substrings and longer names are NOT blocked. "Ride Bangla Bakery"
 * normalises to "ridebanglabakery", which is not an exact reserved
 * form, so it is ALLOWED today. Reason: a longer name may be a
 * genuinely distinct business, and silently blocking every name that
 * merely contains the platform words would overblock legitimate
 * businesses. If the owner later wants prefix blocking, that is a
 * separate owner decision — it must not be smuggled in here. The
 * identity fast path remains the backstop: a non-portal tenant is
 * never affirmed as the platform, whatever its registered name is
 * (see src/lib/ai/identity.ts).
 *
 * KNOWN LIMITS (stated, not claimed away):
 * - Latin-script forms only. A Bengali-script rendering is a different
 *   string and is not matched by this module; blocking it would need
 *   a transliteration decision from the owner.
 * - Unicode homoglyphs (look-alike letters from other scripts) are
 *   not mapped. A confusable-spelling squat would pass this check;
 *   it would still be caught by the identity fast path (never
 *   affirmed as the platform) but not by registration blocking.
 *
 * EXEMPTION (holder/company business):
 * This module itself knows nothing about companies — it only answers
 * "is this name reserved?". Callers that rename an EXISTING business
 * must additionally check `isCompanyBusiness(businessId)` (see
 * src/lib/company-identity.ts) and SKIP the block when the target
 * business is the company's own. The company's business already is
 * Ride Bangla and stays so; the block must never lock it out or
 * rename it. Creation paths (signup, Google signup, Super Admin
 * business creation) have no existing business to exempt, so they
 * block unconditionally — a genuinely new company business is
 * created through the deploy-time seed / Admin Console
 * company-identity flow, not through a tenant creation route.
 * On an exemption-check failure, callers must treat the business as
 * NON-company (block applies): a data-layer outage must never let a
 * squat through, and a company rename can simply be retried.
 *
 * SERVER-SIDE ONLY: every enforcement point is a server route. A
 * client-side check, if one is ever added, is decoration only and
 * never counts as the block — a client check is bypassable.
 */

/** The reserved names in their human-readable form (for messages/docs). */
export const RESERVED_BUSINESS_NAMES = [
  "Ride Bangla",
  "Ride Bangla Limited",
  "Ride Bangla Ltd",
] as const;

/** Normalised reserved forms — the only strings that match. */
const RESERVED_NORMALIZED: ReadonlySet<string> = new Set([
  "ridebangla",
  "ridebanglalimited",
  "ridebanglaltd",
]);

/**
 * Normalise a business name for reservation matching: NFKD, strip
 * combining diacritics, lowercase, drop every non-alphanumeric
 * character (spaces, hyphens, dots, etc.). Pure and side-effect free.
 */
export function normalizeBusinessName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * True when the given name is a reserved platform name under the
 * exact-match-family rule above. Non-strings are never reserved.
 */
export function isReservedBusinessName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  if (name.trim().length === 0) return false;
  return RESERVED_NORMALIZED.has(normalizeBusinessName(name));
}

/**
 * The single functional error wording used by every enforcement
 * point. It is a plain functional label (not marketing copy): it
 * says what happened and what to do, and it names no other business.
 */
export const RESERVED_NAME_ERROR =
  "This business name is reserved. Please choose a different business name.";
