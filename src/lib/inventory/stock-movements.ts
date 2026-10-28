/**
 * stock-movements.ts — LEG C (inventory batch, STAGED ONLY).
 *
 * Confirm-decrement, cancel/return-increment, and combo/bundle
 * expansion. This module is PURE plus a store interface: zero runtime
 * imports, no database, no network, no order write of its own, no
 * price / total / currency / fare anywhere, no metering, no quota.
 * It never invents stock, never quotes a fare, and never writes
 * customer-facing copy (all outcomes are machine data; wording is a
 * PROPOSAL for the owner, in the integration doc, never in this file).
 *
 * DOCTRINE (binding on this module):
 * - The agent NEVER confirms an order by itself. PENDING orders do NOT
 *   decrement. ONLY a human confirmation decrements, and only through
 *   the confirm transition (pending -> confirmed) in setOrderStatus.
 * - Stock moves ONLY via confirm / cancel / return / adjustment paths.
 *   There is no free-chat stock edit anywhere in this module, and no
 *   function here is callable from any agent tool (the merger must not
 *   wire one — see the integration doc).
 * - Confirmed = locked. A locked order's stock movement is recorded
 *   once, under the order's processed marker (see STOCK_MOVEMENTS_FIELD).
 *   Re-running a transition on an already-processed order moves nothing.
 * - Per-surface identity: this module carries no business name, no
 *   brand wording, and no "Ride Bangla" string.
 *
 * SEAM — Leg A (stock / ledger model), READ BEFORE WIRING:
 * Leg A LANDED while this leg was being staged (its report and
 * `src/lib/inventory/stock.ts` + `ledger.ts` are now in
 * `final-verification/agent-inventory/leg-a-model-ledger/`). HEAD
 * itself still carries NO stock field (Product has no quantity/stock
 * field — see the leg report §2). Leg A's canonical model is:
 * collections `stockLevels` (one doc per businessId + productId +
 * variantKey, variantKey "" = the product itself) and `stockMovements`
 * (append-only ledger; entry requires previous/new arithmetic, a
 * reference, an actor, and — for adjustments/reversals — a reason).
 * This module deliberately does NOT import Leg A's files (zero
 * runtime imports keeps it harness-runnable and keeps the two legs'
 * diffs disjoint), so it defines its OWN minimal store contract,
 * `StockStore` / `StockTx` / `StockLevel`. The apply-time merger MUST
 * supply a `StockStore` whose reads come from Leg A's real ledger and
 * MUST confirm, field by field, that the adapter supplies:
 *   (1) the requesting tenant's businessId on every stock level,
 *   (2) the product identity and Leg A's variantKey (mapped to this
 *       module's variantId: null <=> variantKey "" — see the
 *       integration doc for the ":" constraint on variant keys),
 *   (3) an explicit "no record" signal for products/variants with no
 *       stock record at all (the adapter returns `undefined` from
 *       `getStock` for those — it must never synthesise a level).
 *   (4) Leg A's actor + reason on every ledger row: the executors
 *       accept `actor` / `reason` and carry them on each movement;
 *       adjustment and cancel-restock REFUSE a missing reason
 *       (`missing_reason`), matching Leg A's rule. The merger must
 *       supply the real dashboard actor (LB-03's verified actor) and
 *       the real team reason — never a defaulted one.
 * TWO Leg A gaps this module does NOT paper over (merger decisions,
 * see the leg report §7): (a) Leg A's StockLevel has NO damaged /
 * missing tally fields, so the adapter cannot persist this leg's
 * damaged/missing tallies without a small Leg A model extension;
 * (b) Leg A's ledger ids are store-assigned while this module's are
 * deterministic — the merger picks ONE id scheme (deterministic ids
 * are recommended for idempotent replay) and maps movement kinds to
 * Leg A types (confirm -> sales_out, cancel -> reversing adjustment,
 * return -> return_in, adjustment -> adjustment). See
 * INTEGRATION-SNIPPET.md §3 for the full mapping table.
 *
 * MISSING-STOCK POLICY (explicit, not silent — owner decision D1):
 * A line WITH a productId but NO stock record is `unknown_stock_record`.
 * The default (`missingStock: "fail"`) refuses the WHOLE movement: the
 * transaction throws and nothing moves. This matches sibling Leg B's
 * fail-closed unknown-stock rule (never promise / never move on stock
 * nobody entered). The opt-out (`missingStock: "skip"`) exists ONLY as
 * a migration bridge for tenants whose products predate stock entry:
 * untracked lines are reported in `skipped` and move nothing, while
 * tracked lines still move under the all-or-nothing guard. The merger
 * must record which option it wires; "skip" must never become the
 * quiet permanent default.
 * Lines WITHOUT a productId (free-text / service items, which HEAD's
 * OrderItem allows) are always skipped as `no_product_id`: there is no
 * stock identity to move, and inventing one would be fabrication.
 *
 * ATOMICITY — what this module guarantees, and what it does not:
 * Every executor runs its reads, its guard checks, and ALL of its
 * writes inside ONE `store.runTransaction` call. Inside that call the
 * order is: read order -> check marker -> check transition -> expand
 * lines (combos) -> read every stock level -> run the guard (any
 * insufficiency aborts the WHOLE plan) -> write levels + ledger +
 * marker. If the guard throws, no write has been issued yet, so the
 * transaction commits nothing. That is atomic WITHIN one transaction
 * supplied by the adapter.
 * What this module CANNOT guarantee on its own: that the adapter's
 * `runTransaction` is a real multi-document transaction. The HEAD
 * prisma-style delegate exposes NO cross-document transaction: each
 * `prisma.<model>.update` is its own single-document Firestore
 * transaction (see leg report §3), so calling the status write and
 * then this module as two separate delegate calls is NOT atomic —
 * status could commit while stock fails (see the failure table in the
 * integration doc). TRUE atomicity requires the merger's Option A:
 * one Admin SDK `getAdminDb().runTransaction` (the same mechanism the
 * courier bridge already uses for its own docs) covering the order
 * status write + lock fields + stock levels + marker + ledger, with
 * the courier bridge running AFTER commit, exactly as HEAD does today.
 * Until Option A lands, no one may claim "confirm and decrement are
 * atomic" — the fallback (Option B) semantics are documented honestly
 * in the integration doc, including the marker-absent recovery path.
 *
 * CONCURRENCY — what this module guarantees, and what it does not:
 * Two confirms racing the same stock are safe ONLY if the adapter's
 * `runTransaction` retries on read/write contention the way Firestore
 * transactions do (re-read, re-plan, re-check the guard, then commit
 * or fail). The harness proves this shape with a contended store that
 * retries exactly that way: stock 5, two concurrent confirms of 4 ->
 * exactly one applies, the other fails `insufficient_stock`, final
 * stock is 1, never negative, never double-counted. If the merger's
 * adapter does NOT retry (e.g. it wraps sequential delegate calls),
 * the race window is real and this module does not close it — that is
 * an apply-time engineering decision (owner decision D2), flagged in
 * the report, not hidden.
 *
 * COMBOS / BUNDLES — HEAD has NO bundle model (NOT FOUND, leg report
 * §2). A combo here is ONLY a mapping the caller supplies:
 * combo product id -> component list with quantities. Selling a combo
 * decrements EACH component by (component qty x combo qty), aggregated
 * across duplicate lines. ALL-OR-NOTHING: if ANY tracked component is
 * insufficient (or unknown, under `missingStock: "fail"`), NOTHING
 * decrements — the guard runs before any write. Nested combos (a
 * component that is itself a combo) are refused with `nested_combo`,
 * fail closed; one level only.
 *
 * RETURNS — HEAD has NO return vocabulary beyond `cancelled`
 * (OrderStatus = "pending" | "confirmed" | "cancelled"; NOT FOUND, leg
 * report §2). A return is therefore NOT a status in this module: it
 * is an explicit function input (`applyReturnMovement`) carrying the
 * per-item condition and the tenant's handling setting. The return
 * does NOT change the order status — the merger / owner decides the
 * status vocabulary separately (owner decision D4). Return quantity
 * is capped at what the order actually decremented: cumulative
 * returns per stock key may never exceed the order's expanded
 * confirmed quantity, or the executor throws `return_exceeds_ordered`.
 * Partial returns are supported across calls; each return call needs
 * a caller-supplied `idempotencyKey` (e.g. the return form's submit
 * id) so a double-submit moves nothing twice.
 *
 * CANCEL — cancelling a PENDING order (never decremented) restocks
 * NOTHING: there is nothing to give back. Only a confirmed-then-
 * cancelled order restocks, and only the quantity its confirm
 * movement actually decremented. Cancel assumes returned goods are
 * good (a cancel has no condition input); if the team knows items are
 * damaged or missing, they use the return path instead — see D5.
 *
 * LEDGER — every applied movement writes one ledger entry per stock
 * key with a deterministic id, `${orderId}:${kind}:${key}` (returns:
 * `${orderId}:return:${key}:${idempotencyKey}`, because partial
 * returns accumulate; adjustments: `adjust:${key}:${idempotencyKey}`).
 * Deterministic ids mean a
 * retried transaction or a replayed call cannot duplicate ledger rows
 * under the same id; the adapter must treat a ledger write with an
 * existing id inside the same movement as the same row, not a second
 * row. Ledger rows are audit data: they record what moved, never a
 * price, total, or fare.
 */

