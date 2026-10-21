/**
 * claim-dedupe.ts — one payment, one claim.
 *
 * A transaction ID that already sits on a pending/approved payment
 * claim must never fund a second claim (A-to-Z audit 2026-10-20:
 * previously a duplicate txnId only raised a fraud signal after the
 * fact, and two approved duplicates could activate / credit twice).
 * Rejected claims free the txnId again — the customer may have
 * mistyped, and a human already reviewed that first claim.
 *
 * Uses the shared Admin-SDK bootstrap (@/lib/admin-db) like the wallet
 * and fraud modules, so every claim-creation path checks the same
 * Firestore instance.
 */
import { createHash } from "crypto";
import { getAdminDb } from "./admin-db";
import { normalizeTxn } from "./payment-decision";

export class DuplicateTxnError extends Error {
  readonly code = "duplicate_txn";
  constructor(txnId: string) {
    super(
      `This transaction ID (${txnId}) has already been submitted on another payment claim. If that claim is yours, please wait for it to be verified instead of submitting again.`
    );
    this.name = "DuplicateTxnError";
  }
}

/**
 * The normalized identity of a transaction ID (attack-test 2026-10-21).
 * Uniqueness is enforced on THIS form, never on the raw string: the
 * raw-string checks let the same payment be re-claimed by re-casing or
 * re-dashing the ID (`TXN99887766` vs `txn-9988-7766`) — the receipt
 * cross-check already compared normalized forms, so a variant claim
 * passed every gate and auto-activated a second subscription.
 */
export function txnNormOf(txnId: string): string {
  return normalizeTxn(txnId.trim());
}

/**
 * Deterministic lock-doc id for one normalized transaction ID, in the
 * shared `payment_claim_locks` collection (the Studio claim route
 * writes the same namespace — one payment must never fund claims on
 * both products). The lock doc is a SERIALIZER + ownership record:
 * claim creation and claim approval both touch it inside their
 * Firestore transactions, so concurrent racers contend on ONE doc,
 * one retries, and the retry sees the winner's committed claim.
 */
export function txnLockId(txnNorm: string): string {
  return createHash("sha256").update(`txn:${txnNorm}`).digest("hex");
}

function isLiveClaim(data: Record<string, unknown>): boolean {
  const s = data.status;
  return s === "pending" || s === "approved";
}

export async function assertTxnIdNotClaimed(txnId: string): Promise<void> {
  const clean = txnId.trim();
  if (!clean) return;
  const norm = txnNormOf(clean);
  const db = getAdminDb();
  // Exact raw-string match (legacy claims carry no txnIdNorm) AND the
  // normalized match (every claim created after the attack-test fix).
  const queries = [
    db.collection("payment_claims").where("txnId", "==", clean).limit(10).get(),
  ];
  if (norm) {
    queries.push(
      db
        .collection("payment_claims")
        .where("txnIdNorm", "==", norm)
        .limit(10)
        .get()
    );
  }
  const snaps = await Promise.all(queries);
  const clash = snaps.some((snap) =>
    snap.docs.some((d) => isLiveClaim(d.data() as Record<string, unknown>))
  );
  if (clash) throw new DuplicateTxnError(clean);
}
