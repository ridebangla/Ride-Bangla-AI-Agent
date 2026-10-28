/**
 * INVENTORY — BLOCKING CONFIRM (head-decision implementation).
 * Repo path when applied: src/lib/inventory/blocking-confirm.ts (NEW, pure)
 *
 * HEAD-DECISION APPLIED (2026-10-28 fix-all round, not re-decided):
 * BLOCKING confirm wins (Leg C). NON-BLOCKING (Leg A snippet) is
 * SUPERSEDED and must NOT land: under blocking, a shortfall leaves
 * the order PENDING and NOTHING moves — never sell what is not in
 * stock (standing stock-truth doctrine).
 *
 * Semantics (Leg C, as staged in the inventory report):
 *  - Guard runs INSIDE one transaction with the confirm.
 *  - Any line whose required quantity exceeds quantityOnHand ->
 *    the WHOLE confirm is refused; no line moves, no line commits,
 *    the order stays pending, and the team sees the shortfall list.
 *  - A confirm that passes moves every line (no partial mode exists
 *    in Leg C's executor, and none is invented here).
 *  - Cancel-after-dispatch is NOT restocked blindly here (M5):
 *    if goods already left with a rider, cancel must go through the
 *    team procedure (reversal vs physical return), never an
 *    automatic restock in this module.
 *
 * What this module does NOT do (still owed at apply time, not faked):
 *  - It does not provide the native-transaction handle (M2: a real
 *    Admin SDK runTransaction reachable from lib code, or the
 *    serialise-confirms-per-order decision C2). The caller supplies
 *    the transaction boundary; this module only decides.
 *  - It does not pick the ledger-id scheme (M4: Leg C deterministic
 *    ids vs Leg A store-assigned ids) — ids are caller-supplied.
 *  - It does not invent damaged/missing fields (M3: Leg A has none;
 *    tallies stay ledger-only until LA-03 is extended).
 * Leg A remains the canonical MODEL (stockLevels/stockMovements,
 * variantKey) — only its NON-BLOCKING integration snippet is
 * superseded, not its model. Legs B/D/E stubs still need the M1
 * adaptation to Leg A's model before they can land; until then
 * they stay honest 503/unwired, never faked.
 */

export interface StockLine {
  productKey: string;
  variantKey?: string | null;
  required: number;
  quantityOnHand: number;
}

export type BlockingConfirmDecision =
  | { confirmed: true; moves: Array<{ productKey: string; variantKey: string | null; quantity: number }> }
  | {
      confirmed: false;
      orderStays: "pending";
      shortfalls: Array<{ productKey: string; variantKey: string | null; required: number; onHand: number; shortBy: number }>;
    };

export function decideBlockingConfirm(lines: StockLine[]): BlockingConfirmDecision {
  const shortfalls: Array<{ productKey: string; variantKey: string | null; required: number; onHand: number; shortBy: number }> = [];
  for (const line of lines) {
    if (!Number.isFinite(line.required) || line.required < 0) {
      shortfalls.push({
        productKey: line.productKey,
        variantKey: line.variantKey ?? null,
        required: line.required,
        onHand: line.quantityOnHand,
        shortBy: Number.NaN,
      });
      continue;
    }
    if (line.quantityOnHand < line.required) {
      shortfalls.push({
        productKey: line.productKey,
        variantKey: line.variantKey ?? null,
        required: line.required,
        onHand: line.quantityOnHand,
        shortBy: line.required - line.quantityOnHand,
      });
    }
  }
  if (shortfalls.length > 0) {
    // BLOCKING: nothing moves. Returning shortfalls is the team surface;
    // the caller must NOT apply a subset of moves from this result —
    // there is no moves array on the refused branch by construction.
    return { confirmed: false, orderStays: "pending", shortfalls };
  }
  return {
    confirmed: true,
    moves: lines.map((l) => ({
      productKey: l.productKey,
      variantKey: l.variantKey ?? null,
      quantity: l.required,
    })),
  };
}

/** Correction path: if the owner says "non-blocking" in one word, this
 *  module is replaced — not patched — by a partial-mode extension
 *  (executor partial mode + dashboard shortfall surfacing) as new
 *  work. Until then, any caller that commits a subset of lines on a
 *  shortfall is violating the head-decision, not implementing it. */
export const BLOCKING_CORRECTION_TRIGGER = "owner says non-blocking";