/** Order status words as they exist at HEAD (no return status). */
export type OrderStatusWord = "pending" | "confirmed" | "cancelled";

/** One ordered line, as carried on HEAD's Order.items (JsonValue). */
export interface OrderLineInput {
  /** Catalog product id; null/absent = free-text / service item. */
  productId?: string | null;
  /** Variant id when the customer picked a variant; null otherwise. */
  variantId?: string | null;
  /** Display name; used only for skip reporting, never for matching. */
  name: string;
  /** Ordered quantity. Must be a positive integer. */
  qty: number;
}

/** A stock row for ONE product/variant, as supplied by the adapter.
 *  Adapter mapping to Leg A's StockLevel (see header seam note):
 *  onHand <=> quantityOnHand; variantId null <=> variantKey "";
 *  damaged / missing have NO Leg A field yet (merger decision D-C4);
 *  the adapter must preserve Leg A's lowStockThreshold and
 *  lastMovementId across setStock (merge, never overwrite with a
 *  bare quantity write). */
export interface StockLevel {
  businessId: string;
  productId: string;
  /** Null when the product has no variants / no variant was picked. */
  variantId: string | null;
  /** Sellable units on hand. Never negative (guard-enforced). */
  onHand: number;
  /** Units returned damaged — tracked separately, NEVER sellable. */
  damaged: number;
  /** Units reported missing — tracked separately, NEVER sellable. */
  missing: number;
}

