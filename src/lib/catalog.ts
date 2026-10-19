import { prisma, withBusinessId } from "./prisma";
import { getBusinessId, TenantContextError } from "./prisma";

/**
 * Normalize a product's tags to a lowercase string regardless of storage
 * shape (dashboard writes comma-separated strings; imports may use arrays).
 */
export function normTags(tags: unknown): string {
  if (Array.isArray(tags)) return tags.map((t) => String(t)).join(" ").toLowerCase();
  return String(tags ?? "").toLowerCase();
}

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
    tags: normTags(p.tags).split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
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


/**
 * Phase 3: deterministic, dependency-free product matching (user decisions
 * 10 + 15).
 *
 * Scores the tenant's available products against free text — a customer
 * message, the assistant's reply, or a vision-model photo description.
 * Name hits weigh most (3), then tags (2), then description/category (1).
 * A product needs score >= 3 (roughly one solid product-name word) so
 * casual chatter never triggers cards. No AI, no new dependencies, and the
 * tenant scope is enforced by getBusinessId() (fail-closed).
 */
export async function matchProductsInMessage(
  message: string,
  limit = 3
): Promise<CatalogProduct[]> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "matchProductsInMessage");

  const terms = (message || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09FF]+/u)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const products =
    (await prisma.product.findMany({
      where: { isAvailable: true },
      include: { category: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    })) ?? [];

  const scored = products.map((p) => {
    const name = (p.name || "").toLowerCase();
    const desc = (p.description || "").toLowerCase();
    const tags = normTags(p.tags);
    const cat = (p.category?.name || "").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) score += 3;
      else if (tags.includes(t)) score += 2;
      else if (desc.includes(t)) score += 1;
      else if (cat.includes(t)) score += 1;
    }
    return { p, score };
  });

  return scored
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((s) => toCatalogProduct(s.p));
}

/* =====================================================================
 * Phase 3 refinements (user-confirmed 2026-10-19):
 *  (a) AUTO-CATEGORIES — rule-based grouping, AI-refined names when a key
 *      exists, graceful rule-only fallback when not.
 *  (b) BUDGET-AWARE ALTERNATIVES — exact match -> budget band (+/-30%) ->
 *      closest category -> anything available. Never let the customer walk
 *      away empty-handed.
 * All tenant-scoped via getBusinessId() (fail-closed). No new collections:
 * auto-categorize writes real productCategory rows + product.categoryId.
 * ===================================================================== */

function tokenizeTerms(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09FF]+/u)
    .filter((t) => t.length > 2);
}

/**
 * (a) Chat: "I want X type" -> the matching category -> that category's
 * available products as cards. Scores category name (x3) and description
 * (x1) against the message; needs one solid name-word hit (score >= 3).
 */
export async function matchCategoryProducts(
  message: string,
  limit = 3
): Promise<CatalogProduct[]> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "matchCategoryProducts");

  const terms = tokenizeTerms(message);
  if (terms.length === 0) return [];

  const categories =
    (await prisma.productCategory.findMany({
      include: {
        products: {
          where: { isAvailable: true },
          orderBy: { updatedAt: "desc" },
          take: 12,
        },
      },
      take: 30,
    })) ?? [];

  let best: { name: string; score: number; products: Array<Record<string, unknown>> } | null = null;
  for (const c of categories as Array<{
    name: string;
    description?: string | null;
    products?: Array<Record<string, unknown>>;
  }>) {
    const name = (c.name || "").toLowerCase();
    const desc = (c.description || "").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) score += 3;
      else if (desc.includes(t)) score += 1;
    }
    if (score >= 3 && (!best || score > best.score)) {
      best = { name: c.name, score, products: c.products ?? [] };
    }
  }
  if (!best) return [];

  return best.products
    .slice(0, Math.max(1, limit))
    .map((p) =>
      toCatalogProduct({
        ...(p as {
          id: string;
          name: string;
          description: string;
          price: number | null;
          currency: string;
          imageUrl: string;
          tags: string;
          isAvailable: boolean;
        }),
        category: { name: best!.name },
      })
    );
}

