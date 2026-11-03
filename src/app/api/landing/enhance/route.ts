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
 *
 * GATES (same contract as /api/chat and the other LLM-spend routes):
 *  - Subscription gate BEFORE any work: an inactive subscription, or a
 *    grant scoped away from chat, answers 402 subscription_paused.
 *  - Plan quota gate BEFORE any LLM token is spent: when provider keys
 *    resolve (i.e. a refinement would actually spend), an exhausted
 *    plan answers 402 message_limit_reached. When no key resolves the
 *    refinement spends nothing, so the graceful { enhanced: false }
 *    path is preserved exactly (same key-first ordering as
 *    /api/knowledge/test and /api/agent-desk/preview).
 *  - Metering: a successful enhancement (aiEnhanced true only) is
 *    metered with recordAiMessage, fire-and-forget. No-key, failed,
 *    and invalid refinements spend nothing and are not metered.
 *  Holder/company unlimited and active-trial quota-exempt semantics
 *  live inside checkMessageLimitExceeded / recordAiMessage; this
 *  route adds no bypass of its own. Plan allowances and prices are
 *  untouched here.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { refineCopyWithAI, type LandingAiCopy } from "@/lib/landing-copy";
import { getLandingData } from "@/lib/landing";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  requireActiveSubscription,
  SubscriptionInactiveError,
} from "@/lib/subscription";
import { checkMessageLimitExceeded, recordAiMessage } from "@/lib/billing-usage";
import {
  resolveSiteKeys,
  hasAnyProviderKey,
} from "@/lib/ai/providers";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }

  // Subscription ACCESS gate BEFORE any work (same shape and order as
  // /api/chat): a paused tenant cannot spend LLM tokens here either.
  let subscription;
  try {
    subscription = await requireActiveSubscription(auth.businessId);
  } catch (err) {
    if (err instanceof SubscriptionInactiveError) {
      logger.warn(
        `[billing] blocked landing enhance for business ${auth.businessId}: subscription inactive`
      );
      return NextResponse.json(
        { error: "subscription_paused" },
        { status: 402 }
      );
    }
    throw err;
  }
  if (subscription.scopeAllowsChat === false) {
    logger.warn(
      `[billing] blocked landing enhance for business ${auth.businessId}: grant scope excludes chat`
    );
    return NextResponse.json(
      { error: "subscription_paused" },
      { status: 402 }
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

      // Plan quota hard-stop BEFORE any LLM token is spent — but only
      // when a refinement would actually spend. refineCopyWithAI
      // resolves keys internally and its no-key path is graceful
      // (premium template, no error), not an error contract, so the
      // key check comes first: no key => no spend => no gate, and the
      // graceful { enhanced: false } answer below is unchanged. A
      // key-resolution failure degrades the same way (keys null =>
      // gate skipped, refineCopyWithAI answers gracefully).
      const keys = await resolveSiteKeys(auth.businessId).catch(() => null);
      if (hasAnyProviderKey(keys)) {
        if (await checkMessageLimitExceeded(auth.businessId)) {
          logger.warn(
            `[billing] blocked landing enhance for business ${auth.businessId}: message limit reached`
          );
          return NextResponse.json(
            { error: "message_limit_reached" },
            { status: 402 }
          );
        }
      }

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

      // Meter the successful LLM spend against the business's plan
      // quota (fire-and-forget, never throws — same contract as
      // /api/agent-desk/preview and /api/knowledge/test). Only this
      // branch spends tokens: aiEnhanced false returns above, so
      // no-key / failed / invalid refinements are never metered.
      void recordAiMessage(auth.businessId);

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
