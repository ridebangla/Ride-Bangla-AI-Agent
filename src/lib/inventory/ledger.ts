/**
 * ledger.ts — LEG A (inventory batch, STAGED ONLY).
 *
 * The stock ledger: EVERY stock movement is recorded, append-only.
 *
 * APPEND-ONLY, BY CONSTRUCTION: this module exports NO update and NO
 * delete for ledger entries. There is no function here that can edit
 * or remove an entry once built. A wrong entry is corrected ONLY by a
 * new reversing entry (see buildReversalEntry) — the original stays
 * in the chain forever, so the history never rewrites itself.
 * Persistence must honour the same rule: the writer (see
 * INTEGRATION-SNIPPETS.md) creates ledger documents and never updates
 * or deletes them, and the Firestore rules diff (LA-05) denies
 * update/delete on "stockMovements" for direct clients. Note honestly:
 * the app server uses the Admin SDK, which bypasses Firestore rules,
 * so the real enforcement server-side is "no mutating writer exists"
 * — a future writer that updates a ledger entry would break this
 * guarantee and must fail review.
 *
 * PURE MODULE: zero runtime imports. The StockLevel shape below is a
 * structural mirror of stock.ts's StockLevel (same fields, same
 * meaning) so this file stays import-free and harness-runnable on its
 * own; at apply time the two files live in the same directory and the
 * head may wire a single shared type if preferred. No behaviour
 * differs between the mirror and the original.
 *
 * VALUE IMPACT, STATED HONESTLY: HEAD records NO cost anywhere.
 * Product.price is the CATALOG SELLING price (number|null), and
 * metadata carries no cost field (verified in models.ts + the
 * firestore.ts product defaults). So:
 * - basis "catalog_price": amount = quantity x catalog selling price.
 *   This is SELLING value moved, NOT cost and NOT profit. Any surface
 *   that renders it must say so; calling it cost would be false.
 * - basis "supplied_unit_cost": only when the writer supplies a unit
 *   cost at entry time (e.g. a purchase invoice the team typed in).
 *   The module never defaults, estimates, or invents a unit cost.
 * - basis "unknown": amount null, currency null — when neither source
 *   exists (e.g. an unpriced catalog product, or a purchase with no
 *   cost entered). Null is the honest value; 0 would claim the goods
 *   were free.
 * No fare, delivery charge, or order total is read or written here.
 */

/** Movement types — identical vocabulary to stock.ts. */
export type LedgerMovementType =
  | "sales_out"
  | "purchase_in"
  | "return_in"
  | "transfer"
  | "adjustment";

export type LedgerDirection = "in" | "out";

/** What the movement refers to. Null only when the writer has none. */
export type LedgerReferenceType = "order" | "return" | "adjustment" | "transfer";

/** Structural mirror of stock.ts StockLevel (see header). */
export interface StockLevelLike {
  businessId: string;
  productId: string;
  variantKey: string;
  quantityOnHand: number;
  lowStockThreshold: number | null;
  lastMovementId: string | null;
}

/**
 * Value impact of one movement. amount is null exactly when the basis
 * is "unknown" — never 0 as a placeholder.
 */
export interface ValueImpact {
  amount: number | null;
  currency: string | null;
  basis: "catalog_price" | "supplied_unit_cost" | "unknown";
}

/**
 * One ledger entry. Persisted as Firestore collection "stockMovements"
 * (see LA-04 diff). `id` is assigned by the store on create (the
 * Firestore delegate generates a UUID when none is supplied) — the
 * builder below returns the entry WITHOUT an id; the writer attaches
 * the store-assigned id to the stock document's lastMovementId.
 * createdAt is an ISO string supplied by the writer (one clock, the
 * server's, for the whole paired write).
 */
export interface StockLedgerEntry {
  id: string | null;
  businessId: string;
  productId: string;
  variantKey: string;
  type: LedgerMovementType;
  direction: LedgerDirection;
  quantity: number;
  previousStock: number;
  newStock: number;
  valueImpact: ValueImpact;
  referenceType: LedgerReferenceType | null;
  /** Order id, return id, adjustment id, or transfer group — never a fare. */
  referenceId: string | null;
  /** Who moved the stock: dashboard user id, or a system actor id
   *  supplied by the writer (e.g. "system:order-confirm"). Never
   *  invented by this module: an empty updatedBy is refused. */
  updatedBy: string;
  /** Why. Required for adjustments and reversals; see buildLedgerEntry. */
  reason: string | null;
  /** Set ONLY on a reversing entry: the id of the entry it reverses. */
  reversesMovementId: string | null;
  /** Set on transfer pairs so the out-leg and in-leg link together. */
  transferGroupId: string | null;
  createdAt: string;
}

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new LedgerError(code, message);
}

