/**
 * photo-match.ts — LEG H, Presswayy-video round 2 (STAGED ONLY, not merged).
 *
 * Photo / screenshot -> single catalog match for a customer chat turn.
 *
 * This EXTENDS the staged reels/photos training leg (Presswayy Leg E),
 * it does not duplicate it: Leg E trains the agent FROM tenant media
 * (media -> knowledge entries, prices stripped). This leg answers a
 * customer who SENDS a photo or screenshot, by matching what the photo
 * shows against the business's own catalog and answering ONLY from the
 * matched catalog record (catalog photo, catalog price, stock truth).
 *
 * Anchored to AI repo HEAD 706df0fdf26f58fffc3630626497124768327c53
 * (branch main, re-verified live 2026-10-25). At that HEAD the pieces
 * this file builds on are real code, verified by reading HEAD blobs:
 *   - `src/lib/ai/media.ts` describeImageWithVision() / perceiveMedia():
 *     the vision provider chain (OpenAI / Groq vision / Gemini failover).
 *     No key -> honest "no AI provider key configured" error, never a
 *     faked description. This leg does NOT re-implement vision.
 *   - `src/app/api/chat/vision/route.ts`: a photo already gets a vision
 *     description and a deterministic text match against the tenant
 *     catalog (matchProductsInMessage, score >= 3, top 3 cards).
 *     What it does NOT do — and what this leg adds — is: (1) a
 *     photo-grade threshold with an ambiguity rule, so a weak or tied
 *     result never presents as a match; (2) an honest "no match found"
 *     fallback that asks for the product name instead of showing
 *     possibly-wrong cards; (3) any stock statement at all; (4) any
 *     guard against repeating a price the vision model read off a
 *     screenshot (the old reply echoes the raw description, which can
 *     carry a screenshot price that is NOT the catalog price).
 *   - `src/lib/catalog.ts` CatalogProduct: id, name, description,
 *     price (number|null), currency, imageUrl, tags (string[]),
 *     isAvailable, categoryName. Product has NO stock field at HEAD.
 *   - Inventory batch (staged, NOT landed): StockLevel
 *     { businessId, productId, variantKey, quantityOnHand, ... }.
 *     This file consumes exactly that shape through the StockLevelLike
 *     interface below; it never invents a quantity.
 *   - `src/lib/ai/providers.ts`: NO embedding function exists at HEAD
 *     (grep: zero "embed" hits). The embedding seam in section 5 is
 *     therefore an interface + a thresholded pure matcher + a
 *     key-configured check — the provider implementation and stored
 *     catalog vectors are follow-up work, NOT claimed done.
 *
 * HARD RULES ENFORCED HERE (pure logic, harness-tested):
 *   1. Tenant scoping, fail-closed: every catalog row must carry the
 *      caller's businessId; a foreign or missing businessId throws
 *      before any scoring. Wrong-tenant catalog rows are never matched.
 *   2. Never guess a product: a result is a match only when the best
 *      score clears the threshold AND clears the runner-up by the
 *      margin AND has a name-or-tag hit. Below threshold, tied, or
 *      name/tag-less results are "no_match" — the answer then contains
 *      NO product at all and asks the customer for the product name.
 *   3. Answer from the matched record only: name, price, currency,
 *      catalog photo (imageUrl) and description come from the catalog
 *      row. Vision text is never a source of price, brand, or stock.
 *      Any currency amount in vision text is stripped before it is
 *      echoed, so a screenshot price can never leak into an answer.
 *   4. Stock from stock truth only: quantityOnHand > 0 -> in stock;
 *      0 -> out of stock; no stock record -> "unknown" (the answer
 *      says stock is not confirmed and the team will confirm — it
 *      never says "in stock" by guess). A null price -> no price line
 *      at all, never an invented figure.
 *   5. Product matching only, never person identification: person
 *      words are dropped from the descriptor before scoring, the
 *      descriptor has no person fields, and a description that yields
 *      no product terms is "no_product_signal". Nothing here names,
 *      describes, or matches a person.
 *   6. No commerce side effects: this file cannot create, confirm,
 *      edit, or price anything. It produces a match + an answer
 *      shape; the caller owns auth, vision, storage, and replies.
 *   7. No provider key is hardcoded anywhere. The embedding seam
 *      only reports whether a key is configured (owner launch step:
 *      keys live in the site ProviderKeys, as with vision today);
 *      it performs no provider call until that build lands.
 *
 * USER-FACING WORDING: every reply line produced here is PROPOSAL
 * text for owner approval (no invented copy ships silently). Price
 * lines use the catalog currency CODE (e.g. BDT) — no currency
 * symbol is hardcoded anywhere in this file.
 */

