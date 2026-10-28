/**
 * LEG E (inventory batch, STAGED ONLY) — low-stock alerts, pure logic.
 *
 * Zero runtime imports. No database, no prices, no fares, no metering:
 * this module never reads money, never counts messages, and never gates
 * anything on a plan quota. Stock truth comes ONLY from the caller's
 * inputs (tenant data + ledger movements); nothing here invents stock
 * or a sales rate.
 *
 * SEAM (read before wiring): Leg A (model/ledger) owns the real stock
 * store. This module does NOT know Leg A's collection, field names, or
 * internals. The route adapts Leg A's store to the input shapes below
 * via `src/lib/inventory/store.ts` (currently a NOT_CONFIGURED stub).
 * Until Leg A lands, no caller can produce a real alert from live data
 * — and that is by design, not a gap to paper over.
 *
 * CLASSIFICATION (exact, final for this leg):
 * - out-of-stock : quantity === 0 exactly. ("Below zero" does not exist
 *   as a stock state: a negative quantity is INVALID data, not stock,
 *   and falls in `unknown` with reason "invalid_quantity".)
 * - low         : quantity > 0 AND quantity <= effective threshold.
 * - healthy     : quantity > effective threshold.
 * - unknown     : NO stock record at all (quantity === null), OR a
 *   record that cannot be classified honestly: negative/non-finite
 *   quantity, or no threshold (neither a per-item threshold nor a
 *   tenant default was supplied). Unknown is a SEPARATE bucket: it is
 *   never counted as healthy (that would hide risk) and never counted
 *   as out-of-stock (that would raise false alarms). The dashboard
 *   shows its count separately as "not tracked".
 *
 * Threshold resolution (caller's job, stated so the seam is explicit):
 * effectiveThreshold = item.threshold ?? tenantDefaultThreshold.
 * If the result is null/undefined/non-finite/negative, the item is
 * `unknown` with reason "no_threshold". This leg sets NO default
 * threshold in code: whether a tenant default exists, and its value,
 * is OWNER DECISION D1 (recommendation in LEG-REPORT.md §6: a
 * tenant-configurable default, proposed value 5, never silently
 * coded as a business rule).
 *
 * DAYS-TO-STOCKOUT HINT (recorded sales ONLY):
 * - Only ledger movements with kind === "sale_out" count. Every other
 *   kind (purchases in, adjustments, returns, anything else) is ignored
 *   for the rate — never counted as sales.
 * - Window: the caller passes windowDays explicitly (route default 30
 *   is a PROPOSAL — OWNER DECISION D2, recommendation: 30-day mean).
 *   Only movements inside [now - windowDays, now] count; future-dated
 *   and unparseable movements are ignored, never extrapolated.
 * - Rate = totalUnitsSoldInWindow / windowDays (simple mean over the
 *   whole window, including zero-sale days — so a burst does not
 *   inflate the rate; see D2 for the alternative the owner may pick).
 * - Computable ONLY when there are >= 2 recorded "sale_out" movements
 *   in the window AND totalUnitsSold > 0. Otherwise daysToStockout is
 *   null with reason "not_enough_sales_data" — never an invented rate,
 *   never a fallback average, never a category average.
 * - When computable: days = quantity / rate (a fractional number,
 *   rounded to 1 decimal for display; the raw value is kept). For an
 *   out-of-stock item the hint is 0 (already out), regardless of rate.
 * - For `unknown` items the hint is always null.
 *
 * TENANT ISOLATION: buildInventoryAlerts() throws TenantMismatch if
 * ANY stock row or ledger movement carries a businessId different
 * from the requested businessId. Fail closed: a mixed batch produces
 * no alert payload at all. (The route additionally relies on the
 * scoped prisma client, so this throw is defence in depth.)
 *
 * ATTENTION LIST ORDER (stable, deterministic):
 * 1. out-of-stock items first (quantity 0), by product name, then variant.
 * 2. then low-stock items, by quantity ascending (closest to zero
 *    first), then by name, then variant.
 * Unknown items are NEVER in the attention list; they are reported
 * separately (capped list, name order) so the tenant can fix tracking.
 */

export type StockStatus = "healthy" | "low" | "out_of_stock" | "unknown";

export interface StockRow {
  /** Tenant that owns this row. Must equal the requested businessId. */
  businessId: string;
  /** Catalog product id (tenant catalog). */
  productId: string;
  /** Human-readable catalog product name (from the tenant catalog). */
  productName: string;
  /** Variant label, e.g. size/colour. Null/empty = the product itself. */
  variantLabel?: string | null;
  /**
   * Recorded on-hand quantity. null = NO stock record exists for this
   * product/variant (not tracked) — the honest unknown case. A number
   * is a recorded quantity from the tenant's stock/ledger store.
   */
  quantity: number | null;
  /**
   * Per-item low-stock threshold. Null = no per-item threshold; the
   * tenant default (if any) applies instead.
   */
  threshold?: number | null;
}