/** One component of a combo: product (+variant) and qty per combo. */
export interface ComboComponent {
  productId: string;
  variantId?: string | null;
  /** Required units of this component per ONE combo sold. */
  qty: number;
}

/** A combo definition: combo product id -> its components. */
export interface ComboDefinition {
  comboProductId: string;
  components: ComboComponent[];
}

/** Caller-supplied combo catalogue. Absent key = not a combo. */
export type ComboMap = Record<string, ComboDefinition>;

/** An expanded, aggregated stock line (combos already flattened). */
export interface ExpandedLine {
  key: string;
  productId: string;
  variantId: string | null;
  qty: number;
}

/** A line that moved nothing, and the honest reason why. */
export interface SkippedLine {
  line: OrderLineInput;
  reason: "no_product_id" | "untracked_stock";
}

/** One ledger movement row (audit data; no money anywhere).
 *  `actor` / `reason` are carried through from the human call context
 *  so the merger can build Leg A's ledger entries (which require both
 *  for adjustments/reversals) without inventing them. This module never
 *  defaults them: a missing actor/reason stays missing here, and the
 *  merger's ledger builder refuses the row (Leg A rule) instead of
 *  this module fabricating a human. */
export interface StockMovement {
  /** Deterministic ledger id (see header). */
  ledgerId: string;
  orderId: string;
  businessId: string;
  kind: "confirm" | "cancel" | "return" | "adjustment";
  key: string;
  productId: string;
  variantId: string | null;
  deltaOnHand: number;
  deltaDamaged: number;
  deltaMissing: number;
  /** ISO timestamp supplied by the caller (executor default: now). */
  at: string;
  /** Human actor id, when the caller supplied one (LB-03 actor). */
  actor?: string;
  /** Team reason, when the caller supplied one (REQUIRED for
   *  cancel-restock and adjustment — see the executors). */
  reason?: string;
}

/** A return audit entry that deliberately moved NO stock. */
export interface RecordedOnlyReturn {
  key: string;
  productId: string;
  variantId: string | null;
  qty: number;
  condition: ReturnCondition;
  reason: "leave_unchanged";
}

/** Per-item return input (explicit — HEAD has no return table). */
export interface ReturnItemInput {
  productId: string;
  variantId?: string | null;
  qty: number;
  condition: ReturnCondition;
}

export type ReturnCondition = "good" | "damaged" | "missing";

/**
 * Tenant return-handling setting (PROPOSED field — HEAD has no such
 * business setting; the merger reads the tenant's setting when one
 * exists and falls back to DEFAULT_RETURN_HANDLING, see the
 * integration doc). Default = Automatic for good items only.
 */
export type ReturnHandling = "automatic" | "add_to_stock" | "leave_unchanged";
export const DEFAULT_RETURN_HANDLING: ReturnHandling = "automatic";

/** What a missing stock record does (see header policy). */
export type MissingStockPolicy = "fail" | "skip";

/** Field on the order doc carrying the processed markers. HEAD's Order
 *  interface has an index signature, so extra fields persist the same
 *  way `courierBooking` already does — but the merger must still prove
 *  persistence through the real delegate on the live drive (the same
 *  caveat Leg B records for `lockAudit`/`lockedAt`). */
export const STOCK_MOVEMENTS_FIELD = "stockMovements";

/** Processed markers: one entry per transition that already moved
 *  stock. Presence = already processed; absence = not yet processed.
 *  `returns` is a list (partial returns accumulate); `confirm` and
 *  `cancel` are singletons (each transition happens at most once). */
export interface StockMovementMarker {
  confirm?: { at: string };
  cancel?: { at: string; restocked: boolean };
  returns?: Array<{
    at: string;
    handling: ReturnHandling;
    idempotencyKey: string;
    items: Array<{ key: string; qty: number; condition: ReturnCondition }>;
  }>;
}

/** The order record as the adapter presents it inside a transaction. */
export interface OrderStockRecord {
  id: string;
  businessId: string;
  status: string;
  items: OrderLineInput[];
  stockMovements?: unknown;
}

/** Transaction handle supplied by the adapter (Firestore semantics:
 *  reads are version-tracked; the adapter retries the whole callback
 *  on contention — see header concurrency note). */
export interface StockTx {
  getOrder(): OrderStockRecord | null | Promise<OrderStockRecord | null>;
  getStock(key: string): StockLevel | undefined | Promise<StockLevel | undefined>;
  setStock(level: StockLevel): void | Promise<void>;
  setOrderMarker(marker: StockMovementMarker): void | Promise<void>;
  writeMovement(movement: StockMovement): void | Promise<void>;
  ledgerExists(ledgerId: string): boolean | Promise<boolean>;
}

/** Store contract the merger's adapter must implement. */
export interface StockStore {
  runTransaction<T>(fn: (tx: StockTx) => T | Promise<T>): Promise<T>;
}

