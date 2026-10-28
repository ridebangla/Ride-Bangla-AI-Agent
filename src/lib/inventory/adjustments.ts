/**
 * LEG D (inventory batch, STAGED ONLY) — Manual stock adjustment by
 * chat-style command, TENANT/STAFF AUTHORITY ONLY.
 *
 * What this module is:
 *   A pure command parser + authority gate + adjustment planner for
 *   terse staff messages such as "1 sold", "2 sold", "added 10".
 *   It contains NO database, NO network, NO price, NO fare, NO total,
 *   and NO agent-tool code. It never runs inside the public visitor
 *   widget: the only staged transport is the dashboard route
 *   `src/app/api/inventory/adjustments/route.ts`, which requires
 *   dashboard auth (`requireAuth`, `knowledge:update`). A customer
 *   sender is refused here BEFORE any parsing or product resolution,
 *   so a customer command can never leak whether a product exists
 *   or what its stock is.
 *
 * What this module is NOT:
 *   - It is NOT a chat-teaching path. Per Leg A (onboarding) rules,
 *     chat must never supersede website/details facts. This module
 *     changes STOCK COUNTS only, never knowledge facts, prices, or
 *     product text, and it is not wired into any chat engine.
 *   - It is NOT an agent tool. No tool is added to `tools.ts`
 *     (deliberately untouched): an agent tool would be reachable
 *     from the visitor widget, which is exactly the hole this leg
 *     must not open.
 *   - It does NOT invent Leg A's internals. Stock counts and the
 *     ledger live behind the `StockStore` interface below (the
 *     Leg A seam). Until Leg A lands, the staged route answers
 *     503 `inventory_store_not_configured`.
 *
 * Safety rules, stated once and enforced in code:
 *   1. Authority first: only a staff sender passes. Customers and
 *      anonymous senders are refused with zero stock movement.
 *   2. Narrow grammar only (see GRAMMAR below). Anything outside it
 *      is clarification, never a guess.
 *   3. Product resolution is exact-match-or-refuse: one exact
 *      (normalized) name or id match applies; zero or several
 *      matches refuse/clarify. No stemming, no plural folding, no
 *      substring guessing — those would silently pick a product.
 *   4. "sold" never drives stock negative: an out-adjustment larger
 *      than current stock is REFUSED (`insufficient_stock`), not
 *      clamped to zero. Silent clamping would hide shrinkage and
 *      fabricate a zero count. The team corrects the count through
 *      a stock-in command or a recount, which is itself ledgered.
 *   5. "added" quantities must be positive integers. Zero, negative,
 *      decimal, and non-numeric quantities are refused.
 *   6. Every applied adjustment writes ONE permanent ledger entry
 *      (movement type `Adjustment`, direction, quantity, previous
 *      and new stock, reference = adjustment id, updated-by,
 *      reason). Entries are append-only: this module exports NO
 *      delete, remove, or edit function, and entries are frozen.
 *   7. Reason rule (chosen, with reason): the command text itself
 *      IS the reason when no explicit reason is given. Staff
 *      commands are terse operational messages ("1 sold"); forcing
 *      a second reason round-trip would defeat the owner's example
 *      workflow, while recording the verbatim command preserves a
 *      full audit trail. An explicit `reason` overrides it.
 *   8. No meter, no quota, no limit is added or touched anywhere.
 *   9. No fare, price, or total is read, written, or derived here.
 *
 * GRAMMAR (after normalization: Bengali digits -> ASCII, lowercased,
 * whitespace collapsed, trailing punctuation stripped, trailing
 * "হয়েছে"/"hoyeche" stripped). `<qty>` is a positive integer.
 * `<product>` is the exact catalog product name (normalized).
 * `[context]` means the caller supplies the dashboard-selected
 * product; without it the command must name the product.
 *
 *   SALE-OUT ("sold" / "বিক্রি" / "bikri"):
 *     "<qty> sold"                    [context]
 *     "<qty> <product> sold"
 *     "<qty> ta <product> sold"       (Banglish unit word)
 *     "sold <qty> <product>"
 *     "<qty> <product> bikri"
 *     "<qty> ta <product> bikri"
 *     "<qty>[টা|টি|খানা] <product> বিক্রি"
 *     "<qty>[টা|টি|খানা] বিক্রি"      [context]
 *     "বিক্রি <qty> <product>"
 *   STOCK-IN ("added" / "add" / "যোগ"):
 *     "added <qty>"                   [context]
 *     "added <qty> <product>"
 *     "add <qty> <product>"
 *     "<qty> added"                   [context]
 *     "<qty> <product> added"
 *     "<qty> ta <product> add"
 *     "<qty>[টা|টি|খানা] <product> যোগ"
 *     "<qty>[টা|টি|খানা] যোগ"        [context]
 *     "যোগ <qty> <product>"
 *
 *   Deliberately NOT accepted (clarification, never a guess):
 *     "sold" / "added" with no quantity; "sold all"; "adjust to 5"
 *     (set-to is a different, dashboard-only action, out of scope);
 *     decimals ("1.5 sold"); zero ("0 sold"); two products in one
 *     command; free-form sentences around a command.
 *
 * All user-facing strings in this module are PROPOSAL wording for
 * owner approval, never shipped copy.
 */