/**
 * (b) Extract an explicit budget from free text: "under 500", "below ৳1000",
 * "around $20", "500 taka", "budget 1500". Returns the number or null.
 * Currency conversion is NOT attempted (single-currency tenants are the
 * norm); the band match compares raw numbers — documented limitation.
 */
export function extractBudget(query: string): number | null {
  const text = (query || "").toLowerCase();
  const toNum = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // "under 500", "below \u09f31,000", "around $20", "budget 1500" — number in group 2.
  const kw = text.match(
    /(under|below|less than|around|about|up ?to|within|budget|max(?:imum)?)\s*[\u09f3$]?\s*(\d[\d,]*)/
  );
  if (kw) return toNum(kw[2]);
  // "500 taka", "1000\u09f3", "$20" — number in group 1.
  const unit = text.match(/(\d[\d,]*)\s*(taka|tk|\u09f3|bdt|usd|\$)/);
  if (unit) return toNum(unit[1]);
  return null;
}

/** (b) Available products priced within +/-tolerance of the budget, closest first. */
export async function productsInPriceBand(
  budget: number,
  tolerance = 0.3,
  limit = 3
): Promise<CatalogProduct[]> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "productsInPriceBand");

  const lo = budget * (1 - tolerance);
  const hi = budget * (1 + tolerance);
  const products =
    (await prisma.product.findMany({
      where: { isAvailable: true },
      include: { category: { select: { name: true } } },
      take: 60,
    })) ?? [];

  return products
    .filter((p) => p.price != null && p.price >= lo && p.price <= hi)
    .sort((a, b) => Math.abs((a.price ?? 0) - budget) - Math.abs((b.price ?? 0) - budget))
    .slice(0, Math.max(1, limit))
    .map((p) => toCatalogProduct(p));
}

/**
 * (b) findAlternatives — the retain path. Exact/name match first; then
 * budget-band (+/-30% of an explicit budget in the query); then the closest
 * category's items; then anything available. The caller presents these as
 * cards with the retain phrasing — never a bare "not available".
 */
export type AlternativeReason =
  | "direct_match"
  | "budget_band"
  | "category_fallback"
  | "catalog_fallback"
  | "catalog_empty";

export async function findAlternatives(
  query: string,
  limit = 3
): Promise<{ products: CatalogProduct[]; reason: AlternativeReason }> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "findAlternatives");

  const direct = await matchProductsInMessage(query, limit);
  if (direct.length > 0) return { products: direct, reason: "direct_match" };

  const budget = extractBudget(query);
  if (budget !== null) {
    const band = await productsInPriceBand(budget, 0.3, limit);
    if (band.length > 0) return { products: band, reason: "budget_band" };
  }

  const catProducts = await matchCategoryProducts(query, limit);
  if (catProducts.length > 0) return { products: catProducts, reason: "category_fallback" };

  const any = await listAvailableProducts(limit);
  return {
    products: any,
    reason: any.length > 0 ? "catalog_fallback" : "catalog_empty",
  };
}

/** (b) Heuristic: does this message look like a product/service inquiry? */
const INQUIRY_PATTERN =
  /(want|need|buy|order|price|cost|have|has|sell|looking for|do you have|is there|available|show me|give me|চাই|লাগবে|কিনতে|দাম|আছে|পাওয়া যাবে|দেখান)/i;

export function looksLikeProductInquiry(text: string): boolean {
  return INQUIRY_PATTERN.test(text || "");
}

/**
 * (b) The retain line in the customer's language (user's phrasing pattern):
 * "এই মুহূর্তে এই প্রোডাক্টটা এভেলেবেল নেই, কিন্তু আমাদের কাছে এই প্রোডাক্টগুলো আছে"
 */