export interface LedgerMovement {
  businessId: string;
  productId: string;
  variantLabel?: string | null;
  /** Only "sale_out" counts toward the stockout rate. All else ignored. */
  kind: string;
  /** Units moved. Non-positive sale_out movements are ignored. */
  units: number;
  /** ISO timestamp of the recorded movement. */
  at: string;
}

export interface AlertItem {
  productId: string;
  productName: string;
  variantLabel: string | null;
  /** Display label: name, or "name — variant" when a variant exists. */
  displayName: string;
  status: StockStatus;
  /** Recorded quantity; null when untracked/invalid. */
  quantity: number | null;
  /** Effective threshold used; null when none was available. */
  threshold: number | null;
  /** Days until stockout from recorded sales only; null when not computable. */
  daysToStockout: number | null;
  /** Machine reason for null/unknown states; null when fully classified. */
  reason: string | null;
}

export interface InventoryAlertSummary {
  businessId: string;
  counts: {
    healthy: number;
    low: number;
    outOfStock: number;
    /** Separate bucket — never folded into healthy or outOfStock. */
    unknown: number;
    /** Items with a classifiable stock record (healthy + low + out). */
    tracked: number;
    /** Every catalog product/variant considered. */
    total: number;
  };
  /** Out-of-stock first, then low-stock (see module header). */
  attention: AlertItem[];
  /** Untracked/unclassifiable items, name order, capped by the caller. */
  unknownItems: AlertItem[];
  /** Window (days) the stockout hints were computed over. */
  windowDays: number;
}

export class TenantMismatchError extends Error {
  constructor() {
    super("inventory_alerts_tenant_mismatch");
    this.name = "TenantMismatchError";
  }
}

function effectiveThreshold(
  row: StockRow,
  tenantDefaultThreshold: number | null | undefined,
): number | null {
  const t = row.threshold ?? tenantDefaultThreshold ?? null;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return null;
  return t;
}

function displayNameFor(row: StockRow): string {
  const v = (row.variantLabel ?? "").trim();
  return v ? `${row.productName} — ${v}` : row.productName;
}

function variantKey(row: StockRow): string {
  return (row.variantLabel ?? "").trim();
}

/**
 * Days-to-stockout from recorded sales only. Returns null (with a
 * machine reason) whenever the recorded data cannot support a rate.
 */
export function daysToStockoutFromSales(
  quantity: number,
  movements: LedgerMovement[],
  windowDays: number,
  nowIso: string,
): { days: number | null; reason: string | null } {
  if (quantity === 0) return { days: 0, reason: null };
  if (!(windowDays > 0) || !Number.isFinite(windowDays)) {
    return { days: null, reason: "invalid_window" };
  }
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) {
    return { days: null, reason: "invalid_now" };
  }
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;
  let saleCount = 0;
  let totalUnits = 0;
  for (const m of movements) {
    if (m.kind !== "sale_out") continue;
    if (typeof m.units !== "number" || !Number.isFinite(m.units) || m.units <= 0) continue;
    const t = Date.parse(m.at);
    if (!Number.isFinite(t) || t < windowStart || t > now) continue;
    saleCount += 1;
    totalUnits += m.units;
  }
  if (saleCount < 2 || totalUnits <= 0) {
    return { days: null, reason: "not_enough_sales_data" };
  }
  const rate = totalUnits / windowDays;
  if (!(rate > 0)) return { days: null, reason: "not_enough_sales_data" };
  const raw = quantity / rate;
  return { days: Math.round(raw * 10) / 10, reason: null };
}

function compareAttention(a: AlertItem, b: AlertItem): number {
  const rank = (s: StockStatus): number =>
    s === "out_of_stock" ? 0 : s === "low" ? 1 : 2;
  const r = rank(a.status) - rank(b.status);
  if (r !== 0) return r;
  if (a.status === "low" && b.status === "low") {
    const qa = a.quantity ?? 0;
    const qb = b.quantity ?? 0;
    if (qa !== qb) return qa - qb;
  }
  if (a.productName !== b.productName) {
    return a.productName < b.productName ? -1 : 1;
  }
  const va = a.variantLabel ?? "";
  const vb = b.variantLabel ?? "";
  return va < vb ? -1 : va > vb ? 1 : 0;
}

export interface BuildAlertsInput {
  businessId: string;
  rows: StockRow[];
  movements: LedgerMovement[];
  tenantDefaultThreshold?: number | null;
  windowDays: number;
  nowIso: string;
  /** Cap for the unknown-items list (attention list is uncapped). */
  unknownCap?: number;
}