/** One tenant catalog row, as the matcher needs it. Mirrors HEAD
 *  CatalogProduct plus the businessId the tenant guard checks. */
export interface CatalogMatchProduct {
  id: string;
  businessId: string;
  name: string;
  description: string;
  price: number | null;
  currency: string;
  imageUrl: string;
  tags: string[];
  isAvailable: boolean;
  categoryName: string | null;
}

/** Stock truth shape, mirroring the staged inventory-batch StockLevel
 *  (businessId, productId, variantKey, quantityOnHand). Only the
 *  fields the answer needs are required here. */
export interface StockLevelLike {
  businessId: string;
  productId: string;
  variantKey?: string;
  quantityOnHand: number;
}

export type PhotoSourceKind = "photo" | "screenshot";

export type StockState = "in_stock" | "out_of_stock" | "unknown" | "unavailable";

export type NoMatchReason =
  | "catalog_empty"
  | "no_available_product"
  | "no_product_signal"
  | "no_name_or_tag_hit"
  | "below_threshold"
  | "ambiguous";

export interface PhotoDescriptor {
  sourceKind: PhotoSourceKind;
  /** Deduped product-signal terms from the vision description. */
  terms: string[];
  hasProductSignal: boolean;
}

export interface ScoredProduct {
  product: CatalogMatchProduct;
  score: number;
  nameHits: number;
  tagHits: number;
}

export type PhotoMatchResult =
  | {
      status: "match";
      product: CatalogMatchProduct;
      score: number;
      runnerUpScore: number;
      margin: number;
      descriptor: PhotoDescriptor;
    }
  | {
      status: "no_match";
      reason: NoMatchReason;
      bestScore: number;
      runnerUpScore: number;
      descriptor: PhotoDescriptor;
    };

export interface PhotoMatchAnswer {
  status: "match" | "no_match";
  /** The matched catalog row, or null. A no-match answer NEVER
   *  carries a product — there is nothing to guess from. */
  product: CatalogMatchProduct | null;
  stockState: StockState | null;
  stockQuantity: number | null;
  /** True when the reply asks the customer for the product name. */
  askProductName: boolean;
  /** PROPOSAL reply lines, built from catalog/stock fields only. */
  replyLines: string[];
  /** Catalog photo to show with the answer, or null. */
  photoUrl: string | null;
  /** Price line fields, or null when the catalog price is null. */
  priceLine: { price: number; currency: string } | null;
}

/**
 * Photo-grade bar. HEAD's text matcher accepts score >= 3 (roughly
 * one solid name word) for chat text. A vision description is far
 * noisier than a customer message — filler words, colours, and
 * background objects all score — so a photo match needs more: at
 * least 6 points AND a 3-point margin over the runner-up, plus at
 * least one name-or-tag hit (description-only points never match).
 * Both numbers are staged constants the owner can retune; neither
 * is a plan quota or a usage limit.
 */
export const PHOTO_MATCH_MIN_SCORE = 6;
export const PHOTO_MATCH_MIN_MARGIN = 3;

/** Bonus when the vision text contains the product's full multi-word
 *  name verbatim (typical for a screenshot, where the name is printed
 *  on screen, and equally valid when vision reads a label). Single
 *  word names get no bonus — their term hit already counts. */
export const FULL_NAME_BONUS = 6;

/** Vision filler words: they describe the picture, not the product,
 *  so they must never score. Colours, materials, and object words
 *  are deliberately NOT on this list. */
const GENERIC_VISION_TERMS = new Set([
  "photo", "image", "picture", "screenshot", "shows", "showing", "shown",
  "visible", "looks", "looking", "appears", "background", "foreground",
  "front", "side", "view", "closeup", "close", "taken", "shot", "frame",
  "video", "clip", "product", "item", "object", "thing", "text", "reads",
  "says", "written",
]);

/** Person words, dropped before scoring (rule 5). A photo of a person
 *  wearing or holding a product still matches on the PRODUCT words;
 *  a photo that yields only person words yields no product signal. */
const PERSON_TERMS = new Set([
  "person", "people", "man", "woman", "boy", "girl", "child", "baby",
  "face", "smiling", "smile",
]);

/**
 * Currency-amount pattern, mirroring the PRICE_RE in HEAD scrape.ts
 * and staged Leg E media-index.ts: ৳ / Tk / BDT / taka / $ / USD
 * amounts. Anything matching is a price claim and must not survive
 * into an echoed vision description or an answer.
 */
