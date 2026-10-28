/**
 * LEG D (inventory batch, STAGED ONLY) — Dashboard staff adjustment route.
 *
 * POST /api/inventory/adjustments
 *   Body: { command: string, productId?: string, reason?: string }
 *   Auth: dashboard auth via `requireAuth(request, "knowledge:update")`
 *         (supervisor + admin + super_admin at HEAD; viewer/agent 403).
 *         This is the SAME permission the catalog-write route already
 *         uses, so no new rbac key is needed for this leg — a dedicated
 *         `inventory:adjust` permission is a follow-up in the
 *         integration doc, not silently invented here.
 *   Tenant scope: `runWithBusiness(auth.businessId)`; a null businessId
 *         (Super Admin without a business) is refused 403, fail-closed.
 *
 * This route is NOT a chat route and is NOT reachable from the public
 * visitor widget (which authenticates by siteKey only and carries no
 * staff session). Staff type or paste the chat-style command in a
 * dashboard adjustment box; the command TEXT is parsed, the dashboard
 * session supplies the authority. A future staff-chat surface inside
 * the dashboard (e.g. Inbox compose) may call `handleAdjustment`
 * with its own already-authenticated sender — that wiring is an
 * owner decision (see integration doc), not staged here.
 *
 * SEAM: stock counts and the ledger live behind Leg A's `StockStore`.
 * Until Leg A lands, this route's store is `notConfiguredStore` and
 * every otherwise-valid command answers 503
 * `inventory_store_not_configured` — honestly unavailable, never
 * faked. COMPOSITION NOTE (2026-10-28): Leg A landed but its
 * `src/lib/inventory/store.ts` serves the ALERTS store (a different
 * interface), not this route's adjustments store — so no replacement
 * exists in this tree and the stub stays, still 503-honest. Wiring a
 * real adjustments store is owed work, not done here. The stub and
 * `handleAdjustment` are module-local (Next 16 route modules may not
 * export extra values); a future staff-chat surface that needs
 * `handleAdjustment` moves it to a lib module first.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness } from "@/lib/prisma";
import {
  planAdjustment,
  buildLedgerEntry,
  newAdjustmentId,
  PROPOSAL_CUSTOMER_REFUSAL,
  PROPOSAL_CLARIFICATION,
  PROPOSAL_INSUFFICIENT_STOCK,
  type StockStore,
  type StockLedgerEntry,
  type Sender,
} from "@/lib/inventory/adjustments";

/** Leg A seam: no real adjustments store exists in this tree yet (see
 * header note); the stub stays and every valid command answers 503. */
function getInventoryStore(): StockStore {
  return {
    listProducts: () => {
      throw new Error("inventory_store_not_configured");
    },
    apply: () => {
      throw new Error("inventory_store_not_configured");
    },
    listLedger: () => {
      throw new Error("inventory_store_not_configured");
    },
  };
}

export interface AdjustmentHandleInput {
  sender: Sender;
  commandText: string;
  products: ReturnType<StockStore["listProducts"]>;
  contextProductId?: string | null;
  reason?: string;
  businessId: string;
  adjustmentId: string;
  nowIso: string;
}

export type AdjustmentHandleOutcome =
  | { applied: true; entry: StockLedgerEntry }
  | { applied: false; code: string; message: string };

/**
 * Transport-independent handler: plan (pure) -> build entry -> store
 * apply (atomic, stale-guarded). Used by POST below; module-local
 * until a future surface moves it to a lib module (see header note).
 */
function handleAdjustment(
  store: StockStore,
  input: AdjustmentHandleInput,
): AdjustmentHandleOutcome {
  const contextProduct =
    input.contextProductId != null
      ? input.products.find((p) => p.id === input.contextProductId) ?? null
      : null;
  const planned = planAdjustment({
    sender: input.sender,
    commandText: input.commandText,
    products: input.products,
    contextProduct,
    reason: input.reason,
  });
  if (!planned.allowed) {
    const message =
      planned.code === "customer_forbidden"
        ? PROPOSAL_CUSTOMER_REFUSAL
        : planned.code === "insufficient_stock"
          ? PROPOSAL_INSUFFICIENT_STOCK
          : PROPOSAL_CLARIFICATION;
    return { applied: false, code: planned.code, message };
  }
  const entry = buildLedgerEntry(planned.plan, {
    id: input.adjustmentId,
    businessId: input.businessId,
    updatedBy: input.sender.kind === "staff" ? input.sender.userId : "unknown",
    reason: input.reason,
    nowIso: input.nowIso,
  });
  const result = store.apply(entry);
  if (!result.applied) {
    return {
      applied: false,
      code: "stale_stock",
      message:
        "The stock changed while this adjustment was being prepared, so nothing was applied. Please try again.",
    };
  }
  return { applied: true, entry };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "knowledge:update");
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "A business context is required for stock adjustments." },
      { status: 403 },
    );
  }
  const businessId = auth.businessId;

  return runWithBusiness(businessId, async () => {
    let body: { command?: unknown; productId?: unknown; reason?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const commandText = typeof body.command === "string" ? body.command : "";
    if (!commandText.trim()) {
      return NextResponse.json({ error: "command is required." }, { status: 400 });
    }
    const reason =
      typeof body.reason === "string" && body.reason.trim() !== ""
        ? body.reason.trim().slice(0, 500)
        : undefined;
    const contextProductId =
      typeof body.productId === "string" && body.productId.trim() !== ""
        ? body.productId.trim()
        : null;

    const store = getInventoryStore();
    let products: ReturnType<StockStore["listProducts"]>;
    try {
      products = store.listProducts(businessId);
    } catch (err) {
      if (err instanceof Error && err.message === "inventory_store_not_configured") {
        return NextResponse.json(
          { error: "inventory_store_not_configured" },
          { status: 503 },
        );
      }
      throw err;
    }
    const outcome = handleAdjustment(store, {
      sender: { kind: "staff", userId: auth.userId, businessId },
      commandText,
      products,
      contextProductId,
      reason,
      businessId,
      adjustmentId: newAdjustmentId(
        Date.now(),
        Math.random().toString(36).slice(2, 10),
      ),
      nowIso: new Date().toISOString(),
    });
    if (!outcome.applied && outcome.code === "insufficient_stock") {
      return NextResponse.json(outcome, { status: 409 });
    }
    return NextResponse.json(outcome);
  });
}