export type AdjustmentDirection = "out" | "in";

export type Sender =
  | { kind: "staff"; userId: string; businessId: string }
  | { kind: "customer" }
  | { kind: "anonymous" };

/** A tenant product as the store presents it. Stock is a Leg A field:
 *  HEAD's CatalogProduct has NO stock field (see LEG-REPORT §2). */
export interface StockProduct {
  id: string;
  businessId: string;
  name: string;
  /** Current on-hand count. Must be a non-negative integer. */
  stock: number;
}

/**
 * The Leg A seam. Leg A owns the real implementation (field +
 * transaction + collection). This interface is deliberately minimal:
 *   - `listProducts` returns ONLY this tenant's products.
 *   - `apply` must write the stock change AND append the ledger entry
 *     atomically, and must refuse when the product's current stock no
 *     longer equals `entry.previousStock` (optimistic-concurrency
 *     guard against two staff members adjusting at once).
 * There is intentionally NO delete, remove, or update-entry method:
 * corrections are new reversing entries (see `reverseOf` note in the
 * integration doc), never edits of history.
 */
export interface StockStore {
  listProducts(businessId: string): StockProduct[];
  apply(entry: StockLedgerEntry): { applied: true; newStock: number } | { applied: false; code: "stale_stock" };
  /** Append-only ledger read for the dashboard. Never mutated. */
  listLedger(businessId: string): readonly StockLedgerEntry[];
}

export interface StockLedgerEntry {
  /** Adjustment id; also the entry's `reference`. */
  id: string;
  businessId: string;
  productId: string;
  productName: string;
  movementType: "Adjustment";
  direction: AdjustmentDirection;
  quantity: number;
  previousStock: number;
  newStock: number;
  /** Always equals `id`. */
  reference: string;
  updatedBy: string;
  /** Explicit reason, or the verbatim command text (rule 7). */
  reason: string;
  /** Verbatim command text as typed by staff. */
  rawCommand: string;
  createdAt: string;
}

export type AdjustmentRefusalCode =
  | "customer_forbidden"
  | "unrecognized"
  | "invalid_quantity"
  | "needs_product"
  | "product_not_found"
  | "product_ambiguous"
  | "insufficient_stock";

export interface ParsedCommand {
  direction: AdjustmentDirection;
  quantity: number;
  /** Null when the command names no product (dashboard context needed). */
  productText: string | null;
  rawCommand: string;
}

export type ParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; code: "unrecognized" | "invalid_quantity" };

export interface AdjustmentPlan {
  direction: AdjustmentDirection;
  quantity: number;
  product: StockProduct;
  previousStock: number;
  newStock: number;
  rawCommand: string;
}

export type PlanResult =
  | { allowed: true; plan: AdjustmentPlan }
  | { allowed: false; code: AdjustmentRefusalCode; detail: string };

/** PROPOSAL wording — owner approval required before any UI uses it. */
export const PROPOSAL_CUSTOMER_REFUSAL =
  "You can place an order and our team will confirm it. Stock changes are made by the shop team.";
export const PROPOSAL_CLARIFICATION =
  "I could not tell which product or how many you meant. Please send one adjustment like \"2 cake sold\" or \"added 10 cake\".";
export const PROPOSAL_INSUFFICIENT_STOCK =
  "That sale is larger than the current stock, so nothing was changed. Please check the count and try again, or add stock first.";

const BENGALI_DIGITS: Record<string, string> = {
  "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4",
  "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9",
};

function toAsciiDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => BENGALI_DIGITS[d] ?? d);
}

/** Normalize command text for matching (not for storage: rawCommand
 *  keeps the staff member's original typing). */
export function normalizeCommandText(text: string): string {
  let t = toAsciiDigits(text.trim().toLowerCase());
  t = t.replace(/\s+/g, " ");
  t = t.replace(/[.!।?]+$/g, "");
  t = t.replace(/\s+(হয়েছে|hoyeche)$/g, "");
  return t.trim();
}

/** Normalize a product name for exact comparison. No stemming. */
export function normalizeProductName(name: string): string {
  return toAsciiDigits(name.trim().toLowerCase()).replace(/\s+/g, " ");
}

