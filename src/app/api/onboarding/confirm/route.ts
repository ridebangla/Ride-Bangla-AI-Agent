import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";

// POST /api/onboarding/confirm — save the reviewed onboarding result into the
// tenant's own collections: knowledgeEntries (+ a "General" category) and
// products (+ productCategories). All writes run inside runWithBusiness(), so
// a business can only ever write to its own tenant scope (fail-closed).
//
// Body:
//   { qa: [{ question, answer }], products: [{ name, price, currency, category? }] }
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "Onboarding requires a business account." },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const qa = Array.isArray(body.qa) ? body.qa : [];
    const products = Array.isArray(body.products) ? body.products : [];

    if (qa.length > 200 || products.length > 200) {
      return NextResponse.json(
        { error: "Too many entries at once (max 200 each)." },
        { status: 400 }
      );
    }

    const cleanQA = qa
      .filter(
        (e) =>
          e &&
          typeof e.question === "string" &&
          typeof e.answer === "string" &&
          e.question.trim().length >= 3 &&
          e.answer.trim().length >= 3
      )
      .slice(0, 200)
      .map((e: { question: string; answer: string }) => ({
        question: e.question.trim().slice(0, 160),
        answer: e.answer.trim().slice(0, 2000),
      }));

    const cleanProducts = products
      .filter(
        (p) =>
          p &&
          typeof p.name === "string" &&
          p.name.trim().length >= 2
      )
      .slice(0, 200)
      .map(
        (p: {
          name: string;
          price?: unknown;
          currency?: unknown;
          category?: unknown;
        }) => {
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

    logger.warn(
      `[Onboarding] saved for business ${auth.businessId}: ` +
        `${result.knowledgeCreated} knowledge entries, ${result.productsCreated} products`
    );

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