/** Machine error codes. Server logs may carry them; customers never
 *  see them raw (wording is the merger's / owner's PROPOSAL). */
export type StockMovementErrorCode =
  | "invalid_line"
  | "invalid_combo"
  | "nested_combo"
  | "invalid_id"
  | "invalid_transition"
  | "status_mismatch"
  | "order_not_found"
  | "cross_tenant"
  | "insufficient_stock"
  | "unknown_stock_record"
  | "negative_stock"
  | "return_exceeds_ordered"
  | "invalid_marker"
  | "invalid_return"
  | "invalid_adjustment"
  | "missing_reason";

export class StockMovementError extends Error {
  code: StockMovementErrorCode;
  constructor(code: StockMovementErrorCode, message: string) {
    super(message);
    this.name = "StockMovementError";
    this.code = code;
  }
}

/** Stock key: product id, or product:variant when a variant is set. */
export function stockKeyFor(productId: string, variantId: string | null): string {
  if (typeof productId !== "string" || !productId) {
    throw new StockMovementError("invalid_id", "productId must be a non-empty string.");
  }
  if (productId.includes(":")) {
    throw new StockMovementError(
      "invalid_id",
      "productId must not contain ':' (it separates product from variant in a stock key).",
    );
  }
  if (variantId !== null && variantId !== undefined) {
    if (typeof variantId !== "string" || !variantId || variantId.includes(":")) {
      throw new StockMovementError("invalid_id", "variantId must be a non-empty string without ':'.");
    }
    return `${productId}:${variantId}`;
  }
  return productId;
}

function isPositiveInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Parse the order's processed marker. Absent = {}. Malformed = throw
 *  (fail closed — a marker nobody can read must never be treated as
 *  "not processed", or a retry could double-move). */
export function readMarker(order: OrderStockRecord): StockMovementMarker {
  const raw = order.stockMovements;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new StockMovementError("invalid_marker", "stockMovements marker is malformed.");
  }
  const m = raw as Record<string, unknown>;
  const out: StockMovementMarker = {};
  if (m.confirm !== undefined) {
    const c = m.confirm as Record<string, unknown>;
    if (!c || typeof c.at !== "string") {
      throw new StockMovementError("invalid_marker", "confirm marker is malformed.");
    }
    out.confirm = { at: c.at };
  }
  if (m.cancel !== undefined) {
    const c = m.cancel as Record<string, unknown>;
    if (!c || typeof c.at !== "string" || typeof c.restocked !== "boolean") {
      throw new StockMovementError("invalid_marker", "cancel marker is malformed.");
    }
    out.cancel = { at: c.at, restocked: c.restocked };
  }
  if (m.returns !== undefined) {
    if (!Array.isArray(m.returns)) {
      throw new StockMovementError("invalid_marker", "returns marker is malformed.");
    }
    out.returns = (m.returns as Array<Record<string, unknown>>).map((r) => ({
      at: String(r.at ?? ""),
      handling: r.handling as ReturnHandling,
      idempotencyKey: String(r.idempotencyKey ?? ""),
      items: Array.isArray(r.items)
        ? (r.items as Array<Record<string, unknown>>).map((it) => ({
            key: String(it.key ?? ""),
            qty: Number(it.qty ?? 0),
            condition: it.condition as ReturnCondition,
          }))
        : [],
    }));
  }
  return out;
}

/**
 * Expand order lines into aggregated stock lines. Combos flatten to
 * their components (x combo qty); duplicate keys sum. Free-text lines
 * (no productId) are skipped, never invented. Throws on the first
 * invalid line / combo so a bad plan moves nothing.
 */
export function expandOrderLines(
  lines: OrderLineInput[],
  combos: ComboMap = {},
): { expanded: ExpandedLine[]; skipped: SkippedLine[] } {
  const byKey = new Map<string, ExpandedLine>();
  const skipped: SkippedLine[] = [];
  const add = (productId: string, variantId: string | null, qty: number): void => {
    const key = stockKeyFor(productId, variantId);
    const prev = byKey.get(key);
    if (prev) prev.qty += qty;
    else byKey.set(key, { key, productId, variantId, qty });
  };
  for (const line of lines) {
    if (!line || typeof line !== "object") {
      throw new StockMovementError("invalid_line", "order line must be an object.");
    }
    if (!isPositiveInteger(line.qty)) {
      throw new StockMovementError(
        "invalid_line",
        `order line "${String(line.name ?? "")}" has no positive integer qty.`,
      );
    }
    const productId =
      typeof line.productId === "string" && line.productId ? line.productId : null;
    if (!productId) {
      skipped.push({ line, reason: "no_product_id" });
      continue;
    }
    const variantId =
      typeof line.variantId === "string" && line.variantId ? line.variantId : null;
    const combo = combos[productId];
    if (!combo) {
      add(productId, variantId, line.qty);
      continue;
    }
    if (!Array.isArray(combo.components) || combo.components.length === 0) {
      throw new StockMovementError("invalid_combo", `combo "${productId}" has no components.`);
    }
    for (const comp of combo.components) {
      if (!comp || !isPositiveInteger(comp.qty) || !comp.productId) {
        throw new StockMovementError("invalid_combo", `combo "${productId}" has an invalid component.`);
      }
      if (combos[comp.productId]) {
        throw new StockMovementError(
          "nested_combo",
          `combo "${productId}" contains combo "${comp.productId}" — nested combos are refused.`,
        );
      }
      const compVariant =
        typeof comp.variantId === "string" && comp.variantId ? comp.variantId : null;
      add(comp.productId, compVariant, comp.qty * line.qty);
    }
  }
  return { expanded: [...byKey.values()], skipped };
}