export function retainLineFor(message: string): string {
  return /[\u0980-\u09FF]/.test(message || "")
    ? "আপনি যা খুঁজছেন তা এই মুহূর্তে এভেলেবেল নেই, কিন্তু আমাদের কাছে এই প্রোডাক্টগুলো আছে:"
    : "What you're looking for isn't available right now, but we do have these:";
}

/* ------------------------- (a) AUTO-CATEGORIES ------------------------- */

export interface AutoCategoryPlan {
  /** Display name (rule-based; optionally AI-refined). */
  name: string;
  productIds: string[];
  /** Human-readable reason, e.g. 'keyword "cake"' / 'shared tag "birthday"'. */
  basis: string;
}

export interface AutoCategorizeResult {
  created: { id: string; name: string }[];
  reused: { id: string; name: string }[];
  /** Products newly assigned to a category. */
  assigned: number;
  groups: AutoCategoryPlan[];
}

/** Curated product-type signals -> display name (EN + common BN keywords). */
const CATEGORY_KEYWORDS: Array<{ match: RegExp; name: string }> = [
  { match: /\bcakes?\b|কেক/, name: "Cakes" },
  { match: /\bbreads?\b|পাউরুটি|বান/, name: "Breads & Bakery" },
  { match: /\bpastries?\b|পেস্ট্রি/, name: "Pastries" },
  { match: /\bpizzas?\b/, name: "Pizza" },
  { match: /\bburgers?\b/, name: "Burgers" },
  { match: /\bbiryanis?\b|বিরিয়ানি/, name: "Biryani" },
  { match: /\bkacchi\b|কাচ্চি/, name: "Kacchi" },
  { match: /\bteas?\b|চা/, name: "Tea & Beverages" },
  { match: /\bcoffees?\b|কফি/, name: "Coffee" },
  { match: /\bjuices?\b|জুস|শরবত/, name: "Juices" },
  { match: /\bshirts?\b|শার্ট/, name: "Shirts" },
  { match: /\bpants\b|trousers|প্যান্ট/, name: "Pants" },
  { match: /\bdress(es)?\b|পোশাক|জামা/, name: "Dresses" },
  { match: /\bsarees?\b|শাড়ি/, name: "Sarees" },
  { match: /\bhijabs?\b|হিজাব/, name: "Hijabs" },
  { match: /\bphones?\b|mobiles?\b|মোবাইল/, name: "Phones" },
  { match: /\blaptops?\b|ল্যাপটপ/, name: "Laptops" },
  { match: /\bchargers?\b|চার্জার/, name: "Chargers & Accessories" },
  { match: /\bmedicines?\b|ঔষধ|ওষুধ/, name: "Medicines" },
  { match: /\brides?\b|ভাড়া/, name: "Rides" },
  { match: /\bcouriers?\b|parcels?\b|কুরিয়ার/, name: "Courier" },
  { match: /\bcleaning\b/, name: "Cleaning Services" },
  { match: /\brepair\b|মেরামত/, name: "Repair Services" },
];

const CATEGORY_STOPWORDS = new Set([
  "the", "and", "for", "with", "our", "new", "best", "fresh", "special",
  "premium", "classic", "small", "large", "medium", "free", "home", "made",
]);