export function buildInventoryAlerts(input: BuildAlertsInput): InventoryAlertSummary {
  const { businessId, rows, movements, windowDays, nowIso } = input;
  const unknownCap =
    typeof input.unknownCap === "number" && input.unknownCap >= 0
      ? Math.floor(input.unknownCap)
      : 50;
  for (const row of rows) {
    if (row.businessId !== businessId) throw new TenantMismatchError();
  }
  for (const m of movements) {
    if (m.businessId !== businessId) throw new TenantMismatchError();
  }

  const movementsByKey = new Map<string, LedgerMovement[]>();
  for (const m of movements) {
    const key = `${m.productId}|${variantKey({ businessId, productId: m.productId, productName: "", variantLabel: m.variantLabel, quantity: null })}`;
    const list = movementsByKey.get(key) ?? [];
    list.push(m);
    movementsByKey.set(key, list);
  }

  const counts = {
    healthy: 0,
    low: 0,
    outOfStock: 0,
    unknown: 0,
    tracked: 0,
    total: rows.length,
  };
  const attention: AlertItem[] = [];
  const unknownItems: AlertItem[] = [];

  for (const row of rows) {
    const threshold = effectiveThreshold(row, input.tenantDefaultThreshold);
    const displayName = displayNameFor(row);
    const variantLabel = variantKey(row) ? variantKey(row) : null;
    const key = `${row.productId}|${variantKey(row)}`;
    const ownMovements = movementsByKey.get(key) ?? [];
    let item: AlertItem;
    if (row.quantity === null) {
      item = {
        productId: row.productId,
        productName: row.productName,
        variantLabel,
        displayName,
        status: "unknown",
        quantity: null,
        threshold,
        daysToStockout: null,
        reason: "no_stock_record",
      };
    } else if (
      typeof row.quantity !== "number" ||
      !Number.isFinite(row.quantity) ||
      row.quantity < 0
    ) {
      item = {
        productId: row.productId,
        productName: row.productName,
        variantLabel,
        displayName,
        status: "unknown",
        quantity: null,
        threshold,
        daysToStockout: null,
        reason: "invalid_quantity",
      };
    } else if (threshold === null) {
      item = {
        productId: row.productId,
        productName: row.productName,
        variantLabel,
        displayName,
        status: "unknown",
        quantity: row.quantity,
        threshold: null,
        daysToStockout: null,
        reason: "no_threshold",
      };
    } else if (row.quantity === 0) {
      const hint = daysToStockoutFromSales(row.quantity, ownMovements, windowDays, nowIso);
      item = {
        productId: row.productId,
        productName: row.productName,
        variantLabel,
        displayName,
        status: "out_of_stock",
        quantity: 0,
        threshold,
        daysToStockout: hint.days,
        reason: null,
      };
    } else if (row.quantity <= threshold) {
      const hint = daysToStockoutFromSales(row.quantity, ownMovements, windowDays, nowIso);
      item = {
        productId: row.productId,
        productName: row.productName,
        variantLabel,
        displayName,
        status: "low",
        quantity: row.quantity,
        threshold,
        daysToStockout: hint.days,
        reason: hint.reason,
      };
    } else {
      const hint = daysToStockoutFromSales(row.quantity, ownMovements, windowDays, nowIso);
      item = {
        productId: row.productId,
        productName: row.productName,
        variantLabel,
        displayName,
        status: "healthy",
        quantity: row.quantity,
        threshold,
        daysToStockout: hint.days,
        reason: hint.reason,
      };
    }

    if (item.status === "healthy") counts.healthy += 1;
    else if (item.status === "low") counts.low += 1;
    else if (item.status === "out_of_stock") counts.outOfStock += 1;
    else counts.unknown += 1;
    if (item.status !== "unknown") counts.tracked += 1;
    if (item.status === "out_of_stock" || item.status === "low") attention.push(item);
    else if (item.status === "unknown") unknownItems.push(item);
  }

  attention.sort(compareAttention);
  unknownItems.sort((a, b) => {
    if (a.productName !== b.productName) return a.productName < b.productName ? -1 : 1;
    const va = a.variantLabel ?? "";
    const vb = b.variantLabel ?? "";
    return va < vb ? -1 : va > vb ? 1 : 0;
  });

  return {
    businessId,
    counts,
    attention,
    unknownItems: unknownItems.slice(0, unknownCap),
    windowDays,
  };
}

/** True when any attention item exists (out-of-stock or low-stock). */
export function hasAttention(summary: InventoryAlertSummary): boolean {
  return summary.attention.length > 0;
}