/** Expand return items (combos flatten like order lines). */
export function expandReturnItems(
  items: ReturnItemInput[],
  combos: ComboMap = {},
): Array<{ key: string; productId: string; variantId: string | null; qty: number; condition: ReturnCondition }> {
  const out: Array<{ key: string; productId: string; variantId: string | null; qty: number; condition: ReturnCondition }> = [];
  for (const item of items) {
    if (!item || !isPositiveInteger(item.qty) || !item.productId) {
      throw new StockMovementError("invalid_return", "return item needs a productId and a positive integer qty.");
    }
    if (item.condition !== "good" && item.condition !== "damaged" && item.condition !== "missing") {
      throw new StockMovementError("invalid_return", "return item condition must be good, damaged, or missing.");
    }
    const variantId =
      typeof item.variantId === "string" && item.variantId ? item.variantId : null;
    const combo = combos[item.productId];
    if (!combo) {
      out.push({ key: stockKeyFor(item.productId, variantId), productId: item.productId, variantId, qty: item.qty, condition: item.condition });
      continue;
    }
    if (!Array.isArray(combo.components) || combo.components.length === 0) {
      throw new StockMovementError("invalid_combo", `combo "${item.productId}" has no components.`);
    }
    for (const comp of combo.components) {
      if (!comp || !isPositiveInteger(comp.qty) || !comp.productId) {
        throw new StockMovementError("invalid_combo", `combo "${item.productId}" has an invalid component.`);
      }
      if (combos[comp.productId]) {
        throw new StockMovementError("nested_combo", `combo "${item.productId}" contains combo "${comp.productId}".`);
      }
      const compVariant =
        typeof comp.variantId === "string" && comp.variantId ? comp.variantId : null;
      out.push({
        key: stockKeyFor(comp.productId, compVariant),
        productId: comp.productId,
        variantId: compVariant,
        qty: comp.qty * item.qty,
        condition: item.condition,
      });
    }
  }
  return out;
}

export interface MovementResult {
  /** True when this call actually moved stock / wrote a marker. */
  applied: boolean;
  /** True when the call was a no-op because it was already processed. */
  alreadyProcessed: boolean;
  /** Machine reason when applied === false (not a customer message). */
  reason?: string;
  movements: StockMovement[];
  skipped: SkippedLine[];
  recordedOnly: RecordedOnlyReturn[];
}

function noopResult(reason: string): MovementResult {
  return { applied: false, alreadyProcessed: false, reason, movements: [], skipped: [], recordedOnly: [] };
}

function alreadyResult(): MovementResult {
  return { applied: false, alreadyProcessed: true, reason: "already_processed", movements: [], skipped: [], recordedOnly: [] };
}

function movementFor(
  orderId: string,
  businessId: string,
  kind: StockMovement["kind"],
  key: string,
  productId: string,
  variantId: string | null,
  deltaOnHand: number,
  deltaDamaged: number,
  deltaMissing: number,
  at: string,
  actor?: string,
  reason?: string,
): StockMovement {
  return {
    ledgerId: `${orderId}:${kind}:${key}`,
    orderId,
    businessId,
    kind,
    key,
    productId,
    variantId,
    deltaOnHand,
    deltaDamaged,
    deltaMissing,
    at,
    ...(actor ? { actor } : {}),
    ...(reason ? { reason } : {}),
  };
}

function requireReason(reason: string | undefined, what: string): string {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new StockMovementError(
      "missing_reason",
      `${what} requires a team reason (Leg A rule: adjustments and reversals without a reason are refused, never defaulted).`,
    );
  }
  return reason;
}

function assertTenant(level: StockLevel, businessId: string): void {
  if (level.businessId !== businessId) {
    throw new StockMovementError(
      "cross_tenant",
      `stock level for "${level.productId}" belongs to another business.`,
    );
  }
}

function assertLevelShape(level: StockLevel): void {
  if (
    !isNonNegativeInteger(level.onHand) ||
    !isNonNegativeInteger(level.damaged) ||
    !isNonNegativeInteger(level.missing)
  ) {
    throw new StockMovementError("negative_stock", "stock level counts must be non-negative integers.");
  }
}

/**
 * Confirm movement — the ONLY path that decrements for a sale.
 * Call from setOrderStatus's pending -> confirmed transition (and
 * from a confirmed -> confirmed re-affirmation, which is idempotent).
 * Any other transition is refused: in particular, a pending order
 * that is NOT being confirmed moves nothing here.
 */
