import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getUnscopedPrisma, prisma, runWithBusiness } from "@/lib/prisma";
import { listBusinessWebsites } from "@/lib/business-websites";
import { resolveTenantOnboardingBranch } from "@/lib/landing";
import { logger } from "@/lib/logger";

// GET /api/onboarding/status — TEAM F (2026-11-03).
//
// The tenant's own onboarding branch, from the tenant's own rows only
// (business id comes from auth, never from the body or query):
//   website_verify  — owner claimed a website that has not indexed yet
//   landing_page    — no website and no published landing page
//   landing_category— no categories (products sit in the landing
//                     fallback group until the owner adds categories)
//   catalog_intake  — no products (owner must supply photos + names;
//                     the route reports machine flags, never copy)
//   complete        — verified website source (or published landing
//                     page) + categories + products
//
// "Verified" means a listed website whose ingest actually succeeded
// (status "indexed" in business-websites.ts). A pending/failed entry
// never counts as verified, and a legacy websiteUrl alone (merged as
// "pending") never counts either. This route invents nothing: it only
// reports which approved-spec branch the tenant is on.

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "Onboarding status requires a business account." },
      { status: 400 }
    );
  }

  try {
    const db = getUnscopedPrisma();
    const business = (await db.business.findUnique({
      where: { id: auth.businessId },
      select: { websites: true, websiteUrl: true, landingPublished: true },
    })) as null | {
      websites?: unknown;
      websiteUrl?: string | null;
      landingPublished?: boolean | null;
    };
    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    const websites = listBusinessWebsites({
      websites: business.websites as never,
      websiteUrl: business.websiteUrl ?? undefined,
    });
    const websiteClaimed = websites.length > 0;
    const websiteVerified = websites.some((w) => w.status === "indexed");

    const counts = await runWithBusiness(auth.businessId, async () => {
      const [categoryCount, productCount] = await Promise.all([
        prisma.productCategory.count(),
        prisma.product.count(),
      ]);
      return { categoryCount, productCount };
    });

    const result = resolveTenantOnboardingBranch({
      websiteClaimed,
      websiteVerified,
      landingPublished: business.landingPublished === true,
      categoryCount: counts.categoryCount,
      productCount: counts.productCount,
    });

    return NextResponse.json({
      ...result,
      websiteClaimed,
      websiteVerified,
      landingPublished: business.landingPublished === true,
      categoryCount: counts.categoryCount,
      productCount: counts.productCount,
    });
  } catch (err) {
    logger.warn(
      `[Onboarding] status failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    return NextResponse.json(
      { error: "Couldn't load onboarding status." },
      { status: 500 }
    );
  }
}
