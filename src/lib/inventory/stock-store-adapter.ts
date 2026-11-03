/**
 * STOCK-STORE ADAPTER — Team J (2026-11-03).
 *
 * Implements the movements module's `StockStore` contract
 * (src/lib/inventory/stock-movements.ts) on the repo's EXISTING
 * persistence: the Firestore-backed prisma shim (src/lib/firestore.ts
 * MODEL_META: collections `stockLevels` + `stockMovements`, order
 * docs carrying the `stockMovements` marker field). No new collection,
 * no new field vocabulary beyond what Leg A already defined — except
 * previousStock/newStock on ledger rows, which Leg A itself requires
 * ("entry requires previous/new arithmetic") and which the shim
 * stores as ordinary fields.
 *
 * ATOMICITY — READ THIS BEFORE CLAIMING ANYTHING: runTransaction
 * here is SEQUENTIAL, not a Firestore multi-document transaction.
 * This is the movements module's documented Option B fallback: the
 * status write in setOrderStatus and the stock writes below are
 * separate commits, so a crash between them can leave status moved
 * with stock unmoved (confirm: retryable by re-affirming
 * confirmed -> confirmed, which the marker makes idempotent; cancel:
 * NOT retryable through a status transition — staff correct it with
 * a manual adjustment once that route is wired). TRUE atomicity
 * (Option A: one Admin SDK runTransaction covering status + stock)
 * is a separate, larger restructure and is NOT claimed here.
 * Concurrency: two confirms racing the same stock are NOT serialised
 * by this adapter — the guard inside one run still refuses a
 * negative result for the levels it read, but interleaved runs can
 * oversell. That race is real and is NOT closed here.
 *
 * MAPPINGS (all from in-tree vocabulary, nothing invented):
 *  - Stock key "productId" / "productId:variantId" <-> Leg A
 *    (productId, variantKey "" / variantId). Order items in this
 *    tree carry no variant (OrderItem has no variant field), so
 *    confirm/cancel lines always map to variantKey "".
 *  - Movement kind -> Leg A ledger type: confirm -> "sales_out"
 *    (direction "out"), cancel -> "adjustment" (direction "in",
 *    reversing the confirm; reversesMovementId carries the confirm
 *    ledger id when one exists for the key), return -> "return_in",
 *    adjustment -> "adjustment" (direction by delta sign).
 *  - damaged / missing tallies are NOT persisted: Leg A levels have
 *    no such fields (documented Leg A gap (a)). Confirm/cancel
 *    movements only touch onHand, so nothing is lost on THOSE paths;
 *    an adjustment carrying damaged/missing deltas through this
 *    adapter would silently drop them — callers must not route such
 *    adjustments here (see the adjustments-route BLOCKED note in the
 *    Team J report).
 *  - Ledger rows carry previousStock/newStock computed from the
 *    levels this transaction read/wrote (setStock precedes
 *    writeMovement per line in every executor, so both are known).
 *    Rows are created with the movements module's deterministic id
 *    `${orderId}:${kind}:${key}` (the shim honours data.id), so a
 *    retried transaction cannot duplicate a row under the same id.
 *
 * TENANCY: every read/write goes through the UNSCOPED client with
 * an explicit businessId (the same pattern setOrderStatus itself
 * uses for its pre-update read), and getOrder refuses an order whose
 * businessId differs from the expected one. The executors re-check
 * tenant on every level.
 */

import { getUnscopedPrisma } from "../prisma";
import {
  STOCK_MOVEMENTS_FIELD,
  stockKeyFor,
  type OrderStockRecord,
  type StockLevel,
  type StockMovement,
  type StockMovementMarker,
  type StockStore,
  type StockTx,
} from "./stock-movements";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function splitKey(key: string): { productId: string; variantId: string | null } {
  const idx = key.indexOf(":");
  if (idx === -1) return { productId: key, variantId: null };
  return { productId: key.slice(0, idx), variantId: key.slice(idx + 1) || null };
}

/** Exported for unit tests: the kind -> Leg A ledger-type mapping. */
export function ledgerTypeFor(kind: StockMovement["kind"]): string {
  switch (kind) {
    case "confirm":
      return "sales_out";
    case "cancel":
      return "adjustment";
    case "return":
      return "return_in";
    case "adjustment":
      return "adjustment";
  }
}

/** Exported for unit tests: the movement -> Leg A direction mapping. */
export function directionFor(m: StockMovement): "in" | "out" {
  if (m.kind === "confirm") return "out";
  if (m.kind === "return") return "in";
  // cancel (restock) and adjustment: sign of the on-hand delta.
  return m.deltaOnHand < 0 ? "out" : "in";
}

