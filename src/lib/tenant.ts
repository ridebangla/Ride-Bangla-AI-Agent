/**
 * Tenant context helpers. The actual enforcement lives in src/lib/prisma.ts
 * (the exported `prisma` client auto-scopes every tenant-model query).
 */
export {
  runWithBusiness,
  enterBusinessContext,
  getBusinessId,
  getUnscopedPrisma,
  TenantContextError,
} from "./prisma";

import { getUnscopedPrisma } from "./prisma";

/**
 * Resolve which business a channel webhook/worker event belongs to.
 *
 * Single-business deployments (the normal starting point): returns the only
 * active business. Multi-business deployments: pass ?business=<slug> on the
 * webhook URL (see setupTelegramWebhook / OPERATIONS.md) — without it we
 * refuse to guess, because guessing wrong would leak one business's
 * customers into another's.
 */
export async function resolveChannelBusiness(
  slug?: string | null
): Promise<string> {
  const raw = getUnscopedPrisma();
  if (slug) {
    const b = await raw.business.findUnique({
      where: { slug },
      select: { id: true, isActive: true },
    });
    if (b?.isActive) return b.id;
    throw new Error(`Unknown or inactive business slug: ${slug}`);
  }
  const businesses = await raw.business.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  if (businesses.length === 1) return businesses[0].id;
  throw new Error(
    "Ambiguous business for channel event: multiple active businesses exist. " +
      "Register webhooks with ?business=<slug>."
  );
}

type SiteKeyBusiness = {
  id: string;
  name: string;
  isInternalAccount?: unknown;
};

/**
 * Q-QUOTA (2026-10-23): brief in-process cache for the siteKey →
 * business resolution. EVERY public/widget route resolves the siteKey
 * on EVERY call — the widget thread/activity polls hit it several
 * times a minute per open panel — while the mapping changes only when
 * a business is created or re-keyed. 60 s TTL, the same precedent as
 * the widget chat route's own cache and the brand record cache.
 *
 * Only POSITIVE resolutions are cached: a key that resolves to nothing
 * is re-checked on every call, so a freshly created business resolves
 * immediately. Subscription / limit / role state is NOT part of this
 * record and is never cached here — billing gates keep reading fresh
 * state exactly as before. (The chat widget route keeps its own
 * additional cache, untouched.)
 */
const SITE_KEY_CACHE_TTL_MS = 60_000;
const SITE_KEY_CACHE_MAX = 500;
const siteKeyCache = new Map<
  string,
  { at: number; business: SiteKeyBusiness }
>();

/** Test-only: clear the siteKey resolution cache between cases. */
export function __resetSiteKeyCache(): void {
  siteKeyCache.clear();
}

/** Look up a business by its public widget site key (unscoped on purpose).
 *  `isInternalAccount` rides along (same single read) so the public
 *  routes can apply the B7 internal exemptions from the SERVER-resolved
 *  business record behind the siteKey — never from a client-supplied
 *  value. */
export async function getBusinessBySiteKey(
  siteKey: string
): Promise<SiteKeyBusiness | null> {
  if (!siteKey) return null;
  const hit = siteKeyCache.get(siteKey);
  if (hit && Date.now() - hit.at < SITE_KEY_CACHE_TTL_MS) {
    return hit.business;
  }
  const raw = getUnscopedPrisma();
  const business = await raw.business.findUnique({
    where: { siteKey },
    select: { id: true, name: true, isInternalAccount: true },
  });
  if (business) {
    if (siteKeyCache.size >= SITE_KEY_CACHE_MAX) siteKeyCache.clear();
    siteKeyCache.set(siteKey, {
      at: Date.now(),
      business: business as SiteKeyBusiness,
    });
  }
  return business as SiteKeyBusiness | null;
}