export interface LedgerEntryInput {
  businessId: string;
  productId: string;
  variantKey?: string;
  type: LedgerMovementType;
  direction: LedgerDirection;
  quantity: number;
  /** Arithmetic source of truth: must equal previous +/- quantity. */
  previousStock: number;
  newStock: number;
  /** Catalog selling price (number|null) when known, else null. */
  catalogPrice?: number | null;
  catalogCurrency?: string | null;
  /** Unit cost supplied by the writer at entry time, else null. */
  suppliedUnitCost?: number | null;
  suppliedCurrency?: string | null;
  referenceType?: LedgerReferenceType | null;
  referenceId?: string | null;
  updatedBy: string;
  reason?: string | null;
  reversesMovementId?: string | null;
  transferGroupId?: string | null;
  createdAt: string;
}

/**
 * Compute value impact. Priority: a writer-supplied unit cost wins
 * (it is the most specific record for a purchase); otherwise the
 * catalog selling price; otherwise unknown/null. A supplied cost
 * without a currency, or a catalog price without a currency, still
 * yields an amount with currency null — the amount is recorded, the
 * missing currency is not guessed.
 */
export function computeValueImpact(input: {
  quantity: number;
  catalogPrice?: number | null;
  catalogCurrency?: string | null;
  suppliedUnitCost?: number | null;
  suppliedCurrency?: string | null;
}): ValueImpact {
  const qty = input.quantity;
  if (input.suppliedUnitCost !== null && input.suppliedUnitCost !== undefined) {
    if (typeof input.suppliedUnitCost !== "number" || !Number.isFinite(input.suppliedUnitCost) || input.suppliedUnitCost < 0) {
      fail("invalid_unit_cost", "suppliedUnitCost must be a finite number >= 0");
    }
    return {
      amount: qty * input.suppliedUnitCost,
      currency: input.suppliedCurrency ?? null,
      basis: "supplied_unit_cost",
    };
  }
  if (input.catalogPrice !== null && input.catalogPrice !== undefined) {
    if (typeof input.catalogPrice !== "number" || !Number.isFinite(input.catalogPrice) || input.catalogPrice < 0) {
      fail("invalid_catalog_price", "catalogPrice must be a finite number >= 0");
    }
    return {
      amount: qty * input.catalogPrice,
      currency: input.catalogCurrency ?? null,
      basis: "catalog_price",
    };
  }
  return { amount: null, currency: null, basis: "unknown" };
}

/**
 * Build ONE ledger entry for a movement whose arithmetic has already
 * been decided (by stock.ts applyMovement in the real writer).
 *
 * Refusals (fail-closed, nothing is built):
 * - Empty businessId / productId / updatedBy — attribution is
 *   mandatory. An entry that does not say WHO moved stock is refused.
 * - quantity not a positive integer; previous/new not non-negative
 *   integers; new != previous +/- quantity for the direction given
 *   (the chain check at build time, so a writer bug can never mint
 *   an entry whose arithmetic does not close).
 * - Adjustments and reversals REQUIRE a non-empty reason. A manual
 *   adjustment with no reason is refused: "someone changed the count
 *   and nobody said why" must never enter the permanent record.
 * - referenceId without referenceType (and vice versa) is refused:
 *   a dangling reference is worse than none.
 * - transfer entries REQUIRE a transferGroupId: a transfer leg that
 *   cannot be paired with its other leg is an incomplete record.
 * - createdAt must be a parseable ISO date string.
 */
export function buildLedgerEntry(input: LedgerEntryInput): Omit<StockLedgerEntry, "id"> & { id: null } {
  if (typeof input.businessId !== "string" || input.businessId.trim() === "") {
    fail("missing_business_id", "businessId must be a non-empty string");
  }
  if (typeof input.productId !== "string" || input.productId.trim() === "") {
    fail("missing_product_id", "productId must be a non-empty string");
  }
  if (typeof input.updatedBy !== "string" || input.updatedBy.trim() === "") {
    fail("missing_updated_by", "updatedBy must be a non-empty string");
  }
  const variantKey =
    input.variantKey === undefined || input.variantKey === null ? "" : String(input.variantKey).trim();
  if (variantKey.length > 120) fail("invalid_variant_key", "variantKey exceeds 120 characters");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    fail("invalid_quantity", "quantity must be a positive integer");
  }
  if (!Number.isInteger(input.previousStock) || input.previousStock < 0) {
    fail("invalid_previous_stock", "previousStock must be a non-negative integer");
  }
  if (!Number.isInteger(input.newStock) || input.newStock < 0) {
    fail("invalid_new_stock", "newStock must be a non-negative integer");
  }
  const expected =
    input.direction === "in" ? input.previousStock + input.quantity : input.previousStock - input.quantity;
  if (expected !== input.newStock) {
    fail(
      "arithmetic_mismatch",
      `newStock ${input.newStock} does not equal previousStock ${input.previousStock} ${input.direction === "in" ? "+" : "-"} quantity ${input.quantity}`,
    );
  }
  const reason = input.reason === undefined ? null : input.reason;
  if (input.type === "adjustment" && (reason === null || reason.trim() === "")) {
    fail("missing_reason", "adjustments require a non-empty reason");
  }
  if (input.reversesMovementId !== undefined && input.reversesMovementId !== null) {
    if (reason === null || reason.trim() === "") {
      fail("missing_reason", "reversing entries require a non-empty reason");
    }
  }
  if ((input.referenceId ?? null) !== null && (input.referenceType ?? null) === null) {
    fail("dangling_reference", "referenceId supplied without referenceType");
  }
  if ((input.referenceType ?? null) !== null && (input.referenceId ?? null) === null) {
    fail("dangling_reference", "referenceType supplied without referenceId");
  }
  if (input.type === "transfer" && (input.transferGroupId ?? null) === null) {
    fail("missing_transfer_group", "transfer entries require a transferGroupId pairing both legs");
  }
  const created = Date.parse(input.createdAt);
  if (Number.isNaN(created)) fail("invalid_created_at", "createdAt must be a parseable ISO date string");

  return {
    id: null,
    businessId: input.businessId,
    productId: input.productId,
    variantKey,
    type: input.type,
    direction: input.direction,
    quantity: input.quantity,
    previousStock: input.previousStock,
    newStock: input.newStock,
    valueImpact: computeValueImpact(input),
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    updatedBy: input.updatedBy,
    reason,
    reversesMovementId: input.reversesMovementId ?? null,
    transferGroupId: input.transferGroupId ?? null,
    createdAt: input.createdAt,
  };
}

