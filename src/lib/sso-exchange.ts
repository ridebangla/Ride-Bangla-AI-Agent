/**
 * sso-exchange.ts — TEAM SSO exchange-code primitives (2026-11-03).
 *
 * SCOPE — READ BEFORE WIRING ANYTHING TO THIS MODULE:
 * This file is PURE MECHANISM, deliberately NOT a live endpoint. It
 * implements only the mint/consume mathematics of the unified-login
 * handoff (one-time code, short expiry, audience + identity binding,
 * hashed-at-rest storage, fail-closed 2FA gate). NO HTTP route in this
 * repo calls it yet, and that is intentional:
 *
 *   1. The consuming panel (Admin Console, admin.ridebangla.bd) has no
 *      editable checkout in this workspace — its AuthContext, login
 *      screen and Firebase config files are absent (see the SSO report
 *      to the coordinator) — so no consumer exists to accept a code.
 *   2. No authenticator-app 2FA challenge exists anywhere in this tree
 *      yet (the 2FA team's parallel work). Minting a code today would
 *      create a session-issuing path that the 2FA gate cannot yet sit
 *      in front of, so minting FAILS CLOSED until a real gate is
 *      supplied (see SsoTwoFactorGate below).
 *
 * Wiring this module to a live /api/auth/sso/* endpoint BEFORE both
 * (1) and (2) land would ship a dead attack surface, not SSO. The
 * endpoint diff specs (AI issuer, AI consumer, Admin consumer, rules)
 * live in the coordinator's SSO report; they land only with a real
 * Admin Panel checkout and a real 2FA gate.
 *
 * DESIGN (the mechanism the endpoints must use, unchanged):
 * - Central identity is the SHARED Firebase Auth project
 *   (ride-bangla-app): the source panel has already verified the
 *   Firebase ID token, exactly as /api/auth/firebase does today.
 * - Handoff is a single-use exchange CODE, never a session token:
 *   32 random bytes, base64url. Only its SHA-256 hash is ever stored.
 *   The plaintext code travels exactly once, in a POST body from the
 *   source panel to the target panel's consume endpoint (auto-submitted
 *   form, same-tab or new-tab). It NEVER appears in a URL, a log line,
 *   a referrer, or a GET parameter. This module logs NOTHING at all.
 * - Lifetime: 5 minutes (SSO_CODE_TTL_MS). Long enough for one human
 *   tap + one POST; short enough that a leaked code is near-useless.
 *   Expiry is checked at consume time against the stored record.
 * - Binding: a code is bound to ONE Firebase uid, ONE normalised
 *   email, and ONE audience panel. The consumer must present the same
 *   uid + email (from its own freshly verified Firebase sign-in) and
 *   the matching audience, or consumption fails.
 * - Single-use: consumption is atomic in the store (see SsoCodeStore
 *   .consume — the Firestore implementation MUST run it inside a
 *   transaction: read, check unconsumed + unexpired, mark consumed, or
 *   abort). A second consume of the same code ALWAYS fails, even
 *   within the 5-minute window.
 * - AUTHENTICATION ONLY, never authorisation: a consumed code proves
 *   "this Firebase identity just signed in at the source panel". It
 *   carries NO role. The consuming panel MUST re-resolve roles from
 *   ITS OWN store (AI: resolveSignInAdmin; Admin Console: its own
 *   admin_profiles lookup) and fail closed (403, no session) when that
 *   identity holds no role there. Role claims from the source panel
 *   are never trusted — this module does not even have a role field.
 * - Logout/revocation semantics (stated, to be implemented exactly as
 *   stated by the endpoint diffs): logout from one panel revokes ONLY
 *   that panel's own session (AI: rbai token pair revocation, as today;
 *   Admin: its admin_sessions doc ends). It does NOT revoke the other
 *   panel's session and does NOT revoke the central Firebase session.
 *   There is NO global logout in this design and none may be claimed.
 *   Exchange codes are independent of panel sessions: revoking a panel
 *   session does not retroactively invalidate an already-consumed
 *   code (nothing to invalidate — consumption already minted the
 *   target session, which has its own revocation), and an unconsumed
 *   code simply expires after 5 minutes.
 *
 * 2FA GATE (SsoTwoFactorGate):
 * Minting requires gate(firebaseUid, email) === "satisfied". Any other
 * outcome — "pending" (challenge not yet completed) or
 * "not_configured" (no 2FA module wired in yet) — REFUSES to mint.
 * There is deliberately NO default gate and NO pass-through: a caller
 * that cannot supply the 2FA team's real challenge check cannot mint.
 * SSO consumes the 2FA challenge; it never reimplements TOTP, secrets,
 * or QR internals, and it never creates a path that skips the challenge
 * for an account that has 2FA on. Activation itself stays under the
 * hard rule (code entered + submitted, never automatic, never an
 * admin flip) — that rule lives with the 2FA team, not here.
 */

