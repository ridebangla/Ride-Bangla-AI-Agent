/**
 * Cron-style auth for scheduled endpoints.
 *
 * Two accepted callers:
 * 1. A scheduler holding CRON_SECRET: `Authorization: Bearer <CRON_SECRET>`
 *    plus `?business=<slug>` (the secret has no business of its own, so the
 *    caller must name one; fail-closed otherwise).
 * 2. A normal admin/API-key caller via requireAuth() with the given
 *    permission.
 *
 * On success returns the resolved business id. The CALLER must wrap its work
 * in `runWithBusiness(businessId, ...)` — calling enterBusinessContext()
 * here would not help, because AsyncLocalStorage.enterWith() does not
 * propagate across the `await cronAuth(...)` boundary back into the caller.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import type { Permission } from "@/lib/rbac";

export async function cronAuth(
  request: NextRequest,
  permission: Permission
): Promise<{ ok: true; businessId: string | null } | NextResponse> {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";

  if (secret && header === `Bearer ${secret}`) {
    const slug = request.nextUrl.searchParams.get("business");
    if (!slug) {
      return NextResponse.json(
        { error: "Cron auth requires ?business=<slug>" },
        { status: 400 }
      );
    }
    const biz = await getUnscopedPrisma().business.findUnique({
      where: { slug },
    });
    if (!biz || !biz.isActive) {
      return NextResponse.json({ error: "Unknown business" }, { status: 400 });
    }
    return { ok: true, businessId: biz.id };
  }

  const auth = await requireAuth(request, permission);
  if (!isAuthenticated(auth)) return auth;
  return { ok: true, businessId: auth.businessId };
}
