/**
 * stock-guard.ts — LEG B (inventory batch, STAGED ONLY).
 *
 * Sell-guard: before the agent promises or confirms availability of a
 * product/variant, the caller's ledger-backed stock snapshot is checked
 * here. This module is PURE: zero runtime imports, no database, no
 * network, no ticket creation, no order write, no price / total /
 * currency / fare anywhere. It never invents stock, and it never falls
 * back to inventing stock.
 *
 * DOCTRINE (binding on this module):
 * - Stock truth = tenant data + ledger ONLY (Leg A owns the ledger
 *   model; this module does NOT define it, see the seam note below).
 * - The agent NEVER promises availability the ledger does not support.
 * - Stock 0 is NOT sellable by default. There is NO working oversell
 *   path in this module (see OVERSELL_POLICY).
 * - Per-surface identity: wording carried here is business-neutral
 *   machine data (outcomes, reasons, quantities). The model voices it
 *   under the tenant business's identity from its system prompt; no
 *   "Ride Bangla" wording lives in this module.
 * - No fare quoting: this module knows no money at all.
 *
 * SEAM — Leg A (stock / ledger model), READ BEFORE WIRING:
 * At the time this leg was staged, Leg A's report / module had not
 * landed yet (its directory held only an orders.ts anchor; no ledger
 * interface was published). This guard therefore defines its OWN
 * minimal input contract, `StockSnapshot`, and does NOT import or
 * presume any Leg A file, function, collection, or field name. The
 * apply-time merger MUST replace the snapshot-construction step (NOT
 * this file's decision logic) with Leg A's real ledger read, and MUST
 * confirm, field by field, that Leg A's read supplies:
 *   (1) the requesting tenant's businessId,
 *   (2) the product identity (and variant identity, when variants exist),
 *   (3) a ledger-backed available quantity, OR an explicit
 *       "never entered" signal for products/variants with no stock
 *       record at all.
 * If Leg A's read cannot supply (3)'s explicit signal, the merger must
 * treat "no record" as unknown-stock (this module's fail-closed
 * default) — never as available, never as zero, never as "plenty".
 * See INTEGRATION-SNIPPET.md for the wiring points.
 *
 * WHAT "UNKNOWN-STOCK" MEANS (do not soften it at apply time):
 * The tenant has never entered stock for this product/variant, or the
 * snapshot is missing / malformed / for another tenant / for another
 * product. Unknown is NOT available, NOT "probably in stock", NOT a
 * reason to promise and let the team sort it out. The honest customer
 * answer is that availability is not confirmed yet, plus the human-help
 * offer carried in `handoff` (see below).
 *
 * HANDOFF SIGNAL (reuses existing channels, invents none):
 * Every non-available outcome carries `handoff` — a DATA signal, not a
 * side effect. This pure module creates no ticket and flips no takeover
 * state. The merger wires it to channels that already exist at HEAD:
 *   - `create_ticket` agent tool (tools.ts) — the durable team signal;
 *     the agent calls it when the customer accepts the human-help offer
 *     (or, for an order the customer already placed, to flag the stock
 *     question on that order's ticket thread — merger's call, see the
 *     integration doc). Suggested title/priority ride in the signal so
 *     no new wording is invented at call time.
 *   - Engine human handoff (`performHandoff` in behaviour.ts, reached
 *     through engine.ts's handoff path) — NOT a tool and NOT callable
 *     from tools.ts. It stays exactly where it is: when the customer
 *     asks for a human, the engine path creates the ticket and flips
 *     the conversation to aiEnabled=false. The guard must never be
 *     wired to fake that flip from a tool result.
 * No new channel, webhook, SMS, or notification path is created here.
 * (Presswayy Leg D's dashboard takeover switch is staged, not landed,
 * at HEAD; it is a separate surface and is not presumed here.)
 */

/** The four stock outcomes. Nothing else may be promised. */
export type StockOutcome =
  | "available"
  | "insufficient"
  | "out-of-stock"
  | "unknown-stock";

/** Machine reason for the outcome. Server logs may carry it; the
 *  customer hears only the honest, non-leaking wording from the
 *  proposal prompt file (never a reason that reveals another tenant,
 *  another product, or internal state). */
export type StockGuardReason =
  | "in_stock"
  | "partial_stock"
  | "zero_stock"
  | "stock_never_entered"
  | "snapshot_missing"
  | "snapshot_mismatch"
  | "tenant_mismatch"
  | "invalid_quantity"
  | "invalid_snapshot";

/**
 * Human-help signal carried on every non-available outcome.
 * `offerToCustomer` — the agent offers human help in its reply.
 * `teamTicket` — the suggested (not yet created) ticket payload the
 * merger passes to the existing `create_ticket` tool if the customer
 * accepts, or attaches to the order's team thread per the integration
 * doc. Nothing here is sent anywhere by this module.
 */