import { createHash, randomBytes } from "crypto";

/** Exchange-code lifetime: 5 minutes. See header for why. */
export const SSO_CODE_TTL_MS = 5 * 60 * 1000;

/** Raw code entropy: 32 bytes (256 bits), base64url-encoded. */
export const SSO_CODE_BYTES = 32;

/** Panels that may consume an exchange code. No other audience exists. */
export type SsoAudience = "admin-console" | "ai-dashboard";

export const SSO_AUDIENCES: readonly SsoAudience[] = [
  "admin-console",
  "ai-dashboard",
];

/** Outcome of the 2FA team's challenge check for one identity. */
export type SsoTwoFactorOutcome = "satisfied" | "pending" | "not_configured";

/**
 * The 2FA challenge check, supplied by the 2FA team's module when it
 * lands. SSO calls it; SSO never implements it. Until a real check is
 * supplied, minting refuses (fail-closed) — see mintSsoCode.
 */
export type SsoTwoFactorGate = (input: {
  firebaseUid: string;
  email: string;
}) => Promise<SsoTwoFactorOutcome>;

/** A stored exchange-code record. `codeHash` only — never plaintext. */
export interface SsoCodeRecord {
  /** SHA-256 hex of the plaintext code. The lookup key. */
  codeHash: string;
  /** Firebase uid the code was minted for (verified at the source). */
  firebaseUid: string;
  /** Lower-cased, trimmed email the code was minted for. */
  email: string;
  /** Which panel may consume this code. */
  audience: SsoAudience;
  /** Which panel minted it (audit label only, never trusted). */
  issuedByPanel: SsoAudience;
  /** Epoch ms at mint time. */
  issuedAtMs: number;
  /** Epoch ms after which consumption fails (issuedAtMs + TTL). */
  expiresAtMs: number;
  /** Epoch ms of consumption, or null while unconsumed. */
  consumedAtMs: number | null;
}

/**
 * Storage contract for exchange codes. Implementations MUST make
 * `consume` atomic (check unconsumed + mark consumed in one step):
 * the in-memory implementation below does it synchronously; the
 * Firestore implementation MUST use a transaction. A non-atomic store
 * breaks single-use and must not be used.
 */
export interface SsoCodeStore {
  /** Persist a freshly minted record (codeHash is the document id). */
  put(record: SsoCodeRecord): Promise<void>;
  /** Load a record by code hash, or null. */
  getByHash(codeHash: string): Promise<SsoCodeRecord | null>;
  /**
   * Atomically mark a record consumed. Returns the record with
   * consumedAtMs set, or null when the record does not exist or was
   * already consumed (the caller treats null as "already used").
   */
  consume(codeHash: string, nowMs: number): Promise<SsoCodeRecord | null>;
}

/** Generate a fresh plaintext exchange code (transported once, POST). */
export function generateSsoCode(): string {
  return randomBytes(SSO_CODE_BYTES).toString("base64url");
}

/** SHA-256 hex of a code — the only form ever stored or looked up. */
export function hashSsoCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function normaliseSsoEmail(email: string): string {
  return email.toLowerCase().trim();
}

function isAudience(value: unknown): value is SsoAudience {
  return value === "admin-console" || value === "ai-dashboard";
}

/** Why minting or consumption was refused. No reason ever echoes a code. */
export type SsoRefusal =
  | "invalid_identity"
  | "invalid_audience"
  | "two_factor_not_satisfied"
  | "code_not_found"
  | "code_already_used"
  | "code_expired"
  | "identity_mismatch"
  | "audience_mismatch";

/**
 * Mint an exchange code. FAILS CLOSED on every bad input:
 * empty uid/email, unknown audience, or a 2FA gate outcome other than
 * "satisfied". On success returns the PLAINTEXT code (hand it to the
 * POST handoff immediately; never store it, never log it) — the store
 * receives only the hashed record.
 */
