/**
 * POST /api/landing/enhance — "Enhance with AI" for the landing page editor.
 *
 * Runs the rule-based landing copy through the LLM seam
 * (`refineCopyWithAI()` in src/lib/landing-copy.ts): when any provider key
 * resolves (per-site keys first, then GROQ_API_KEY / GEMINI_API_KEY /
 * OPENAI_API_KEY) the model rewrites the copy and suggests the best-fitting
 * theme; otherwise the endpoint reports { enhanced: false } gracefully —
 * the premium template path always works.
 *
 * On success the refined copy (+ suggested theme + timestamp) is persisted
 * to `businesses.landingAiCopy`. The public page merges these overrides
 * over the rule-based copy (see applyAiCopyOverrides). The suggested theme
 * is advisory — the owner picks the theme in the editor; it only becomes
 * active when no explicit `landingTheme` is set.
 *
 * Permission: settings:update. Tenant-scoped via runWithBusiness +
 * explicit `where: { id: auth.businessId }` — fail-closed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { refineCopyWithAI, type LandingAiCopy } from "@/lib/landing-copy";
import { getLandingData } from "@/lib/landing";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const db = getUnscopedPrisma();
      const business = (await db.business.findUnique({
        where: { id: auth.businessId },
        select: { id: true, name: true, slug: true, tagline: true, brandColor: true, landingTheme: true },
      })) as null | {
        id: string;
        name: string;
        slug: string;
        tagline?: string | null;
        brandColor?: string | null;
        landingTheme?: string | null;
      };
      if (!business) {
        return NextResponse.json({ error: "Business not found." }, { status: 404 });
      }

      const landing = await getLandingData(business.slug);
      if (!landing) {
        return NextResponse.json({ error: "Landing data not available." }, { status: 404 });
      }

      const settings = (await db.settings.findFirst({
        where: { businessId: business.id },
        select: { businessDesc: true },
      })) as { businessDesc?: string } | null;

      const result = await refineCopyWithAI(landing.copy, {
        businessName: business.name,
        businessDesc: settings?.businessDesc ?? null,
        tagline: business.tagline ?? null,
        brandColor: business.brandColor ?? null,
        products: landing.products.map((p) => ({
          name: p.name,
          description: p.description,
          price: p.price,
          currency: p.currency,
          categoryName: p.categoryName,
        })),
        categories: landing.productGroups.map((g) => g.categoryName).filter(Boolean),
        knowledgeTitles: landing.aboutEntries.map((e) => e.title),
        currentTheme: business.landingTheme ?? null,
      });

      if (!result.aiEnhanced) {
        return NextResponse.json({
          enhanced: false,
          reason:
            result.note === "no-key"
              ? "AI enhancement is not configured yet (no API key). Your page already uses the premium template."
              : "AI enhancement failed — your current copy is unchanged.",
        });
      }

      const aiCopy: LandingAiCopy = {
        ...result.copy,
        suggestedTheme: result.suggestedTheme,
        enhancedAt: new Date().toISOString(),
      };
      await db.business.update({
        where: { id: auth.businessId },
        data: { landingAiCopy: aiCopy },
      });

      return NextResponse.json({
        enhanced: true,
        aiCopy,
        suggestedTheme: result.suggestedTheme,
      });
    } catch (error) {
      logger.error("Landing AI enhance failed:", error);
      return NextResponse.json({ error: "AI enhancement failed." }, { status: 500 });
    }
  });
}
