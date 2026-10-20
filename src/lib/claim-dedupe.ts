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
import { getAdminDb } from "./admin-db";

export class DuplicateTxnError extends Error {
  readonly code = "duplicate_txn";
  constructor(txnId: string) {
    super(
      `This transaction ID (${txnId}) has already been submitted on another payment claim. If that claim is yours, please wait for it to be verified instead of submitting again.`
    );
    this.name = "DuplicateTxnError";
  }
}

export async function assertTxnIdNotClaimed(txnId: string): Promise<void> {
  const clean = txnId.trim();
  if (!clean) return;
  const snap = await getAdminDb()
    .collection("payment_claims")
    .where("txnId", "==", clean)
    .limit(10)
    .get();
  const clash = snap.docs.some((d) => {
    const s = (d.data() as { status?: unknown }).status;
    return s === "pending" || s === "approved";
  });
  if (clash) throw new DuplicateTxnError(clean);
}
