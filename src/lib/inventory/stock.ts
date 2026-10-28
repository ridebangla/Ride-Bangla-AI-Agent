/**
 * stock.ts — LEG A (inventory batch, STAGED ONLY).
 *
 * Stock per product, tenant-scoped, with a variant-key extension point.
 *
 * WHAT HEAD ACTUALLY HAS (verified 2026-10-25 against live HEAD
 * 706df0fdf26f58fffc3630626497124768327c53):
 * - Product (src/lib/models.ts): id, businessId, categoryId, name,
 *   description, price (number|null), currency, imageUrl, tags,
 *   isAvailable, metadata (JsonValue). NO stock field, NO cost field,
 *   NO sku field, NO variant model, NO variant field anywhere.
 * - Persistence is Firestore via the src/lib/firestore.ts delegate
 *   (collections "products", "orders", ...). There is NO Prisma schema
 *   file in the repo; the src/lib/prisma.ts module is a compatibility
 *   shim re-exporting the Firestore client.
 * - Tenancy: runWithBusiness() + withBusinessId() fail closed
 *   (TenantContextError with no context); the tenant proxy auto-scopes
 *   reads and guards updates/deletes by re-proving ownership.
 *
 * DESIGN CHOICE, STATED PLAINLY: because no variant model exists, stock
 * is held at PRODUCT level, with `variantKey` as the extension point.
 * variantKey "" means "the product itself". When a real variant model
 * lands later, one stock document per (productId, variantKey) already
 * exists — no new table and no migration of the ledger is needed. This
 * module does NOT invent a variant table the repo cannot hold.
 *
 * PURE MODULE: zero runtime imports, no database, no prices-as-fares,
 * no meter/quota. It decides arithmetic only. Persistence (the paired
 * stock + ledger write) is specified in INTEGRATION-SNIPPETS.md and
 * must happen in ONE native Firestore transaction — the delegate's
 * $transaction is a sequential fallback, NOT atomic (see firestore.ts).
 *
 * DOCTRINE FIT:
 * - Stock moves ONLY via confirm / cancel / return / adjustment paths
 *   (the writers named in INTEGRATION-SNIPPETS.md). Free chat edits
 *   never touch stock: there is no chat tool here and no exported
 *   setter that changes a quantity without a movement.
 * - Confirmed = locked (Leg B, order-lock.ts) is respected by the
 *   writers, not re-decided here: this module never reads order status.
 * - No new meter/quota: low-stock threshold is a per-product alert
 *   setting, not a plan limit. Nothing here counts messages or usage.
 * - No invented copy: this module carries no user-facing wording at
 *   all. Every message below is a machine reason code.
 */

/** The five movement types. No other type may appear in the ledger. */
export type StockMovementType =
  | "sales_out"
  | "purchase_in"
  | "return_in"
  | "transfer"
  | "adjustment";

/** Direction of a movement against on-hand stock. */
export type StockDirection = "in" | "out";

/**
 * One stock document per (businessId, productId, variantKey).
 * Persisted as Firestore collection "stockLevels" (see LA-04 diff).
 * quantityOnHand is an integer >= 0. Negative stock is refused
 * everywhere (see applyMovement) — oversell is a team decision,
 * never a silent negative.
 */
export interface StockLevel {
  businessId: string;
  productId: string;
  /** "" = the product itself; otherwise an opaque variant key. */
  variantKey: string;
  quantityOnHand: number;
  /** Null = no threshold set = never low. Set by the team, not by sales. */
  lowStockThreshold: number | null;
  /** Id of the most recent ledger entry applied, or null before any. */
  lastMovementId: string | null;
}

/** Input to applyMovement. All quantities are whole units. */
export interface StockMovementInput {
  businessId: string;
  productId: string;
  /** Defaults to "" (the product itself) when omitted. */
  variantKey?: string;
  type: StockMovementType;
  /**
   * Required for "transfer" and "adjustment" (their direction is not
   * fixed). Forbidden for the other three types — their direction is
   * fixed by the table below, and a conflicting value is refused
   * rather than silently ignored.
   */
  direction?: StockDirection;
  /** Whole units moved. Must be a positive integer. */
  quantity: number;
}

/** Fixed directions. Transfer and adjustment have none — see above. */
export const FIXED_DIRECTIONS: Partial<Record<StockMovementType, StockDirection>> = {
  sales_out: "out",
  purchase_in: "in",
  return_in: "in",
};

export class StockError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StockError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new StockError(code, message);
}

/**
 * Normalise a variant key: trimmed; "" stays "" (the product itself).
 * Anything longer than 120 characters is refused — keys are lookup
 * keys, not free text.
 */
export function normalizeVariantKey(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") fail("invalid_variant_key", "variantKey must be a string");
  const key = (raw as string).trim();
  if (key.length > 120) fail("invalid_variant_key", "variantKey exceeds 120 characters");
  return key;
}

function requireBusinessId(value: unknown, code = "missing_business_id"): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, "businessId must be a non-empty string");
  }
  return value as string;
}

function requireProductId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("missing_product_id", "productId must be a non-empty string");
  }
  return value as string;
}