export async function applyConfirmMovement(
  store: StockStore,
  opts: {
    combos?: ComboMap;
    missingStock?: MissingStockPolicy;
    nowIso?: string;
    /** Human actor id (LB-03 verified actor) for the ledger row. */
    actor?: string;
    /** Team reason for the ledger row (optional for confirm). */
    reason?: string;
    /** The transition the caller is performing. Must be pending ->
     *  confirmed, or confirmed -> confirmed (re-affirm). */
    transition: { from: OrderStatusWord; to: OrderStatusWord };
  },
): Promise<MovementResult> {
  const combos = opts.combos ?? {};
  const missingStock = opts.missingStock ?? "fail";
  const at = opts.nowIso ?? new Date().toISOString();
  if (
    !(
      (opts.transition.from === "pending" && opts.transition.to === "confirmed") ||
      (opts.transition.from === "confirmed" && opts.transition.to === "confirmed")
    )
  ) {
    throw new StockMovementError(
      "invalid_transition",
      `confirm movement requires pending -> confirmed (or confirmed -> confirmed); got ${opts.transition.from} -> ${opts.transition.to}. Pending orders never decrement.`,
    );
  }
  return store.runTransaction(async (tx) => {
    const order = await tx.getOrder();
    if (!order) throw new StockMovementError("order_not_found", "order not found inside the stock transaction.");
    if (order.status !== opts.transition.from) {
      throw new StockMovementError(
        "status_mismatch",
        `order status is "${order.status}", expected "${opts.transition.from}" for this transition.`,
      );
    }
    const marker = readMarker(order);
    if (marker.confirm) return alreadyResult();
    const { expanded, skipped } = expandOrderLines(order.items ?? [], combos);
    // Guard FIRST (all-or-nothing): read every level, check every
    // line, and only then write anything.
    const levels = new Map<string, StockLevel>();
    const trackedSkipped: SkippedLine[] = [...skipped];
    for (const line of expanded) {
      const level = await tx.getStock(line.key);
      if (!level) {
        if (missingStock === "skip") {
          trackedSkipped.push({
            line: { productId: line.productId, variantId: line.variantId, name: line.productId, qty: line.qty },
            reason: "untracked_stock",
          });
          continue;
        }
        throw new StockMovementError(
          "unknown_stock_record",
          `no stock record for "${line.key}" — stock was never entered for this item.`,
        );
      }
      assertTenant(level, order.businessId);
      assertLevelShape(level);
      if (level.onHand < line.qty) {
        throw new StockMovementError(
          "insufficient_stock",
          `insufficient stock for "${line.key}": on hand ${level.onHand}, ordered ${line.qty}. Nothing decremented.`,
        );
      }
      levels.set(line.key, level);
    }
    const movements: StockMovement[] = [];
    for (const line of expanded) {
      const level = levels.get(line.key);
      if (!level) continue; // untracked + skipped policy: moves nothing.
      const next: StockLevel = { ...level, onHand: level.onHand - line.qty };
      await tx.setStock(next);
      const m = movementFor(order.id, order.businessId, "confirm", line.key, line.productId, line.variantId, -line.qty, 0, 0, at, opts.actor, opts.reason);
      await tx.writeMovement(m);
      movements.push(m);
    }
    await tx.setOrderMarker({ ...marker, confirm: { at } });
    // applied === true: this first-time confirm ran to completion and
    // wrote its marker, even if every line was skipped (untracked /
    // free-text) and no stock row changed. A re-run is alreadyProcessed.
    return { applied: true, alreadyProcessed: false, movements, skipped: trackedSkipped, recordedOnly: [] };
  });
}

/**
 * Cancel movement — restocks ONLY a confirmed-then-cancelled order,
 * and only what its confirm movement decremented. Cancelling a
 * pending order writes a `restocked: false` marker and moves nothing.
 * A confirmed order whose courier booking is already claimed is NOT
 * special-cased here: stock restock and courier claim are independent
 * concerns (see D5 — the owner may still rule otherwise).
 */
