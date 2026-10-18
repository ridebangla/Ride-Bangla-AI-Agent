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

/** Look up a business by its public widget site key (unscoped on purpose). */
export async function getBusinessBySiteKey(
  siteKey: string
): Promise<{ id: string; name: string } | null> {
  if (!siteKey) return null;
  const raw = getUnscopedPrisma();
  return raw.business.findUnique({
    where: { siteKey },
    select: { id: true, name: true },
  });
}