const PRICE_RE =
  /(৳|Tk\.?|BDT|taka|US\$|\$|USD)\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(৳|Tk\.?|BDT|taka|US\$|\$|USD)/gi;

export function extractPriceClaims(text: string): string[] {
  const found = text.match(PRICE_RE);
  return found ? found : [];
}

export function stripPriceClaims(text: string): { text: string; stripped: boolean } {
  const stripped = extractPriceClaims(text).length > 0;
  return { text: text.replace(PRICE_RE, "[price withheld]"), stripped };
}

/** Tokenizer mirroring HEAD catalog.ts: lowercase, Latin + Bengali
 *  letters and digits, tokens longer than 2 characters. */
function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09FF]+/u)
    .filter((t) => t.length > 2);
}

function normalizeName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09FF]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the match descriptor from a vision description. Terms are
 * deduped on purpose: a vision model repeating one word ("kurta
 * kurta kurta") is not stronger evidence than saying it once, and
 * without dedup the threshold could be cleared by repetition alone.
 */
export function buildPhotoDescriptor(
  description: string,
  sourceKind: PhotoSourceKind = "photo"
): PhotoDescriptor {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of tokenize(description || "")) {
    if (GENERIC_VISION_TERMS.has(term)) continue;
    if (PERSON_TERMS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return { sourceKind, terms, hasProductSignal: terms.length > 0 };
}

/**
 * Score ONE catalog row against the descriptor, mirroring HEAD
 * catalog.ts weights: name 3, tags 2, description/category 1 per
 * term, first matching field wins per term. Full multi-word name
 * appearing verbatim in the vision text adds FULL_NAME_BONUS.
 */
export function scoreCatalogProduct(
  product: CatalogMatchProduct,
  descriptor: PhotoDescriptor,
  rawDescription: string
): ScoredProduct {
  const name = (product.name || "").toLowerCase();
  const desc = (product.description || "").toLowerCase();
  const tags = (product.tags || []).join(" ").toLowerCase();
  const cat = (product.categoryName || "").toLowerCase();
  let score = 0;
  let nameHits = 0;
  let tagHits = 0;
  for (const term of descriptor.terms) {
    if (name.includes(term)) {
      score += 3;
      nameHits += 1;
    } else if (tags.includes(term)) {
      score += 2;
      tagHits += 1;
    } else if (desc.includes(term)) {
      score += 1;
    } else if (cat.includes(term)) {
      score += 1;
    }
  }
  const normalizedName = normalizeName(product.name);
  if (
    normalizedName.indexOf(" ") !== -1 &&
    normalizeName(rawDescription || "").indexOf(normalizedName) !== -1
  ) {
    score += FULL_NAME_BONUS;
  }
  return { product, score, nameHits, tagHits };
}

/**
 * Fail-closed tenant guard. Call before scoring: a catalog row from
 * another tenant (or a tenant-less call) throws, so a wrong-tenant
 * row can never be matched, however well it scores.
 */
export function assertCatalogTenant(
  products: CatalogMatchProduct[],
  businessId: string
): void {
  if (!businessId || !businessId.trim()) {
    throw new Error("Tenant context is missing");
  }
  for (const product of products) {
    if (!product.businessId || product.businessId !== businessId) {
      throw new Error("Catalog entry belongs to a different tenant");
    }
  }
}

/**
 * The match decision. Returns exactly one product, or no product at
 * all — never a ranked list presented as an answer, never a tie
 * broken by catalog order. `description` is the vision description
 * text (the provider's words); `products` must already be the
 * caller's own tenant catalog (guard re-checked here).
 */
export function matchPhotoToCatalog(
  description: string,
  products: CatalogMatchProduct[],
  businessId: string,
  sourceKind: PhotoSourceKind = "photo"
): PhotoMatchResult {
  assertCatalogTenant(products, businessId);
  const descriptor = buildPhotoDescriptor(description, sourceKind);
  if (products.length === 0) {
    return {
      status: "no_match",
      reason: "catalog_empty",
      bestScore: 0,
      runnerUpScore: 0,
      descriptor,
    };
  }
  const available = products.filter((p) => p.isAvailable);
  if (available.length === 0) {
    return {
      status: "no_match",
      reason: "no_available_product",
      bestScore: 0,
      runnerUpScore: 0,
      descriptor,
    };
  }
  if (!descriptor.hasProductSignal) {
    return {
      status: "no_match",
      reason: "no_product_signal",
      bestScore: 0,
      runnerUpScore: 0,
      descriptor,
    };
  }
  const scored = available
    .map((p) => scoreCatalogProduct(p, descriptor, description || ""))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUpScore = scored.length > 1 ? scored[1].score : 0;
  const margin = best.score - runnerUpScore;
  if (best.nameHits === 0 && best.tagHits === 0) {
    return {
      status: "no_match",
      reason: "no_name_or_tag_hit",
      bestScore: best.score,
      runnerUpScore,
      descriptor,
    };
  }
  if (best.score < PHOTO_MATCH_MIN_SCORE) {
    return {
      status: "no_match",
      reason: "below_threshold",
      bestScore: best.score,
      runnerUpScore,
      descriptor,
    };
  }
  if (margin < PHOTO_MATCH_MIN_MARGIN) {
    return {
      status: "no_match",
      reason: "ambiguous",
      bestScore: best.score,
      runnerUpScore,
      descriptor,
    };
  }
  return {
    status: "match",
    product: best.product,
    score: best.score,
    runnerUpScore,
    margin,
    descriptor,
  };
}

/** Tenant guard for a stock record: a stock row for another product's
 *  tenant must never set the answer's stock line. */
export function assertStockTenant(stock: StockLevelLike, businessId: string): void {
  if (!businessId || !businessId.trim()) {
    throw new Error("Tenant context is missing");
  }
  if (!stock.businessId || stock.businessId !== businessId) {
    throw new Error("Stock record belongs to a different tenant");
  }
}

/**
 * Stock truth -> answer state. `null` means no stock record exists
 * for this product (HEAD has no stock field; the inventory batch is
 * staged, not landed) — and that means "unknown", never "in stock".
 * A negative quantity cannot exist per the inventory guard; it is
 * treated as out of stock rather than crashing the answer.
 */
export function resolveStockState(
  stock: StockLevelLike | null,
  isAvailable: boolean
): StockState {
  if (!isAvailable) return "unavailable";
  if (stock === null) return "unknown";
  if (stock.quantityOnHand <= 0) return "out_of_stock";
  return "in_stock";
}

/**
 * Build the customer-facing answer from the match + stock truth.
 * Every field comes from the matched catalog row or the stock
 * record — nothing comes from vision text. A null catalog price
 * yields a null priceLine (the caller shows no price line); an
 * unknown stock state yields the "team will confirm" line, never
 * an availability claim. No-match answers carry no product, no
 * photo, and no price, and always ask for the product name.
 * All lines are PROPOSAL wording for owner approval.
 */
export function buildPhotoMatchAnswer(
  result: PhotoMatchResult,
  stock: StockLevelLike | null
): PhotoMatchAnswer {
  if (result.status === "no_match") {
    const ambiguous = result.reason === "ambiguous";
    return {
      status: "no_match",
      product: null,
      stockState: null,
      stockQuantity: null,
      askProductName: true,
      photoUrl: null,
      priceLine: null,
      replyLines: ambiguous
        ? [
            "This photo matches more than one similar product, so I don't want to guess which one you mean.",
            "Could you please tell me the product name?",
          ]
        : [
            "I couldn't find a matching product in our catalog from this photo.",
            "Could you please tell me the product name?",
          ],
    };
  }
  const product = result.product;
  const stockState = resolveStockState(stock, product.isAvailable);
  const stockQuantity = stock === null ? null : stock.quantityOnHand;
  const priceLine =
    product.price === null
      ? null
      : { price: product.price, currency: product.currency };
  const lines: string[] = ["This matches a product in our catalog:", product.name];
  if (priceLine !== null) {
    lines.push("Price: " + priceLine.currency + " " + priceLine.price);
  }
  if (stockState === "in_stock") {
    lines.push(
      stockQuantity !== null
        ? "In stock (" + stockQuantity + " available)."
        : "In stock."
    );
  } else if (stockState === "out_of_stock") {
    lines.push("Currently out of stock.");
  } else if (stockState === "unavailable") {
    lines.push("This product is not currently offered.");
  } else {
    lines.push("Stock is not confirmed yet — our team will confirm availability.");
  }
  return {
    status: "match",
    product,
    stockState,
    stockQuantity,
    askProductName: false,
    photoUrl: product.imageUrl || null,
    priceLine,
    replyLines: lines,
  };
}

/* =====================================================================
 * SECTION 5 — Embedding provider seam (PROPOSED, not a live path).
 *
 * At HEAD there is no embedding function in providers.ts and no
 * stored catalog vectors, so no embedding match can run today. This
 * seam fixes the interface the future provider implementation must
 * satisfy, so the descriptor matcher above can later be joined (or
 * replaced, by owner decision) by a vector matcher without changing
 * callers' tenant, threshold, or no-guess rules:
 *   - isEmbeddingConfigured() reports whether a key is configured
 *     — the owner launch step supplies keys through the site
 *     ProviderKeys, exactly as vision keys work today. A key is
 *     never hardcoded and never appears in fixtures. Even when a
 *     key IS configured, no provider call exists yet, so callers
 *     must still use the descriptor matcher until the provider
 *     implementation lands; this function never pretends otherwise.
 *   - matchByEmbedding() requires an explicit threshold argument;
 *     an absent threshold throws instead of silently defaulting,
 *     mirroring the no-invented-defaults discipline.
 *   - cosineSimilarity() is pure and returns null on dimension
 *     mismatch or zero vectors instead of a misleading score.
 * The descriptor matcher in sections 1-4 is the shipped path; this
 * seam ships no provider call, no stored vector, and no live match.
 * ===================================================================== */

/** Sentinel returned (as an error code by callers) when embedding is
 *  asked for but no provider key is configured. */
export const EMBEDDING_NOT_CONFIGURED = "embedding_provider_not_configured";

export interface ImageEmbeddingProvider {
  embedImage(bytes: Uint8Array, mimeType: string): Promise<number[] | null>;
  embedText(text: string): Promise<number[] | null>;
}

/**
 * Report whether an embedding key is configured, without holding or
 * using it. True means "a key exists", NOT "embedding matching
 * works" — the provider implementation is still follow-up work, so
 * callers use the descriptor matcher either way until it lands.
 * This function performs no network call and stores no key.
 */
export function isEmbeddingConfigured(config: {
  apiKey?: string | null;
}): boolean {
  return !!config.apiKey && !!config.apiKey.trim();
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface EmbeddingCandidate {
  product: CatalogMatchProduct;
  embedding: number[];
}

/**
 * Thresholded vector match over one tenant's catalog. Same no-guess
 * contract as the descriptor matcher: below threshold, or a missing
 * threshold, yields no product — never the closest row regardless.
 */
export function matchByEmbedding(
  queryEmbedding: number[],
  candidates: EmbeddingCandidate[],
  businessId: string,
  threshold: number
): PhotoMatchResult {
  if (threshold === undefined || threshold === null || !isFinite(threshold)) {
    throw new Error("Embedding threshold is required: no default is assumed");
  }
  const products = candidates.map((c) => c.product);
  assertCatalogTenant(products, businessId);
  const descriptor: PhotoDescriptor = {
    sourceKind: "photo",
    terms: [],
    hasProductSignal: false,
  };
  if (candidates.length === 0) {
    return {
      status: "no_match",
      reason: "catalog_empty",
      bestScore: 0,
      runnerUpScore: 0,
      descriptor,
    };
  }
  const scored: Array<{ product: CatalogMatchProduct; score: number }> = [];
  for (const candidate of candidates) {
    if (!candidate.product.isAvailable) continue;
    const similarity = cosineSimilarity(queryEmbedding, candidate.embedding);
    if (similarity === null) continue;
    scored.push({ product: candidate.product, score: similarity });
  }
  if (scored.length === 0) {
    return {
      status: "no_match",
      reason: "no_available_product",
      bestScore: 0,
      runnerUpScore: 0,
      descriptor,
    };
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUpScore = scored.length > 1 ? scored[1].score : 0;
  if (best.score < threshold) {
    return {
      status: "no_match",
      reason: "below_threshold",
      bestScore: best.score,
      runnerUpScore,
      descriptor,
    };
  }
  return {
    status: "match",
    product: best.product,
    score: best.score,
    runnerUpScore,
    margin: best.score - runnerUpScore,
    descriptor,
  };
}

/**
 * PROPOSAL vision question for a future product-only perception pass.
 * NOT wired by the staged route diff: changing the question means
 * touching HEAD media.ts perceiveMedia(), a separate diff for owner
 * approval. Until then the route uses HEAD's question and this
 * module's descriptor filter (person words dropped, price claims
 * stripped) is the guard that runs. The question asks vision to
 * describe product attributes only and never to identify a person.
 */
export const PHOTO_MATCH_VISION_QUESTION_PROPOSAL =
  "Describe only the product in this photo: its type, colour, material, " +
  "any brand or text printed on the product itself, and its condition. " +
  "Do not identify any person in the photo, do not name any person, and " +
  "do not describe any person except as the wearer or holder of the product. " +
  "If no purchasable product is visible, say so plainly.";