export async function applyCancelMovement(
  store: StockStore,
  opts: {
    combos?: ComboMap;
    missingStock?: MissingStockPolicy;
    nowIso?: string;
    /** Human actor id (LB-03 verified actor) for the ledger row. */
    actor?: string;
    /** Team reason — REQUIRED when the cancel restocks (Leg A rule:
     *  a reversal without a reason is refused, never defaulted). */
    reason?: string;
    transition: { from: OrderStatusWord; to: OrderStatusWord };
  },
): Promise<MovementResult> {
  const combos = opts.combos ?? {};
  const missingStock = opts.missingStock ?? "fail";
  const at = opts.nowIso ?? new Date().toISOString();
  if (
    !(
      (opts.transition.from === "confirmed" && opts.transition.to === "cancelled") ||
      (opts.transition.from === "pending" && opts.transition.to === "cancelled")
    )
  ) {
    throw new StockMovementError(
      "invalid_transition",
      `cancel movement requires confirmed -> cancelled or pending -> cancelled; got ${opts.transition.from} -> ${opts.transition.to}.`,
    );
  }
  return store.runTransaction(async (tx) => {
    const order = await tx.getOrder();
    if (!order) throw new StockMovementError("order_not_found", "order not found inside the stock transaction.");
    if (order.status !== opts.transition.from) {
      throw new StockMovementError(
        "status_mismatch",
        `order status is "${order.status}", expected "${opts.transition.from}" for this transition.`,
      );
    }
    const marker = readMarker(order);
    if (marker.cancel) return alreadyResult();
    if (opts.transition.from === "pending" || !marker.confirm) {
      // Never decremented (pending cancel, or a legacy order with no
      // confirm marker): there is nothing to give back. Record the
      // cancel so a later re-run stays a no-op, and move nothing.
      await tx.setOrderMarker({ ...marker, cancel: { at, restocked: false } });
      return { applied: false, alreadyProcessed: false, reason: "not_decremented", movements: [], skipped: [], recordedOnly: [] };
    }
    const restockReason = requireReason(opts.reason, "cancel restock");
    const { expanded, skipped } = expandOrderLines(order.items ?? [], combos);
    const levels = new Map<string, StockLevel>();
    const trackedSkipped: SkippedLine[] = [...skipped];
    for (const line of expanded) {
      const level = await tx.getStock(line.key);
      if (!level) {
        if (missingStock === "skip") {
          trackedSkipped.push({
            line: { productId: line.productId, variantId: line.variantId, name: line.productId, qty: line.qty },
            reason: "untracked_stock",
          });
          continue;
        }
        throw new StockMovementError(
          "unknown_stock_record",
          `no stock record for "${line.key}" — cannot restock into a record that does not exist.`,
        );
      }
      assertTenant(level, order.businessId);
      assertLevelShape(level);
      levels.set(line.key, level);
    }
    const movements: StockMovement[] = [];
    for (const line of expanded) {
      const level = levels.get(line.key);
      if (!level) continue;
      const next: StockLevel = { ...level, onHand: level.onHand + line.qty };
      await tx.setStock(next);
      const m = movementFor(order.id, order.businessId, "cancel", line.key, line.productId, line.variantId, line.qty, 0, 0, at, opts.actor, restockReason);
      await tx.writeMovement(m);
      movements.push(m);
    }
    await tx.setOrderMarker({ ...marker, cancel: { at, restocked: true } });
    return { applied: true, alreadyProcessed: false, movements, skipped: trackedSkipped, recordedOnly: [] };
  });
}

/**
 * Return movement — explicit input only (HEAD has no return status
 * or table). Does NOT change the order status. Requires a prior
 * confirm marker; otherwise it is a no-op (`not_decremented`).
 * Handling (tenant setting, default Automatic):
 * - automatic: good -> onHand; damaged -> damaged tally; missing ->
 *   missing tally. Damaged/missing NEVER return to sellable stock.
 * - add_to_stock: every condition -> onHand (tenant's explicit choice;
 *   the ledger row still records the original condition via the
 *   movement kind + the marker's item list).
 * - leave_unchanged: no stock delta at all; the return is recorded
 *   only (audit + marker), so nothing is silently restocked.
 * Cumulative returns per key are capped at the order's expanded
 * confirmed quantity. Each call needs an `idempotencyKey`; re-using
 * one returns `alreadyProcessed` and moves nothing.
 */
export async function applyReturnMovement(
  store: StockStore,
  opts: {
    items: ReturnItemInput[];
    handling?: ReturnHandling;
    combos?: ComboMap;
    idempotencyKey: string;
    nowIso?: string;
    /** Human actor id for the ledger row. */
    actor?: string;
    /** Team reason for the ledger row (optional for returns). */
    reason?: string;
  },
): Promise<MovementResult> {
  const handling = opts.handling ?? DEFAULT_RETURN_HANDLING;
  const combos = opts.combos ?? {};
  const at = opts.nowIso ?? new Date().toISOString();
  if (!opts.idempotencyKey) {
    throw new StockMovementError("invalid_return", "return movement requires an idempotencyKey.");
  }
  return store.runTransaction(async (tx) => {
    const order = await tx.getOrder();
    if (!order) throw new StockMovementError("order_not_found", "order not found inside the stock transaction.");
    const marker = readMarker(order);
    if (!marker.confirm) return noopResult("not_decremented");
    if ((marker.returns ?? []).some((r) => r.idempotencyKey === opts.idempotencyKey)) {
      return alreadyResult();
    }
    const expandedReturns = expandReturnItems(opts.items, combos);
    // Cap check against what the order actually decremented.
    const ordered = expandOrderLines(order.items ?? [], combos).expanded;
    const orderedByKey = new Map(ordered.map((l) => [l.key, l.qty]));
    const alreadyReturned = new Map<string, number>();
    for (const r of marker.returns ?? []) {
      for (const it of r.items) {
        alreadyReturned.set(it.key, (alreadyReturned.get(it.key) ?? 0) + it.qty);
      }
    }
    const newByKey = new Map<string, number>();
    for (const r of expandedReturns) {
      newByKey.set(r.key, (newByKey.get(r.key) ?? 0) + r.qty);
    }
    for (const [key, qty] of newByKey) {
      const allowed = orderedByKey.get(key) ?? 0;
      const returnedTotal = (alreadyReturned.get(key) ?? 0) + qty;
      if (returnedTotal > allowed) {
        throw new StockMovementError(
          "return_exceeds_ordered",
          `return of ${returnedTotal} for "${key}" exceeds the ordered quantity ${allowed}.`,
        );
      }
    }
    const movements: StockMovement[] = [];
    const recordedOnly: RecordedOnlyReturn[] = [];
    if (handling !== "leave_unchanged") {
      // Aggregate deltas per key (same key + different conditions in
      // one call must not overwrite each other).
      const deltaByKey = new Map<string, { productId: string; variantId: string | null; dOn: number; dDam: number; dMis: number }>();
      for (const r of expandedReturns) {
        const d = deltaByKey.get(r.key) ?? { productId: r.productId, variantId: r.variantId, dOn: 0, dDam: 0, dMis: 0 };
        if (handling === "add_to_stock") d.dOn += r.qty;
        else if (r.condition === "good") d.dOn += r.qty;
        else if (r.condition === "damaged") d.dDam += r.qty;
        else d.dMis += r.qty;
        deltaByKey.set(r.key, d);
      }
      for (const [key, d] of deltaByKey) {
        const level = await tx.getStock(key);
        if (!level) {
          throw new StockMovementError(
            "unknown_stock_record",
            `no stock record for "${key}" — cannot record a return against it.`,
          );
        }
        assertTenant(level, order.businessId);
        assertLevelShape(level);
        const next: StockLevel = {
          ...level,
          onHand: level.onHand + d.dOn,
          damaged: level.damaged + d.dDam,
          missing: level.missing + d.dMis,
        };
        await tx.setStock(next);
        const m = movementFor(order.id, order.businessId, "return", key, d.productId, d.variantId, d.dOn, d.dDam, d.dMis, at, opts.actor, opts.reason);
        // Returns are NOT singletons (partial returns accumulate), so
        // the ledger id carries the return's idempotency key — otherwise
        // a second return for the same key would overwrite the first
        // ledger row instead of adding its own.
        m.ledgerId = `${order.id}:return:${key}:${opts.idempotencyKey}`;
        await tx.writeMovement(m);
        movements.push(m);
      }
    } else {
      for (const r of expandedReturns) {
        recordedOnly.push({ key: r.key, productId: r.productId, variantId: r.variantId, qty: r.qty, condition: r.condition, reason: "leave_unchanged" });
      }
    }
    const newReturn = {
      at,
      handling,
      idempotencyKey: opts.idempotencyKey,
      items: expandedReturns.map((r) => ({ key: r.key, qty: r.qty, condition: r.condition })),
    };
    await tx.setOrderMarker({ ...marker, returns: [...(marker.returns ?? []), newReturn] });
    return { applied: true, alreadyProcessed: false, movements, skipped: [], recordedOnly };
  });
}