/** Strip a leading unit word ("ta", "ti", "টা", "টি", "খানা") from a
 *  captured product fragment, e.g. "ta cake" -> "cake". */
function stripUnitWord(fragment: string): string {
  return fragment.replace(/^(ta|ti|টা|টি|খানা)\s+/g, "").trim();
}

type Pattern = {
  direction: AdjustmentDirection;
  re: RegExp;
  /** Index of the quantity group, or -1 when the pattern has none. */
  qty: number;
  /** Index of the product group, or -1 when the command names none. */
  product: number;
};

/* Order matters: context-free (product-naming) patterns that could also
 * match a shorter shape are tried after the more specific ones. Every
 * pattern is fully anchored — trailing free text never matches. */
const PATTERNS: Pattern[] = [
  // SALE-OUT
  { direction: "out", re: /^(\d+) sold$/, qty: 1, product: -1 },
  { direction: "out", re: /^(\d+) ta (.+) sold$/, qty: 1, product: 2 },
  { direction: "out", re: /^(\d+) (.+) sold$/, qty: 1, product: 2 },
  { direction: "out", re: /^sold (\d+) (.+)$/, qty: 1, product: 2 },
  { direction: "out", re: /^(\d+) ta (.+) bikri$/, qty: 1, product: 2 },
  { direction: "out", re: /^(\d+) (.+) bikri$/, qty: 1, product: 2 },
  { direction: "out", re: /^(\d+)(?:\s*(?:টা|টি|খানা))?\s+বিক্রি$/, qty: 1, product: -1 },
  { direction: "out", re: /^(\d+)(?:\s*(?:টা|টি|খানা))?\s+(.+)\s+বিক্রি$/, qty: 1, product: 2 },
  { direction: "out", re: /^বিক্রি\s+(\d+)\s+(.+)$/, qty: 1, product: 2 },
  // STOCK-IN
  { direction: "in", re: /^added (\d+)$/, qty: 1, product: -1 },
  { direction: "in", re: /^added (\d+) (.+)$/, qty: 1, product: 2 },
  { direction: "in", re: /^add (\d+) (.+)$/, qty: 1, product: 2 },
  { direction: "in", re: /^(\d+) added$/, qty: 1, product: -1 },
  { direction: "in", re: /^(\d+) (.+) added$/, qty: 1, product: 2 },
  { direction: "in", re: /^(\d+) ta (.+) add$/, qty: 1, product: 2 },
  { direction: "in", re: /^(\d+) (.+) add$/, qty: 1, product: 2 },
  { direction: "in", re: /^(\d+)(?:\s*(?:টা|টি|খানা))?\s+যোগ$/, qty: 1, product: -1 },
  { direction: "in", re: /^(\d+)(?:\s*(?:টা|টি|খানা))?\s+(.+)\s+যোগ$/, qty: 1, product: 2 },
  { direction: "in", re: /^যোগ\s+(\d+)\s+(.+)$/, qty: 1, product: 2 },
];

export function parseAdjustmentCommand(text: string): ParseResult {
  const rawCommand = text.trim();
  const normalized = normalizeCommandText(text);
  for (const pattern of PATTERNS) {
    const m = pattern.re.exec(normalized);
    if (!m) continue;
    const quantity = Number(m[pattern.qty]);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return { ok: false, code: "invalid_quantity" };
    }
    const productText =
      pattern.product === -1 ? null : stripUnitWord(m[pattern.product]);
    if (productText !== null && productText.length === 0) {
      return { ok: false, code: "unrecognized" };
    }
    return { ok: true, command: { direction: pattern.direction, quantity, productText, rawCommand } };
  }
  return { ok: false, code: "unrecognized" };
}

/**
 * Authority gate — runs BEFORE parsing and resolution. Only a staff
 * sender passes. Customers and anonymous senders are refused without
 * the command ever touching a product or a stock number.
 */
export function authorizeSender(
  sender: Sender,
): { allowed: true; staff: Extract<Sender, { kind: "staff" }> } | { allowed: false; code: "customer_forbidden" } {
  if (sender.kind === "staff" && sender.userId && sender.businessId) {
    return { allowed: true, staff: sender };
  }
  return { allowed: false, code: "customer_forbidden" };
}

/**
 * Exact-match-or-refuse resolution. Id match wins first (dashboard
 * context passes an id); otherwise exactly one normalized-name match
 * applies. Zero matches -> not_found; several -> ambiguous. The
 * caller (staff surface) may show the match count; it must never be
 * shown to a customer — but customers never reach this function,
 * because `authorizeSender` runs first.
 */