/** Resolve the direction for a movement, refusing contradictions. */
export function directionFor(
  type: StockMovementType,
  direction: StockDirection | undefined,
): StockDirection {
  const fixed = FIXED_DIRECTIONS[type];
  if (fixed !== undefined) {
    if (direction !== undefined && direction !== fixed) {
      fail(
        "direction_conflict",
        `type ${type} is always ${fixed}; a different direction was supplied`,
      );
    }
    return fixed;
  }
  // transfer + adjustment: direction is mandatory, never guessed.
  if (direction !== "in" && direction !== "out") {
    fail("missing_direction", `type ${type} requires an explicit direction ("in" or "out")`);
  }
  return direction;
}

/** A fresh stock document: zero on hand, no threshold, no movements yet. */
export function newStockLevel(
  businessId: string,
  productId: string,
  variantKey = "",
): StockLevel {
  return {
    businessId: requireBusinessId(businessId),
    productId: requireProductId(productId),
    variantKey: normalizeVariantKey(variantKey),
    quantityOnHand: 0,
    lowStockThreshold: null,
    lastMovementId: null,
  };
}

/** Result of applyMovement: the new level + the arithmetic it used. */
export interface AppliedMovement {
  level: StockLevel;
  previousStock: number;
  newStock: number;
  direction: StockDirection;
}

/**
 * Apply ONE movement to a stock level, purely.
 *
 * Rules (all fail-closed, all throw StockError, nothing is written):
 * - Tenant isolation: input.businessId must equal the level's
 *   businessId, and productId/variantKey must match the level.
 *   A movement for another tenant or another product is refused,
 *   never applied to the wrong row.
 * - A level of null means "no stock document exists yet". Only an
 *   "in" movement may create one (stock starts at 0, then rises).
 *   An "out" movement against no document is refused with
 *   "no_stock_record" — selling what was never stocked is not
 *   silently created as a negative.
 * - quantity must be a positive integer. Fractional units are refused
 *   (the catalog counts whole units; a fractional unit would corrupt
 *   every later chain check).
 * - The result may never go negative. A sale/transfer-out/adjustment-
 *   out larger than on-hand stock is refused with "insufficient_stock"
 *   — the caller (sell guard / team) decides, this module never
 *   invents a backorder.
 * - The returned level carries NO movement id: the writer sets
 *   lastMovementId to the ledger entry's id after the paired write
 *   (see INTEGRATION-SNIPPETS.md). The arithmetic here is identical
 *   either way.
 *
 * This function returns a NEW level object; the input is never mutated.
 */
export function applyMovement(
  current: StockLevel | null,
  input: StockMovementInput,
): AppliedMovement {
  const businessId = requireBusinessId(input.businessId);
  const productId = requireProductId(input.productId);
  const variantKey = normalizeVariantKey(input.variantKey);
  const direction = directionFor(input.type, input.direction);

  if (
    typeof input.quantity !== "number" ||
    !Number.isInteger(input.quantity) ||
    input.quantity <= 0
  ) {
    fail("invalid_quantity", "quantity must be a positive integer");
  }

  if (current === null) {
    if (direction === "out") {
      fail("no_stock_record", "cannot move stock out before any stock exists for this product");
    }
    const level = newStockLevel(businessId, productId, variantKey);
    level.quantityOnHand = input.quantity;
    return { level, previousStock: 0, newStock: input.quantity, direction };
  }

  if (current.businessId !== businessId) {
    fail("tenant_mismatch", "movement businessId does not match the stock document's tenant");
  }
  if (current.productId !== productId || current.variantKey !== variantKey) {
    fail("stock_mismatch", "movement product/variant does not match the stock document");
  }

  const previousStock = current.quantityOnHand;
  const newStock = direction === "in" ? previousStock + input.quantity : previousStock - input.quantity;
  if (newStock < 0) {
    fail("insufficient_stock", "movement would take stock below zero");
  }
  return {
    level: { ...current, quantityOnHand: newStock },
    previousStock,
    newStock,
    direction,
  };
}

/**
 * Low-stock test. A null threshold means "no threshold set" and is
 * never low. Otherwise low means on-hand <= threshold (at-threshold
 * counts as low: the team set that number as the line to act on).
 * This is an alert predicate only — it never blocks a sale and
 * never counts against any plan.
 */
export function isLowStock(level: StockLevel): boolean {
  if (level.lowStockThreshold === null) return false;
  return level.quantityOnHand <= level.lowStockThreshold;
}

/**
 * Set (or clear, with null) the low-stock threshold.
 * This is NOT a movement: it changes no quantity and therefore
 * creates NO ledger entry. Threshold changes are settings, and the
 * ledger records movements only — conflating the two would make
 * the ledger lie about what physically moved.
 */
export function setLowStockThreshold(
  current: StockLevel,
  threshold: number | null,
): StockLevel {
  if (threshold !== null) {
    if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0) {
      fail("invalid_threshold", "lowStockThreshold must be a non-negative integer or null");
    }
  }
  return { ...current, lowStockThreshold: threshold };
}