export async function mintSsoCode(
  store: SsoCodeStore,
  gate: SsoTwoFactorGate,
  input: {
    firebaseUid: string;
    email: string;
    audience: SsoAudience;
    issuedByPanel: SsoAudience;
    nowMs?: number;
  }
): Promise<{ code: string; record: SsoCodeRecord } | { refusal: SsoRefusal }> {
  const firebaseUid = (input.firebaseUid || "").trim();
  const email = normaliseSsoEmail(input.email || "");
  if (!firebaseUid || !email) return { refusal: "invalid_identity" };
  if (!isAudience(input.audience) || !isAudience(input.issuedByPanel)) {
    return { refusal: "invalid_audience" };
  }
  if (input.audience === input.issuedByPanel) {
    // A code for the panel that minted it is a no-op handoff; refuse
    // rather than minting a self-loop credential.
    return { refusal: "invalid_audience" };
  }
  const gateOutcome = await gate({ firebaseUid, email });
  if (gateOutcome !== "satisfied") {
    return { refusal: "two_factor_not_satisfied" };
  }
  const nowMs = input.nowMs ?? Date.now();
  const code = generateSsoCode();
  const record: SsoCodeRecord = {
    codeHash: hashSsoCode(code),
    firebaseUid,
    email,
    audience: input.audience,
    issuedByPanel: input.issuedByPanel,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + SSO_CODE_TTL_MS,
    consumedAtMs: null,
  };
  await store.put(record);
  return { code, record };
}

/**
 * Pure validation of a stored record against a consume attempt.
 * Returns null when the record may be consumed, else the refusal.
 * (The atomic consumed-marking itself lives in store.consume.)
 */
export function validateSsoCodeForConsume(
  record: SsoCodeRecord | null,
  input: {
    firebaseUid: string;
    email: string;
    audience: SsoAudience;
    nowMs?: number;
  }
): SsoRefusal | null {
  if (!record) return "code_not_found";
  if (record.consumedAtMs !== null) return "code_already_used";
  const nowMs = input.nowMs ?? Date.now();
  if (nowMs >= record.expiresAtMs) return "code_expired";
  if (
    record.firebaseUid !== (input.firebaseUid || "").trim() ||
    record.email !== normaliseSsoEmail(input.email || "")
  ) {
    return "identity_mismatch";
  }
  if (record.audience !== input.audience) return "audience_mismatch";
  return null;
}

/**
 * Consume an exchange code: hash, load, validate, atomically mark
 * consumed. On success returns the record — the caller must then
 * re-resolve roles from ITS OWN store and mint ITS OWN session (or
 * 403 when the identity holds no role there). The code itself grants
 * no role and no session.
 */
export async function consumeSsoCode(
  store: SsoCodeStore,
  code: string,
  input: {
    firebaseUid: string;
    email: string;
    audience: SsoAudience;
    nowMs?: number;
  }
): Promise<{ record: SsoCodeRecord } | { refusal: SsoRefusal }> {
  if (!code || typeof code !== "string") return { refusal: "code_not_found" };
  const record = await store.getByHash(hashSsoCode(code));
  const refusal = validateSsoCodeForConsume(record, input);
  if (refusal) return { refusal };
  const consumed = await store.consume(hashSsoCode(code), input.nowMs ?? Date.now());
  if (!consumed) return { refusal: "code_already_used" };
  return { record: consumed };
}

/**
 * Synchronous in-memory store. For TESTS ONLY — production must use
 * the Firestore-backed store (transactional consume) specified in the
 * coordinator's SSO report. Never use this in a route handler: process
 * memory does not survive restarts or scale across instances.
 */
export class MemorySsoCodeStore implements SsoCodeStore {
  private readonly rows = new Map<string, SsoCodeRecord>();

  async put(record: SsoCodeRecord): Promise<void> {
    this.rows.set(record.codeHash, { ...record });
  }

  async getByHash(codeHash: string): Promise<SsoCodeRecord | null> {
    const row = this.rows.get(codeHash);
    return row ? { ...row } : null;
  }

  async consume(
    codeHash: string,
    nowMs: number
  ): Promise<SsoCodeRecord | null> {
    const row = this.rows.get(codeHash);
    if (!row || row.consumedAtMs !== null) return null;
    const consumed: SsoCodeRecord = { ...row, consumedAtMs: nowMs };
    this.rows.set(codeHash, consumed);
    return { ...consumed };
  }
}