function titleCaseTag(tag: string): string {
  return tag
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export interface PlannableProduct {
  id: string;
  name: string;
  description: string;
  price: number | null;
  tags: string;
}

/**
 * Pure, deterministic grouping (no AI, no DB writes) — easy to unit test.
 * Signals, in priority order:
 *  1. product-type keywords (name/description/tags) -> curated names
 *  2. shared significant tags -> tag-named groups (union-find merge)
 *  3. leftovers: no price -> "Services", else -> "Others"
 * Singletons merge into "Others" to keep the shelf beautiful.
 */
export function planAutoCategories(products: PlannableProduct[]): AutoCategoryPlan[] {
  const groups: AutoCategoryPlan[] = [];
  const assigned = new Set<string>();
  const byId = new Map(products.map((p) => [p.id, p]));

  const signalOf = (p: PlannableProduct) =>
    `${p.name} ${p.description} ${p.tags}`.toLowerCase();

  // 1. keyword signals
  for (const p of products) {
    const signal = signalOf(p);
    const hit = CATEGORY_KEYWORDS.find((k) => k.match.test(signal));
    if (hit) {
      let g = groups.find((x) => x.name === hit.name);
      if (!g) {
        g = { name: hit.name, productIds: [], basis: `product-type signal` };
        groups.push(g);
      }
      g.productIds.push(p.id);
      assigned.add(p.id);
    }
  }

  // 2. tag clustering for the rest (union-find over shared significant tags)
  const rest = products.filter((p) => !assigned.has(p.id));
  const tagsOf = (p: PlannableProduct) =>
    normTags(p.tags)
      .split(/[\s,]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 2 && !CATEGORY_STOPWORDS.has(t));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const px = parent.get(x) ?? x;
    if (px !== x) parent.set(x, find(px));
    return parent.get(x) ?? x;
  };
  const tagOwners = new Map<string, string[]>();
  for (const p of rest) {
    for (const t of tagsOf(p)) {
      const owners = tagOwners.get(t) ?? [];
      owners.push(p.id);
      tagOwners.set(t, owners);
    }
  }
  for (const owners of tagOwners.values()) {
    for (let i = 1; i < owners.length; i++) {
      const a = find(owners[0]);
      const b = find(owners[i]);
      if (a !== b) parent.set(a, b);
    }
  }
  const clusters = new Map<string, string[]>();
  for (const p of rest) {
    const root = find(p.id);
    const list = clusters.get(root) ?? [];
    list.push(p.id);
    clusters.set(root, list);
  }
  for (const ids of clusters.values()) {
    if (ids.length < 2) continue; // singletons -> Others below
    // Name = most frequent significant tag in the cluster.
    const counts = new Map<string, number>();
    for (const id of ids) {
      for (const t of tagsOf(byId.get(id)!)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const name = top ? titleCaseTag(top[0]) : "Others";
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, productIds: [], basis: `shared tag "${top?.[0] ?? ""}"` };
      groups.push(g);
    }
    g.productIds.push(...ids);
    ids.forEach((id) => assigned.add(id));
  }

  // 3. leftovers
  const leftover = products.filter((p) => !assigned.has(p.id));
  let liveGroups = groups.filter((g) => g.productIds.length > 0);
  // Keep the shelf beautiful: when the plan explodes into many tiny groups,
  // singletons merge into "Others". Small catalogs keep every group.
  if (liveGroups.length > 4) {
    const singles: string[] = [];
    liveGroups = liveGroups.filter((g) => {
      if (g.productIds.length <= 1) {
        singles.push(...g.productIds);
        g.productIds.forEach((id) => assigned.delete(id));
        return false;
      }
      return true;
    });
    for (const id of singles) {
      const prod = byId.get(id);
      if (prod && !leftover.includes(prod)) leftover.push(prod);
    }
  }
  const noPrice = leftover.filter((p) => p.price == null).map((p) => p.id);
  const others = leftover.filter((p) => p.price != null).map((p) => p.id);
  if (noPrice.length > 0) {
    liveGroups.push({ name: "Services", productIds: noPrice, basis: "no fixed price (service-like)" });
  }
  if (others.length > 0) {
    liveGroups.push({ name: "Others", productIds: others, basis: "fallback" });
  }
  return liveGroups;
}

/**
 * AI seam: when the business has an OpenAI key, ask for better display names
 * for the rule-built groups. One small JSON call; ANY failure -> rule names.
 * Uses the business's own configured key (their spend, their action).
 */
