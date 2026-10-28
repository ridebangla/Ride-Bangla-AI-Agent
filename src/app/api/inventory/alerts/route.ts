/**
 * GET /api/inventory/alerts — LEG E (inventory batch, STAGED ONLY).
 *
 * Tenant-scoped dashboard read: low-stock counts + attention list +
 * days-to-stockout hints, computed ONLY from tenant catalog data,
 * Leg A's stock store, and recorded ledger sales. No writes, no
 * metering, no plan-quota gate (alerts are not messages and must
 * never be gated by the ~100 msgs/month free-tier count).
 *
 * Route convention (verified at HEAD 706df0fd): requireAuth with a
 * permission, then runWithBusiness(auth.businessId, ...) so every
 * scoped query is tenant-scoped and fail-closed — the same shape as
 * GET /api/orders (tickets:read). This route uses the NEW
 * "inventory:read" permission (LE-05 rbac diff; viewer and up, same
 * audience as the catalog/dashboard read surface).
 *
 * Fail-closed rules:
 * - Unauthenticated → requireAuth's 401/403 (unchanged).
 * - Super Admin (businessId null) → 403: a null business has no
 *   tenant stock to report, and an unscoped alert payload must never
 *   be produced. (Same 403-for-null pattern as the bulk-import leg.)
 * - Stock store not yet implemented (Leg A pending) → 503 with
 *   code "stock_store_not_configured". The dashboard card renders
 *   this honestly; it never falls back to invented stock.
 * - windowDays query param: integer 1–365, default 30. The default
 *   value 30 is a PROPOSAL (OWNER DECISION D2); it is not presented
 *   to the tenant as a settled business rule.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { buildInventoryAlerts } from "@/lib/inventory/alerts";
import { stockStore, StockStoreNotConfigured } from "@/lib/inventory/store";

const DEFAULT_WINDOW_DAYS = 30; // PROPOSAL — owner decision D2.

function parseWindowDays(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get("windowDays");
  if (raw === null) return DEFAULT_WINDOW_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) return DEFAULT_WINDOW_DAYS;
  return n;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "inventory:read");
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "inventory_alerts_require_tenant" },
      { status: 403 },
    );
  }
  const businessId = auth.businessId;
  return runWithBusiness(businessId, async () => {
    try {
      const windowDays = parseWindowDays(request);
      const nowIso = new Date().toISOString();
      // Catalog list (tenant-scoped by runWithBusiness). The stock
      // loader joins quantities onto these products; products with no
      // stock row arrive as quantity null (unknown — never healthy).
      const products = await prisma.product.findMany({
        orderBy: { name: "asc" },
        take: 1000,
      });
      const catalog = products.map((p: { id: string; name: string }) => ({
        productId: p.id,
        productName: p.name,
      }));
      const [rows, movements, tenantDefaultThreshold] = await Promise.all([
        stockStore.loadStockRows(businessId, catalog),
        stockStore.loadSaleMovements(businessId, windowDays, nowIso),
        stockStore.loadTenantDefaultThreshold(businessId),
      ]);
      const summary = buildInventoryAlerts({
        businessId,
        rows,
        movements,
        tenantDefaultThreshold,
        windowDays,
        nowIso,
      });
      return NextResponse.json(summary);
    } catch (err) {
      if (err instanceof StockStoreNotConfigured) {
        return NextResponse.json(
          {
            error: "stock_store_not_configured",
            message:
              "Stock tracking is not connected yet for this business.",
          },
          { status: 503 },
        );
      }
      throw err;
    }
  });
}
