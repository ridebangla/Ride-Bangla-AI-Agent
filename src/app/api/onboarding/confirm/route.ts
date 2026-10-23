import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { invalidateCatalogBrief } from "@/lib/catalog";

// POST /api/onboarding/confirm — save the reviewed onboarding result into the
// tenant's own collections: knowledgeEntries (+ a "General" category) and
// products (+ productCategories). All writes run inside runWithBusiness(), so
// a business can only ever write to its own tenant scope (fail-closed).
//
// Body:
//   { qa: [{ question, answer }], products: [{ name, price, currency, category? }],
//     websites?: [{ url, pageCount?, entryCount? }] }
// `websites` lists the sites the wizard's URL method just learned from,
// so the business's website list (Settings > Websites) records them as
// indexed with the counts the scrape actually produced.
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "Onboarding requires a business account." },
      { status: 400 }
    );
  }

  // Per-account + per-IP rate limit, honest 429.
  const _rlIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const _rl = checkRateLimit(
    `onboarding:${auth.businessId}:${_rlIp}`,
    RATE_LIMITS.onboarding
  );
  if (!_rl.allowed) {
    const _res = NextResponse.json(
      { error: "rate_limited", message: "Too many save requests. Please wait a while and try again." },
      { status: 429 }
    );
    _res.headers.set(
      "Retry-After",
      String(Math.ceil((_rl.resetAt - Date.now()) / 1000))
    );
    return _res;
  }

  try {
    const body = await request.json();
    const qa: Array<{ question?: unknown; answer?: unknown }> =
      Array.isArray(body.qa) ? body.qa : [];
    const products: Array<{
      name?: unknown;
      price?: unknown;
      currency?: unknown;
      category?: unknown;
    }> = Array.isArray(body.products) ? body.products : [];

    if (qa.length > 200 || products.length > 200) {
      return NextResponse.json(
        { error: "Too many entries at once (max 200 each)." },
        { status: 400 }
      );
    }

    const cleanQA = qa
      .filter(
        (e): e is { question: string; answer: string } =>
          !!e &&
          typeof e.question === "string" &&
          typeof e.answer === "string" &&
          e.question.trim().length >= 3 &&
          e.answer.trim().length >= 3
      )
      .slice(0, 200)
      .map((e) => ({
        question: e.question.trim().slice(0, 160),
        answer: e.answer.trim().slice(0, 2000),
      }));

    const cleanProducts = products
      .filter(
        (p): p is {
          name: string;
          price?: unknown;
          currency?: unknown;
          category?: unknown;
        } => !!p && typeof p.name === "string" && p.name.trim().length >= 2
      )
      .slice(0, 200)
      .map((p) => {
          const price =
            typeof p.price === "number" && Number.isFinite(p.price) && p.price > 0
              ? p.price
              : null;
          const currency =
            typeof p.currency === "string" && /^[A-Z]{3}$/.test(p.currency)
              ? p.currency
              : "BDT";
          const category =
            typeof p.category === "string" && p.category.trim()
              ? p.category.trim().slice(0, 60)
              : "Products";
          return {
            name: p.name.trim().slice(0, 120),
            price,
            currency,
            category,
          };
        }
      );

    const result = await runWithBusiness(auth.businessId, async () => {
      // Import the scoped client lazily inside the tenant context — the
      // module-level `prisma` proxy reads the ambient business id.
      const { prisma } = await import("@/lib/prisma");

      let knowledgeCreated = 0;
      if (cleanQA.length > 0) {
        let category = await prisma.category.findFirst({
          where: { name: "General" },
        });
        if (!category) {
          category = await prisma.category.create({
            data: { name: "General", description: "Added during onboarding" },
          });
        }
        for (const entry of cleanQA) {
          await prisma.knowledgeEntry.create({
            data: {
              categoryId: category.id,
              title: entry.question,
              content: entry.answer,
              metadata: { source: "onboarding" },
            },
          });
          knowledgeCreated++;
        }
      }

      let productsCreated = 0;
      if (cleanProducts.length > 0) {
        const categoryCache = new Map<string, string>();
        const getCategoryId = async (name: string): Promise<string> => {
          const hit = categoryCache.get(name);
          if (hit) return hit;
          let cat = await prisma.productCategory.findFirst({
            where: { name },
          });
          if (!cat) {
            cat = await prisma.productCategory.create({
              data: { name, description: "Added during onboarding" },
            });
          }
          categoryCache.set(name, cat.id);
          return cat.id;
        };
        for (const p of cleanProducts) {
          const categoryId = await getCategoryId(p.category);
          await prisma.product.create({
            data: {
              categoryId,
              name: p.name,
              description: "",
              price: p.price,
              currency: p.currency,
              isAvailable: true,
              metadata: { source: "onboarding" },
            },
          });
          productsCreated++;
        }
      }

      return { knowledgeCreated, productsCreated };
    });

    // The writes above created productCategory/product rows directly,
    // bypassing the catalog helpers — drop any catalog brief cached
    // before onboarding so the tenant's first catalogue is not masked
    // by a stale brief for the rest of its 120 s TTL. Post-write only:
    // runWithBusiness has resolved, so the writes have succeeded.
    invalidateCatalogBrief(auth.businessId);

    logger.warn(
      `[Onboarding] saved for business ${auth.businessId}: ` +
        `${result.knowledgeCreated} knowledge entries, ${result.productsCreated} products`
    );

    // Record the wizard's websites on the business (best-effort: the
    // knowledge save above is the real work and must not fail because
    // of this bookkeeping).
    const websites: Array<{
      url?: unknown;
      pageCount?: unknown;
      entryCount?: unknown;
    }> = Array.isArray(body.websites) ? body.websites : [];
    if (websites.length > 0) {
      try {
        const { recordOnboardingWebsites } = await import(
          "@/lib/business-websites"
        );
        await recordOnboardingWebsites(
          auth.businessId,
          websites.map((w) => ({
            url: typeof w.url === "string" ? w.url : "",
            pageCount:
              typeof w.pageCount === "number" ? w.pageCount : undefined,
            entryCount:
              typeof w.entryCount === "number" ? w.entryCount : undefined,
          }))
        );
      } catch (err) {
        logger.warn(
          `[Onboarding] website-list record failed: ${err instanceof Error ? err.message : "unknown"}`
        );
      }
    }

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    logger.warn(
      `[Onboarding] confirm failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    return NextResponse.json(
      { error: "Couldn't save your business info. Please try again." },
      { status: 500 }
    );
  }
}
