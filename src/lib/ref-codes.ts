/**
 * ref-codes.ts — payment reference codes (Billing Phase 2).
 *
 * Every manual payment claim (subscription or wallet deposit) gets a
 * server-generated reference code: `RB-` + 8 uppercase alphanumerics, drawn
 * from crypto randomness. The customer is shown the code and asked to
 * include it in their payment note / memo — the auto-verify exchange
 * adapters match incoming crypto deposits on memo-contains-refCode.
 *
 * Uniqueness is enforced INSIDE the Firestore creation transaction
 * (query for the candidate code; retry on collision), so two concurrent
 * claims can never share a code.
 *
 * SERVER-ONLY: used by wallet.ts / manual-payments.ts / auto-verify.ts.
 */

import { randomBytes } from "crypto";
import type admin from "firebase-admin";

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_BODY_LENGTH = 8;
const CODE_PREFIX = "RB-";
const MAX_ATTEMPTS = 5;

/** One reference code: `RB-` + 8 uppercase alphanumerics (crypto-random). */
export function generateRefCode(): string {
  const bytes = randomBytes(CODE_BODY_LENGTH);
  let body = "";
  for (let i = 0; i < CODE_BODY_LENGTH; i++) {
    body += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return `${CODE_PREFIX}${body}`;
}

/** True for strings that look like a generated reference code. */
export function isValidRefCode(value: unknown): value is string {
  return (
    typeof value === "string" && /^RB-[A-Z0-9]{8}$/.test(value)
  );
}

/** Thrown inside the creation transaction when the candidate code collides. */
class RefCodeCollisionError extends Error {
  constructor() {
    super("refCode collision");
    this.name = "RefCodeCollisionError";
  }
}

/**
 * Create a document in `collection` with a unique refCode, atomically.
 * The refCode candidate is checked inside the same Firestore transaction
 * that writes the document; on collision a fresh code is tried (up to
 * MAX_ATTEMPTS). `data` must NOT contain refCode — it is added here.
 *
 * Returns the new document id and the assigned refCode.
 */
export async function createWithUniqueRefCode(
  db: admin.firestore.Firestore,
  collection: string,
  data: Record<string, unknown>
): Promise<{ id: string; refCode: string }> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const refCode = generateRefCode();
    try {
      const id = await db.runTransaction(async (tx) => {
        const existing = await tx.get(
          db.collection(collection).where("refCode", "==", refCode).limit(1)
        );
        if (!existing.empty) throw new RefCodeCollisionError();
        const ref = db.collection(collection).doc();
        tx.set(ref, { ...data, refCode });
        return ref.id;
      });
      return { id, refCode };
    } catch (err) {
      if (err instanceof RefCodeCollisionError) continue;
      throw err;
    }
  }
  throw new Error(
    `Could not generate a unique payment reference after ${MAX_ATTEMPTS} attempts.`
  );
}
