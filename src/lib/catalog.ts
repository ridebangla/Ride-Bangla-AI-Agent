import { prisma, withBusinessId } from "./prisma";
import { getBusinessId, TenantContextError } from "./prisma";

export interface CatalogProduct {
  id: string;
  name: string;
  description: string;
  price: number | null;
  currency: string;
  imageUrl: string;
  tags: string[];
  isAvailable: boolean;
  categoryName: string | null;
}

/**
 * Pluggable product/service catalog. Tenant-configurable: each business fills
 * in its own ProductCategory/Product rows (via /api/catalog); the retrieval,
 * presentation and alternative-suggestion logic below is real and shared.
 * Ride Bangla has no own production yet, so this ships empty-but-wired.
 */
export async function searchCatalog(query: string, limit = 5): Promise<CatalogProduct[]> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "searchCatalog");

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09FF]+/u)
    .filter((t) => t.length > 2);

  const products = await prisma.product.findMany({
    where: { isAvailable: true },
    include: { category: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  const scored = products.map((p) => {
    const hay = `${p.name} ${p.description} ${p.tags} ${p.category?.name ?? ""}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) score += t.length > 4 ? 2 : 1;
    }
    return { p, score };
  });

  return scored
    .filter((s) => s.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => toCatalogProduct(s.p));
}

export async function listAvailableProducts(limit = 20): Promise<CatalogProduct[]> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "listAvailableProducts");
  const products = await prisma.product.findMany({
    where: { isAvailable: true },
    include: { category: { select: { name: true } } },
    orderBy: { name: "asc" },
    take: limit,
  });
  return products.map(toCatalogProduct);
}

/**
 * Graceful redirect: the customer asked for something unavailable (or the
 * query matched nothing). Return available alternatives — same category
 * first, then popular/any available — so the agent can highlight what the
 * business DOES have instead of just saying "no".
 */
export async function recommendAlternatives(
  query: string,
  limit = 3
): Promise<{ alternatives: CatalogProduct[]; reason: string }> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "recommendAlternatives");

  // Try a direct search first — maybe something IS available.
  const direct = await searchCatalog(query, limit);
  if (direct.length > 0) {
    return { alternatives: direct, reason: "direct_match" };
  }

  // Fall back: any available products, preferring ones whose category or tags
  // overlap with the query terms.
  const terms = query.toLowerCase().split(/[^a-z0-9\u0980-\u09FF]+/u).filter((t) => t.length > 2);
  const products = await prisma.product.findMany({
    where: { isAvailable: true },
    include: { category: { select: { name: true } } },
    take: 30,
  });

  const scored = products.map((p) => {
    const hay = `${p.tags} ${p.category?.name ?? ""}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);

  return {
    alternatives: scored.slice(0, limit).map((s) => toCatalogProduct(s.p)),
    reason: scored.length > 0 ? "category_fallback" : "catalog_empty",
  };
}

/** Compact catalog brief injected into the agent's system prompt. */
export async function getCatalogBrief(): Promise<string> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "getCatalogBrief");
  const categories = await prisma.productCategory.findMany({
    include: {
      products: {
        where: { isAvailable: true },
        select: { name: true, price: true, currency: true },
      },
    },
    orderBy: { name: "asc" },
  });
  if (categories.length === 0) {
    return "PRODUCT CATALOG: not configured yet for this business. If the customer asks about products/services, answer from the knowledge base and offer to connect them with the team.";
  }
  const lines = categories.map((c) => {
    const items = c.products
      .map((p) => (p.price != null ? `${p.name} (${p.currency} ${p.price})` : p.name))
      .join(", ");
    return `- ${c.name}: ${items || "(no available items)"}`;
  });
  return `PRODUCT CATALOG (available now):\n${lines.join("\n")}`;
}

function toCatalogProduct(p: {
  id: string;
  name: string;
  description: string;
  price: number | null;
  currency: string;
  imageUrl: string;
  tags: string;
  isAvailable: boolean;
  category: { name: string } | null;
}): CatalogProduct {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    currency: p.currency,
    imageUrl: p.imageUrl,
    tags: p.tags ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    isAvailable: p.isAvailable,
    categoryName: p.category?.name ?? null,
  };
}

/** Admin helper: create a category (used by /api/catalog). */
export async function createCategory(name: string, description = "") {
  return prisma.productCategory.create({
    data: withBusinessId({ name: name.trim(), description }),
  });
}

/** Admin helper: create a product (used by /api/catalog). */
export async function createProduct(input: {
  name: string;
  description?: string;
  price?: number | null;
  currency?: string;
  imageUrl?: string;
  tags?: string;
  categoryId?: string | null;
  isAvailable?: boolean;
}) {
  return prisma.product.create({
    data: withBusinessId({
      name: input.name.trim(),
      description: input.description ?? "",
      price: input.price ?? null,
      currency: input.currency ?? "BDT",
      imageUrl: input.imageUrl ?? "",
      tags: input.tags ?? "",
      categoryId: input.categoryId ?? null,
      isAvailable: input.isAvailable ?? true,
    }),
  });
}
