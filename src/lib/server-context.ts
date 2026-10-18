import { cookies } from "next/headers";
import { verifySessionToken } from "./auth";
import { getUnscopedPrisma, enterBusinessContext } from "./prisma";

/**
 * Enter the tenant context for a React Server Component.
 *
 * Server Components run outside API-route auth, so they must resolve the
 * business from the session cookie themselves. Mirrors the resolution logic
 * in `requireAuth` (src/lib/route-auth.ts):
 *  - business admin  -> their business (?business= must match if given)
 *  - super admin     -> ?business=<slug>, else the single active business,
 *                       else null (fresh install / must choose)
 *
 * Returns the effective business id, or null when no valid session/business
 * could be resolved (the middleware redirects unauthenticated users to
 * login before this ever runs).
 */
export async function enterServerBusinessContext(searchParams?: {
  business?: string | string[];
}): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("rbai-token")?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const db = getUnscopedPrisma();
  const admin = await db.admin.findUnique({
    where: { id: payload.userId },
    select: { businessId: true },
  });
  if (!admin) return null;

  let effective: string | null = admin.businessId ?? null;
  const rawSlug = searchParams?.business;
  const slug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;

  if (slug) {
    const biz = await db.business.findUnique({ where: { slug } });
    if (!biz || !biz.isActive) return null;
    if (effective && effective !== biz.id) return null;
    effective = biz.id;
  } else if (!effective) {
    const businesses = await db.business.findMany({
      where: { isActive: true },
      select: { id: true },
      take: 2,
    });
    if (businesses.length === 1) {
      effective = businesses[0].id;
    } else if (businesses.length > 1) {
      return null;
    }
  }

  enterBusinessContext(effective);
  return effective;
}