/** Build a movements-StockStore bound to one order. */
export function prismaStockStore(
  orderId: string,
  expectedBusinessId: string
): StockStore {
  const db = getUnscopedPrisma();
  return {
    async runTransaction<T>(fn: (tx: StockTx) => T | Promise<T>): Promise<T> {
      // Option B: sequential delegate calls, NOT one Firestore tx.
      const prevLevels = new Map<string, StockLevel>();
      const currentLevels = new Map<string, StockLevel>();
      const tx: StockTx = {
        async getOrder(): Promise<OrderStockRecord | null> {
          const row = (await db.order.findUnique({
            where: { id: orderId },
          })) as Record<string, unknown> | null;
          if (!row) return null;
          const businessId =
            typeof row.businessId === "string" ? row.businessId : "";
          if (businessId !== expectedBusinessId) {
            // Cross-tenant order id: the executors' own tenant assert
            // would also refuse, but refuse here before any level is
            // read, so no foreign stock is ever touched.
            throw new Error(
              `stock adapter: order "${orderId}" belongs to another business.`
            );
          }
          const rawItems = Array.isArray(row.items) ? row.items : [];
          const items = rawItems.map((it) => {
            const r = asRecord(it) ?? {};
            return {
              productId:
                typeof r.productId === "string" ? r.productId : undefined,
              variantId: null,
              name: typeof r.name === "string" ? r.name : "",
              qty:
                typeof r.qty === "number" && Number.isInteger(r.qty)
                  ? r.qty
                  : 0,
            };
          });
          return {
            id: orderId,
            businessId,
            status: typeof row.status === "string" ? row.status : "",
            items: items as OrderStockRecord["items"],
            stockMovements: row[STOCK_MOVEMENTS_FIELD],
          };
        },
        async getStock(key: string): Promise<StockLevel | undefined> {
          const { productId, variantId } = splitKey(key);
          const variantKey = variantId ?? "";
          // Key round-trip guard: a productId containing ":" can never
          // have produced this key (stockKeyFor forbids it).
          if (stockKeyFor(productId, variantId) !== key) return undefined;
          const row = (await db.stockLevel.findFirst({
            where: { businessId: expectedBusinessId, productId, variantKey },
          })) as Record<string, unknown> | null;
          if (!row) return undefined;
          const onHand =
            typeof row.quantityOnHand === "number" ? row.quantityOnHand : NaN;
          if (!Number.isInteger(onHand) || onHand < 0) {
            // Malformed level: surface it as a level the executor's
            // shape assert will refuse (never silently coerce to 0).
            return {
              businessId: expectedBusinessId,
              productId,
              variantId,
              onHand: -1,
              damaged: 0,
              missing: 0,
            };
          }
          const level: StockLevel = {
            businessId: expectedBusinessId,
            productId,
            variantId,
            onHand,
            damaged: 0,
            missing: 0,
          };
          prevLevels.set(key, level);
          return level;
        },
        async setStock(level: StockLevel): Promise<void> {
          const variantKey = level.variantId ?? "";
          currentLevels.set(stockKeyFor(level.productId, level.variantId), level);
          await db.stockLevel.upsert({
            where: {
              businessId: expectedBusinessId,
              productId: level.productId,
              variantKey,
            },
            update: { quantityOnHand: level.onHand },
            create: {
              businessId: expectedBusinessId,
              productId: level.productId,
              variantKey,
              quantityOnHand: level.onHand,
              lowStockThreshold: null,
              lastMovementId: null,
            },
          });
        },
        async setOrderMarker(marker: StockMovementMarker): Promise<void> {
          await db.order.update({
            where: { id: orderId },
            data: { [STOCK_MOVEMENTS_FIELD]: marker },
          });
        },
        async writeMovement(m: StockMovement): Promise<void> {
          const prev = prevLevels.get(m.key);
          const current = currentLevels.get(m.key);
          const previousStock =
            prev !== undefined
              ? prev.onHand
              : current !== undefined
                ? current.onHand - m.deltaOnHand
                : null;
          const newStock =
            current !== undefined
              ? current.onHand
              : previousStock !== null
                ? previousStock + m.deltaOnHand
                : null;
          const type = ledgerTypeFor(m.kind);
          const direction = directionFor(m);
          const quantity = Math.abs(m.deltaOnHand);
          await db.stockMovement.create({
            data: {
              id: m.ledgerId,
              businessId: m.businessId,
              productId: m.productId,
              variantKey: m.variantId ?? "",
              type,
              direction,
              quantity,
              previousStock,
              newStock,
              referenceType: m.orderId ? "order" : null,
              referenceId: m.orderId || null,
              reason: m.reason ?? null,
              reversesMovementId:
                m.kind === "cancel"
                  ? `${m.orderId}:confirm:${m.key}`
                  : null,
              transferGroupId: null,
              actor: m.actor ?? null,
              at: m.at,
            },
          });
          // Keep Leg A's lastMovementId true for the level this
          // movement touched (best-effort inside the same sequential
          // flow; a failure here propagates to the caller like any
          // other write failure).
          if (current !== undefined) {
            await db.stockLevel.update({
              where: {
                businessId: expectedBusinessId,
                productId: m.productId,
                variantKey: m.variantId ?? "",
              },
              data: { lastMovementId: m.ledgerId },
            });
          }
        },
        async ledgerExists(ledgerId: string): Promise<boolean> {
          const row = await db.stockMovement.findUnique({
            where: { id: ledgerId },
          });
          return row !== null;
        },
      };
      return fn(tx);
    },
  };
}