export interface StockHandoffSignal {
  /** Always true on insufficient / out-of-stock / unknown-stock. */
  offerToCustomer: boolean;
  /** Channel to reuse. The only value this module ever emits. */
  channel: "create_ticket";
  /** Suggested ticket payload for the merger (proposal wording). */
  teamTicket: {
    title: string;
    description: string;
    priority: "low" | "medium" | "high";
  };
}

/**
 * What the caller asks about. `quantity` is the full quantity the
 * customer wants promised — not a partial quantity, not a guess.
 */
export interface StockGuardRequest {
  /** Tenant the request belongs to (ambient businessId at the call site). */
  businessId: string;
  /** Catalog product id when the item resolved to a catalog product. */
  productId: string | null;
  /** Variant id when the customer picked a variant; null otherwise. */
  variantId?: string | null;
  /** Display name, used only for the handoff ticket text. */
  productName: string;
  /** Requested quantity. Must be a positive integer. */
  quantity: number;
}

/**
 * Ledger-backed stock snapshot for ONE product/variant, supplied by the
 * caller (at apply time: Leg A's ledger read). This module never fetches
 * it, so it can never silently substitute a stale or foreign snapshot.
 *
 * - `stockKnown === false` (or `availableQuantity === null`) means the
 *   tenant has never entered stock for this product/variant. That is
 *   unknown-stock, full stop.
 * - `availableQuantity` is the ledger's available count AFTER any
 *   reservation Leg A applies. If Leg A's ledger reports on-hand and
 *   reserved separately, the merger computes available = on-hand minus
 *   reserved and passes THAT here; this module does not define the
 *   reservation rule and must not be given raw on-hand as "available".
 * - A snapshot for a different business, product, or variant does NOT
 *   satisfy a request (mismatch -> unknown-stock, fail closed).
 */
export interface StockSnapshot {
  businessId: string;
  productId: string | null;
  variantId?: string | null;
  /** False when the tenant never entered stock for this item. */
  stockKnown: boolean;
  /** Ledger available count; null when unknown. Integer >= 0 when known. */
  availableQuantity: number | null;
  /** Provenance marker. Only "ledger" is accepted as stock truth. */
  source: "ledger";
}

/**
 * OVERSELL POLICY — documented, default-off, UNIMPLEMENTED, by design.
 *
 * There is deliberately NO `allowOversell` parameter, NO snapshot field,
 * and NO code path in this module that can turn a zero / insufficient
 * result into a promise. If a future snapshot ever carries an oversell
 * flag, this module does not read it (see checkStock: no field named
 * oversell is consulted anywhere in this file).
 *
 * OWNER DECISION (open, not silently decided): whether any tenant may
 * ever be allowed to oversell, under what explicit opt-in, and with
 * what customer wording. Until the owner decides AND a separate,
 * reviewed change implements it, stock 0 stays unsellable and a
 * shortfall stays unpromisable. Do not "temporarily" enable oversell
 * at apply time.
 */
export const OVERSELL_POLICY = {
  enabled: false,
  implemented: false,
  /** Why: oversell is a business promise to a customer the stock cannot
   *  keep. It needs an owner decision, not a default. */
  decision: "OWNER_DECISION" as const,
} as const;

export interface StockGuardResult {
  outcome: StockOutcome;
  /** True ONLY when the full requested quantity may be promised. */
  mayPromise: boolean;
  /** The requested quantity, echoed for the caller to re-check against. */
  requestedQuantity: number;
  /**
   * Quantity the ledger can actually fulfil right now.
   * - available: equals requestedQuantity.
   * - insufficient: the ledger count (customer may accept this smaller
   *   quantity — but that acceptance is a NEW request: the merger must
   *   re-run checkStock with the smaller quantity before promising it).
   * - out-of-stock: 0. - unknown-stock: null (never a number).
   */
  fulfillableQuantity: number | null;
  reason: StockGuardReason;
  /** Present on every non-available outcome; null when available. */
  handoff: StockHandoffSignal | null;
  /** True when the snapshot failed tenant/product/variant matching.
   *  The merger must log `reason` server-side only and show the
   *  customer the generic unknown-stock wording — never the reason. */
  snapshotTrusted: boolean;
}

function isPositiveInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isValidAvailableQuantity(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function handoffFor(
  productName: string,
  outcome: StockOutcome,
  requestedQuantity: number,
  fulfillableQuantity: number | null,
): StockHandoffSignal {
  const detail =
    outcome === "out-of-stock"
      ? `Requested ${requestedQuantity}; ledger stock is 0.`
      : outcome === "insufficient"
        ? `Requested ${requestedQuantity}; ledger can fulfil ${fulfillableQuantity}.`
        : `Requested ${requestedQuantity}; stock is not recorded for this item, so availability cannot be confirmed from the ledger.`;
  return {
    offerToCustomer: true,
    channel: "create_ticket",
    teamTicket: {
      title: `Stock question — ${productName}`,
      description:
        `Customer asked about "${productName}" (${detail}) ` +
        `The agent did not promise availability. Please confirm stock with the customer.`,
      priority: outcome === "out-of-stock" ? "medium" : "medium",
    },
  };
}

/**
 * Check ONE requested line against ONE ledger snapshot.
 * Pure and total: every input shape yields an outcome; no input shape
 * yields a promise the ledger does not support.
 */
export function checkStock(
  request: StockGuardRequest,
  snapshot: StockSnapshot | null | undefined,
): StockGuardResult {
  const requestedQuantity = request.quantity;
  const untrusted = (reason: StockGuardReason): StockGuardResult => ({
    outcome: "unknown-stock",
    mayPromise: false,
    requestedQuantity,
    fulfillableQuantity: null,
    reason,
    handoff: handoffFor(
      request.productName,
      "unknown-stock",
      requestedQuantity,
      null,
    ),
    snapshotTrusted: false,
  });

  // Quantity is validated first: a non-positive / non-integer request
  // is not a stock state and can never be promised.
  if (!isPositiveInteger(request.quantity)) {
    return untrusted("invalid_quantity");
  }

  // Fail closed on every snapshot problem. Note the order: tenant
  // mismatch is checked before product mismatch so a cross-tenant
  // snapshot can never satisfy a request even for the same product id.
  if (!snapshot) return untrusted("snapshot_missing");
  if (snapshot.businessId !== request.businessId) {
    return untrusted("tenant_mismatch");
  }
  if (
    snapshot.productId !== request.productId ||
    (snapshot.variantId ?? null) !== (request.variantId ?? null)
  ) {
    return untrusted("snapshot_mismatch");
  }
  if (snapshot.source !== "ledger") return untrusted("invalid_snapshot");
  if (!snapshot.stockKnown || snapshot.availableQuantity === null) {
    return {
      outcome: "unknown-stock",
      mayPromise: false,
      requestedQuantity,
      fulfillableQuantity: null,
      reason: "stock_never_entered",
      handoff: handoffFor(
        request.productName,
        "unknown-stock",
        requestedQuantity,
        null,
      ),
      snapshotTrusted: true,
    };
  }
  if (!isValidAvailableQuantity(snapshot.availableQuantity)) {
    return untrusted("invalid_snapshot");
  }

  const available = snapshot.availableQuantity;
  if (available === 0) {
    return {
      outcome: "out-of-stock",
      mayPromise: false,
      requestedQuantity,
      fulfillableQuantity: 0,
      reason: "zero_stock",
      handoff: handoffFor(
        request.productName,
        "out-of-stock",
        requestedQuantity,
        0,
      ),
      snapshotTrusted: true,
    };
  }
  if (requestedQuantity <= available) {
    return {
      outcome: "available",
      mayPromise: true,
      requestedQuantity,
      fulfillableQuantity: requestedQuantity,
      reason: "in_stock",
      handoff: null,
      snapshotTrusted: true,
    };
  }
  return {
    outcome: "insufficient",
    mayPromise: false,
    requestedQuantity,
    fulfillableQuantity: available,
    reason: "partial_stock",
    handoff: handoffFor(
      request.productName,
      "insufficient",
      requestedQuantity,
      available,
    ),
    snapshotTrusted: true,
  };
}

/** One order line paired with its snapshot, for multi-item checks. */
export interface StockGuardLine {
  request: StockGuardRequest;
  snapshot: StockSnapshot | null | undefined;
}

export interface StockGuardOrderResult {
  /** "available" ONLY when every line is available. Otherwise the
   *  summary outcome by precedence: out-of-stock, then unknown-stock,
   *  then insufficient. Per-line results are authoritative; this
   *  summary exists only to gate the promise (mayPromise). */
  overallOutcome: StockOutcome;
  /** True ONLY when every line may be promised in full. */
  mayPromise: boolean;
  lines: StockGuardResult[];
  /** Handoff signals for the lines that are not available (empty when
   *  every line is available). */
  handoffs: StockHandoffSignal[];
}

/**
 * Check a whole order's lines, all-or-nothing: one unpromisable line
 * blocks promising the order. The caller must still surface the
 * PER-LINE outcomes to the customer (which item is short, by how many,
 * which item's stock is unknown) — never a bare "not available".
 */
export function checkOrderLines(lines: StockGuardLine[]): StockGuardOrderResult {
  const results = lines.map((l) => checkStock(l.request, l.snapshot));
  const mayPromise = results.every((r) => r.mayPromise);
  let overallOutcome: StockOutcome = "available";
  if (!mayPromise) {
    if (results.some((r) => r.outcome === "out-of-stock")) {
      overallOutcome = "out-of-stock";
    } else if (results.some((r) => r.outcome === "unknown-stock")) {
      overallOutcome = "unknown-stock";
    } else {
      overallOutcome = "insufficient";
    }
  }
  return {
    overallOutcome,
    mayPromise,
    lines: results,
    handoffs: results
      .filter((r) => r.handoff !== null)
      .map((r) => r.handoff as StockHandoffSignal),
  };
}