export async function refineCategoryNamesWithAI(
  groups: AutoCategoryPlan[],
  productsById: Map<string, PlannableProduct>,
  apiKey: string,
  model: string
): Promise<Map<number, string>> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });
  const summary = groups.map((g, i) => ({
    index: i,
    currentName: g.name,
    items: g.productIds
      .slice(0, 6)
      .map((id) => productsById.get(id)?.name ?? id),
  }));
  const response = await client.chat.completions.create({
    model: /^(gpt-4o|gpt-4\.1|o1|o3|gpt-5)/.test(model) ? model : "gpt-4o-mini",
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content:
          "You are naming product categories for a small business storefront. " +
          "Given these product groups (JSON), return a JSON object mapping each group index " +
          'to a SHORT, beautiful display name (2-3 words max), e.g. {"0": "Cakes", "1": "Fresh Breads"}. ' +
          "Keep names in the same language as the product names. " +
          "Do not merge or split groups, only rename.\n\n" +
          JSON.stringify(summary),
      },
    ],
  });
  const text = response.choices[0]?.message?.content?.trim() ?? "{}";
  const parsed = JSON.parse(text) as Record<string, string>;
  const out = new Map<number, string>();
  for (const [k, v] of Object.entries(parsed)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < groups.length && typeof v === "string" && v.trim()) {
      out.set(i, v.trim().slice(0, 40));
    }
  }
  return out;
}

/**
 * (a) Auto-build beautiful categories from the product list — no manual
 * category creation required. Tenant fail-closed. Writes real
 * productCategory rows and assigns product.categoryId.
 *
 * mode "fill" (default): only categorize currently-uncategorized products,
 * never touching the owner's manual assignments.
 * mode "rebuild": re-plan and re-assign EVERYTHING (owner's explicit choice).
 */
export async function autoCategorizeProducts(opts?: {
  mode?: "fill" | "rebuild";
  aiApiKey?: string;
  aiModel?: string;
}): Promise<AutoCategorizeResult> {
  const businessId = getBusinessId();
  if (!businessId) throw new TenantContextError("product", "autoCategorizeProducts");

  const mode = opts?.mode === "rebuild" ? "rebuild" : "fill";

  const allProducts = (await prisma.product.findMany({
    where: mode === "fill" ? { categoryId: null } : {},
    select: { id: true, name: true, description: true, price: true, tags: true, categoryId: true },
    take: 200,
  })) ?? [];

  const plannable: PlannableProduct[] = allProducts.map((p) => ({
    id: p.id,
    name: p.name ?? "",
    description: p.description ?? "",
    price: p.price ?? null,
    tags: p.tags ?? "",
  }));
  const groups = planAutoCategories(plannable);

  // AI name refinement (graceful: rule names on any failure / no key).
  if (opts?.aiApiKey && groups.length > 0) {
    try {
      const byId = new Map(plannable.map((p) => [p.id, p]));
      const renames = await refineCategoryNamesWithAI(
        groups,
        byId,
        opts.aiApiKey,
        opts.aiModel || "gpt-4o-mini"
      );
      renames.forEach((name, i) => {
        groups[i].name = name;
      });
    } catch {
      /* rule-based names stand */
    }
  }

  const existing = ((await prisma.productCategory.findMany({ take: 100 })) ?? []) as Array<{
    id: string;
    name: string;
  }>;
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));

  const created: { id: string; name: string }[] = [];
  const reused: { id: string; name: string }[] = [];
  let assigned = 0;

  for (const g of groups) {
    if (g.productIds.length === 0) continue;
    let cat = byName.get(g.name.toLowerCase());
    if (!cat) {
      const made = await createCategory(g.name, `Auto-built (${g.basis})`);
      cat = { id: made.id, name: made.name };
      byName.set(g.name.toLowerCase(), cat);
      created.push({ id: cat.id, name: cat.name });
    } else {
      reused.push({ id: cat.id, name: cat.name });
    }
    // Assign (tenant-scoped by the proxy).
    await prisma.product.updateMany({
      where: { id: { in: g.productIds } },
      data: { categoryId: cat.id },
    });
    assigned += g.productIds.length;
  }

  return { created, reused, assigned, groups };
}