/**
 * Validate a ledger chain for ONE (businessId, productId, variantKey)
 * series, given in chronological order (createdAt ascending; ties
 * broken by insertion order as stored).
 * - Every entry's previousStock must equal the previous entry's
 *   newStock; the first entry's previousStock must be 0 (stock
 *   starts at zero — there is no before-the-first-entry stock).
 * - Every entry's own arithmetic must close (same check as the
 *   builder, re-verified on read so a corrupt store is caught).
 * - All entries must share one businessId/productId/variantKey.
 * Returns true when the chain is intact; throws LedgerError otherwise.
 * This is the audit function: run it over a product's history and a
 * gap, edit, or deletion shows up as a break instead of silently
 * passing.
 */
export function validateLedgerChain(entries: StockLedgerEntry[]): boolean {
  if (entries.length === 0) return true;
  const { businessId, productId, variantKey } = entries[0];
  let expectedPrevious = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.businessId !== businessId || e.productId !== productId || e.variantKey !== variantKey) {
      fail("chain_tenant_mismatch", `entry ${i} belongs to a different tenant/product/variant than the chain`);
    }
    if (e.previousStock !== expectedPrevious) {
      fail(
        "chain_break",
        `entry ${i} previousStock ${e.previousStock} does not follow previous newStock ${expectedPrevious} — the chain is broken (gap, edit, or deletion)`,
      );
    }
    const expectedNew = e.direction === "in" ? e.previousStock + e.quantity : e.previousStock - e.quantity;
    if (expectedNew !== e.newStock) {
      fail("chain_arithmetic", `entry ${i} arithmetic does not close`);
    }
    expectedPrevious = e.newStock;
  }
  return true;
}

/**
 * Build the reversing entry for an original entry. The original is
 * NEVER edited: this returns a NEW adjustment entry with the opposite
 * direction, the same quantity, reversesMovementId pointing at the
 * original, and a mandatory reason. The caller still runs the result
 * through applyMovement against current stock (a reversal can itself
 * be refused — e.g. reversing a purchase_in after the goods were
 * sold would take stock negative — and that refusal is correct).
 * The original entry must already have a store-assigned id; a
 * reversal of an unpersisted entry is refused.
 */
export function buildReversalEntry(
  original: StockLedgerEntry,
  input: { updatedBy: string; reason: string; createdAt: string; previousStock: number; newStock: number },
): Omit<StockLedgerEntry, "id"> & { id: null } {
  if (original.id === null || original.id === "") {
    fail("unpersisted_original", "only a persisted entry (with an id) can be reversed");
  }
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    fail("missing_reason", "reversals require a non-empty reason");
  }
  return buildLedgerEntry({
    businessId: original.businessId,
    productId: original.productId,
    variantKey: original.variantKey,
    type: "adjustment",
    direction: original.direction === "in" ? "out" : "in",
    quantity: original.quantity,
    previousStock: input.previousStock,
    newStock: input.newStock,
    // A reversal carries no fresh value claim: its value impact is
    // unknown unless the writer supplies one explicitly. The original
    // entry keeps its own value record; nothing is rewritten.
    catalogPrice: null,
    suppliedUnitCost: null,
    referenceType: "adjustment",
    referenceId: original.id,
    updatedBy: input.updatedBy,
    reason: input.reason,
    reversesMovementId: original.id,
    createdAt: input.createdAt,
  });
}