/**
 * Manual adjustment primitive (human dashboard path ONLY — the caller
 * enforces the human actor; this function enforces the arithmetic).
 * Leg D owns the adjustment surface; this primitive is the shared
 * transactional writer Leg D may reuse so two writers never diverge.
 * If Leg D lands its own writer, the merger keeps exactly ONE of them.
 * Adjustments create a missing stock level at zero first (entering
 * stock IS an adjustment); the result may never go negative.
 */
export async function applyAdjustment(
  store: StockStore,
  opts: {
    businessId: string;
    productId: string;
    variantId?: string | null;
    deltaOnHand?: number;
    deltaDamaged?: number;
    deltaMissing?: number;
    idempotencyKey: string;
    nowIso?: string;
    /** Human actor id for the ledger row. */
    actor?: string;
    /** Team reason — REQUIRED (Leg A rule: adjustments without a
     *  reason are refused, never defaulted). */
    reason?: string;
  },
): Promise<MovementResult> {
  const variantId = opts.variantId ?? null;
  const key = stockKeyFor(opts.productId, variantId);
  const dOn = opts.deltaOnHand ?? 0;
  const dDam = opts.deltaDamaged ?? 0;
  const dMis = opts.deltaMissing ?? 0;
  if (!Number.isInteger(dOn) || !Number.isInteger(dDam) || !Number.isInteger(dMis)) {
    throw new StockMovementError("invalid_adjustment", "adjustment deltas must be integers.");
  }
  if (!opts.idempotencyKey) {
    throw new StockMovementError("invalid_adjustment", "adjustment requires an idempotencyKey.");
  }
  const adjustmentReason = requireReason(opts.reason, "manual adjustment");
  const at = opts.nowIso ?? new Date().toISOString();
  const ledgerId = `adjust:${key}:${opts.idempotencyKey}`;
  return store.runTransaction(async (tx) => {
    if (await tx.ledgerExists(ledgerId)) return alreadyResult();
    const existing = await tx.getStock(key);
    const base: StockLevel = existing ?? {
      businessId: opts.businessId,
      productId: opts.productId,
      variantId,
      onHand: 0,
      damaged: 0,
      missing: 0,
    };
    assertTenant(base, opts.businessId);
    const next: StockLevel = {
      ...base,
      onHand: base.onHand + dOn,
      damaged: base.damaged + dDam,
      missing: base.missing + dMis,
    };
    if (next.onHand < 0 || next.damaged < 0 || next.missing < 0) {
      throw new StockMovementError("negative_stock", "adjustment would drive a stock count negative.");
    }
    await tx.setStock(next);
    const m: StockMovement = {
      ledgerId,
      orderId: "",
      businessId: opts.businessId,
      kind: "adjustment",
      key,
      productId: opts.productId,
      variantId,
      deltaOnHand: dOn,
      deltaDamaged: dDam,
      deltaMissing: dMis,
      at,
      ...(opts.actor ? { actor: opts.actor } : {}),
      reason: adjustmentReason,
    };
    await tx.writeMovement(m);
    return { applied: true, alreadyProcessed: false, movements: [m], skipped: [], recordedOnly: [] };
  });
}