export function resolveProduct(
  products: StockProduct[],
  productText: string,
): { ok: true; product: StockProduct } | { ok: false; code: "product_not_found" | "product_ambiguous"; matches: number } {
  const byId = products.find((p) => p.id === productText);
  if (byId) return { ok: true, product: byId };
  const wanted = normalizeProductName(productText);
  const matches = products.filter((p) => normalizeProductName(p.name) === wanted);
  if (matches.length === 1) return { ok: true, product: matches[0] };
  if (matches.length > 1) return { ok: false, code: "product_ambiguous", matches: matches.length };
  return { ok: false, code: "product_not_found", matches: 0 };
}

export interface PlanAdjustmentInput {
  sender: Sender;
  commandText: string;
  /** Tenant's own products (store already scoped to the business). */
  products: StockProduct[];
  /** Dashboard-selected product for context-only commands. */
  contextProduct?: StockProduct | null;
  /** Explicit reason; defaults to the verbatim command (rule 7). */
  reason?: string;
}

/**
 * Full decision pipeline: authority -> parse -> resolve -> validate.
 * Returns a plan (no write yet) or a refusal. Refusals write NOTHING:
 * no stock change and no ledger entry.
 */
export function planAdjustment(input: PlanAdjustmentInput): PlanResult {
  const auth = authorizeSender(input.sender);
  if (!auth.allowed) {
    return { allowed: false, code: "customer_forbidden", detail: "Only tenant/staff may adjust stock." };
  }
  const parsed = parseAdjustmentCommand(input.commandText);
  if (!parsed.ok) {
    return {
      allowed: false,
      code: parsed.code,
      detail:
        parsed.code === "invalid_quantity"
          ? "Quantity must be a positive integer."
          : "Command did not match the adjustment grammar.",
    };
  }
  const { direction, quantity, productText } = parsed.command;
  let product: StockProduct | null = null;
  if (productText === null) {
    if (!input.contextProduct) {
      return { allowed: false, code: "needs_product", detail: "Command names no product and no product is selected." };
    }
    // Tenant isolation at plan level: a context product must belong to
    // this tenant's own product list. A caller passing another business's
    // product (e.g. a confused dashboard context) is refused, never applied.
    if (!input.products.some((p) => p.id === input.contextProduct!.id)) {
      return { allowed: false, code: "product_not_found", detail: "Selected product does not belong to this business." };
    }
    product = input.contextProduct;
  } else {
    const resolved = resolveProduct(input.products, productText);
    if (!resolved.ok) {
      return {
        allowed: false,
        code: resolved.code,
        detail:
          resolved.code === "product_ambiguous"
            ? `Product name matches ${resolved.matches} products; refusing rather than guessing.`
            : "No product with that exact name in this business.",
      };
    }
    product = resolved.product;
  }
  if (!Number.isSafeInteger(product.stock) || product.stock < 0) {
    return { allowed: false, code: "unrecognized", detail: "Stored stock is not a valid count; refusing rather than computing from it." };
  }
  const previousStock = product.stock;
  const newStock = direction === "out" ? previousStock - quantity : previousStock + quantity;
  if (newStock < 0) {
    // REFUSE, never clamp (rule 4).
    return {
      allowed: false,
      code: "insufficient_stock",
      detail: `Sale of ${quantity} exceeds current stock ${previousStock}; nothing changed.`,
    };
  }
  return {
    allowed: true,
    plan: { direction, quantity, product, previousStock, newStock, rawCommand: parsed.command.rawCommand },
  };
}

/** Build the permanent ledger entry for an approved plan. Frozen. */
export function buildLedgerEntry(
  plan: AdjustmentPlan,
  meta: { id: string; businessId: string; updatedBy: string; reason?: string; nowIso: string },
): StockLedgerEntry {
  const entry: StockLedgerEntry = {
    id: meta.id,
    businessId: meta.businessId,
    productId: plan.product.id,
    productName: plan.product.name,
    movementType: "Adjustment",
    direction: plan.direction,
    quantity: plan.quantity,
    previousStock: plan.previousStock,
    newStock: plan.newStock,
    reference: meta.id,
    updatedBy: meta.updatedBy,
    reason: meta.reason !== undefined && meta.reason.trim() !== "" ? meta.reason.trim() : plan.rawCommand,
    rawCommand: plan.rawCommand,
    createdAt: meta.nowIso,
  };
  return Object.freeze(entry);
}

/** Adjustment id for the staged route (Leg A may replace the scheme;
 *  the contract is only that `reference === id` and ids are unique
 *  per business). */
export function newAdjustmentId(nowMs: number, randomPart: string): string {
  return `adj_${nowMs}_${randomPart}`;
}
