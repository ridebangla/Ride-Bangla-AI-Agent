/**
 * LEG E (inventory batch, STAGED ONLY) — stock/ledger read seam.
 *
 * This file is the CONTRACT between Leg E (alerts) and Leg A
 * (model/ledger). It deliberately contains NO Leg A internals:
 * Leg A's report did not exist when this leg was built
 * (~/workspace/final-verification/agent-inventory/leg-a-model-ledger/
 * LEG-REPORT.md — NOT FOUND at build time), so nothing here claims
 * Leg A's collection names, field names, or movement vocabulary as fact.
 *
 * WHAT LEG A MUST PROVIDE (apply-time implementer: replace the stub
 * below, keep the return shapes exactly):
 * - loadStockRows(businessId): one row per catalog product/variant the
 *   tenant tracks. `quantity: null` means the product/variant has NO
 *   stock record (untracked) — do NOT omit untracked products, and do
 *   NOT report them as 0: omission hides them, 0 would falsely alarm
 *   as out-of-stock. The caller (the route) supplies the catalog list;
 *   this loader joins stock onto it and returns null-quantity rows
 *   for products with no stock record.
 * - loadSaleMovements(businessId, windowDays, nowIso): ledger
 *   movements of kind "sale_out" inside the window. Other movement
 *   kinds may be returned too (the alerts module ignores non-sale_out
 *   kinds), but sale_out movements MUST carry positive units and a
 *   parseable ISO timestamp, or the rate falls back to
 *   "not_enough_sales_data" honestly.
 * - loadTenantDefaultThreshold(businessId): the tenant's low-stock
 *   threshold, or null when the tenant has set none. Until the owner
 *   decides D1 (LEG-REPORT.md §6), null is the correct value — the
 *   alerts module then classifies threshold-less tracked items as
 *   `unknown` with reason "no_threshold" instead of inventing a number.
 *
 * CURRENT STATE: stub. Every loader throws StockStoreNotConfigured
 * until Leg A implements it. The route maps that to HTTP 503 with an
 * honest message — it never synthesises stock, thresholds, or sales.
 */
import type { LedgerMovement, StockRow } from "./alerts";

export class StockStoreNotConfigured extends Error {
  constructor() {
    super("inventory_stock_store_not_configured");
    this.name = "StockStoreNotConfigured";
  }
}

export interface CatalogRef {
  productId: string;
  productName: string;
}

export interface StockStore {
  /**
   * Join stock onto the tenant's catalog list. MUST return one row per
   * catalog entry: quantity null for entries with no stock record.
   */
  loadStockRows(
    businessId: string,
    catalog: CatalogRef[],
  ): Promise<StockRow[]>;
  loadSaleMovements(
    businessId: string,
    windowDays: number,
    nowIso: string,
  ): Promise<LedgerMovement[]>;
  loadTenantDefaultThreshold(businessId: string): Promise<number | null>;
}

/**
 * STUB — throws on every call until Leg A lands its store.
 * The route MUST NOT catch this anywhere except to return 503.
 */
export const stockStore: StockStore = {
  async loadStockRows(): Promise<StockRow[]> {
    throw new StockStoreNotConfigured();
  },
  async loadSaleMovements(): Promise<LedgerMovement[]> {
    throw new StockStoreNotConfigured();
  },
  async loadTenantDefaultThreshold(): Promise<number | null> {
    throw new StockStoreNotConfigured();
  },
};
