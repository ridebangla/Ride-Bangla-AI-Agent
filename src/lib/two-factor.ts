/**
 * Authenticator-app (TOTP) two-factor authentication — TEAM 2FA (2026-11-03).
 *
 * OWNER'S HARD RULE, enforced by construction here and by every route that
 * uses this module: 2FA activates ONLY after the account holder enters a
 * current code from their own authenticator app and that code verifies.
 * NEVER automatically, NEVER by an admin flip alone. The setup flow is:
 *   secret generated (per account, cryptographically random) -> stored
 *   ENCRYPTED as a *pending* secret -> QR / manual secret shown ONCE in
 *   the setting-up account's own authenticated session -> holder enters a
 *   code -> code verifies against the PENDING secret -> ONLY THEN is the
 *   secret promoted to active and `twoFactorEnabled` set true.
 * No route in this feature sets `twoFactorEnabled: true` except the
 * activation route, and that route does so only after a verified code.
 *
 * Storage rules:
 * - TOTP secrets are stored ENCRYPTED at rest (AES-256-GCM, server-side
 *   key from TOTP_ENCRYPTION_KEY, never in plaintext, never logged, never
 *   returned by any API after setup except the one-time QR/manual display
 *   in the owner's own session during setup).
 * - Backup codes are stored ONLY as SHA-256 hashes, each usable once
 *   (consumed on use), regenerable by the holder after re-authentication
 *   (a valid current code or backup code, in their own session).
 * - No secret or code value is ever logged by this module.
 *
 * Login challenge: after the first factor (Firebase sign-in) succeeds, a
 * 2FA-enabled account receives NO session cookies — only a short-lived
 * pending token (type "twofa_pending", see src/lib/auth.ts), which
 * `verifySessionToken` rejects as a session. The pending token + a valid
 * second-factor code is exchanged for the real session cookies. A pending
 * token alone opens nothing: dashboard/API auth requires an access token.
 *
 * Lost-everything recovery (device + backup codes both lost) is
 * DELIBERATELY NOT built here: for a single Super Admin there is no safe
 * in-code self-service answer, and inventing a bypass would defeat the
 * feature. It is reported as a decision item for the owner/coordinator.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TOTP step (seconds) and code length — RFC 6238 defaults. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes accepted this many steps either side of now (clock skew). */
export const TOTP_WINDOW_STEPS = 1;
/** A pending (not yet activated) setup secret lives this long. */
export const PENDING_SECRET_TTL_MS = 10 * 60 * 1000;
/** Backup codes issued at activation. */
export const BACKUP_CODE_COUNT = 10;
/** Challenge failures before the per-account challenge gate closes. */
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const CHALLENGE_LOCKOUT_MS = 15 * 60 * 1000;
/** Issuer shown in the authenticator app. */
export const TOTP_ISSUER = "Ride Bangla AI Agent";

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, no padding in generated secrets)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  if (!/^[A-Z2-7]*$/.test(clean)) {
    throw new Error("Invalid base32 secret");
  }
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Cryptographically random per-account secret (20 bytes -> 32 chars). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 30 s step, 6 digits)
// ---------------------------------------------------------------------------

function counterBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  // Counter fits in 53-bit JS numbers for any realistic time value.
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

export function totpCode(
  secret: string,
  nowMs: number = Date.now(),
  stepSeconds: number = TOTP_STEP_SECONDS
): string {
  const key = base32Decode(secret);
  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  const hmac = createHmac("sha1", key).update(counterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function normaliseCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const clean = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  return clean;
}

function codeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True only when `code` matches the secret at now, +/- window steps. */
export function verifyTotpCode(
  secret: string,
  code: unknown,
  nowMs: number = Date.now(),
  windowSteps: number = TOTP_WINDOW_STEPS
): boolean {
  const clean = normaliseCode(code);
  if (!clean) return false;
  try {
    for (let step = -windowSteps; step <= windowSteps; step++) {
      const at = nowMs + step * TOTP_STEP_SECONDS * 1000;
      if (codeEquals(clean, totpCode(secret, at))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function buildOtpauthUri(
  secret: string,
  accountLabel: string,
  issuer: string = TOTP_ISSUER
): string {
  const label = `${issuer}:${accountLabel}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Secret encryption at rest (AES-256-GCM, key from env — never plaintext)
// ---------------------------------------------------------------------------

function getTotpEncryptionKey(): Buffer {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    const fromB64 = Buffer.from(raw, "base64");
    if (fromB64.length === 32) return fromB64;
  }
  // Fail closed outside tests: storing a secret without a real key would
  // mean plaintext-equivalent storage. Tests set a fake key explicitly.
  if (process.env.NODE_ENV === "test" && !raw) {
    // Test-only fallback so unit tests can run without operator keys.
    // Production/test-with-key paths never reach this branch when the
    // env key is set; the branch is keyed on NODE_ENV === "test".
    return createHash("sha256").update("test-only-totp-key").digest();
  }
  throw new Error(
    "TOTP_ENCRYPTION_KEY is not configured (32-byte key as 64 hex chars or base64). " +
      "Set it before enabling two-factor setup."
  );
}

/** Encrypt a TOTP secret. Output is base64(iv || authTag || ciphertext). */
export function encryptTotpSecret(secret: string): string {
  const key = getTotpEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptTotpSecret(encrypted: string): string {
  const key = getTotpEncryptionKey();
  const raw = Buffer.from(encrypted, "base64");
  if (raw.length < 12 + 16 + 1) throw new Error("Invalid encrypted secret");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Backup codes (single-use, stored as hashes only)
// ---------------------------------------------------------------------------

export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let code = "";
    for (let i = 0; i < 8; i++) code += String(randomInt(0, 10));
    codes.add(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return [...codes];
}

export function hashBackupCode(code: string): string {
  const clean = code.replace(/[\s-]/g, "");
  return createHash("sha256").update(clean, "utf8").digest("hex");
}

/**
 * Find the stored hash matching `code` (constant-time per candidate), or
 * null. The caller removes the returned hash on success (single use).
 */
export function findMatchingBackupCodeHash(
  hashes: string[],
  code: unknown
): string | null {
  if (typeof code !== "string") return null;
  const clean = code.replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(clean)) return null;
  const presented = Buffer.from(hashBackupCode(code), "utf8");
  for (const hash of hashes) {
    const stored = Buffer.from(hash, "utf8");
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      return hash;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Admin 2FA state (fields live on the admins doc; Firestore is schemaless,
// so no migration is needed — absent fields mean "never set up").
// ---------------------------------------------------------------------------

export interface TwoFactorState {
  enabled: boolean;
  /** Encrypted active secret, or null. */
  secretEncrypted: string | null;
  /** Encrypted pending (setup, not yet activated) secret, or null. */
  pendingSecretEncrypted: string | null;
  pendingExpiresAt: Date | null;
  backupCodeHashes: string[];
  activatedAt: Date | null;
}

export function getTwoFactorState(admin: unknown): TwoFactorState {
  const a = (admin ?? {}) as Record<string, unknown>;
  const asDate = (v: unknown): Date | null => {
    if (v instanceof Date) return v;
    if (typeof v === "string" || typeof v === "number") {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    // Firestore Timestamp-like values.
    if (v && typeof v === "object" && typeof (v as { toDate?: unknown }).toDate === "function") {
      try {
        return (v as { toDate: () => Date }).toDate();
      } catch {
        return null;
      }
    }
    return null;
  };
  const hashes = Array.isArray(a.twoFactorBackupCodeHashes)
    ? (a.twoFactorBackupCodeHashes as unknown[]).filter(
        (h): h is string => typeof h === "string"
      )
    : [];
  return {
    enabled: a.twoFactorEnabled === true,
    secretEncrypted:
      typeof a.twoFactorSecretEncrypted === "string"
        ? a.twoFactorSecretEncrypted
        : null,
    pendingSecretEncrypted:
      typeof a.twoFactorPendingSecretEncrypted === "string"
        ? a.twoFactorPendingSecretEncrypted
        : null,
    pendingExpiresAt: asDate(a.twoFactorPendingExpiresAt),
    backupCodeHashes: hashes,
    activatedAt: asDate(a.twoFactorActivatedAt),
  };
}

export function isPendingSecretLive(state: TwoFactorState, nowMs = Date.now()): boolean {
  return (
    state.pendingSecretEncrypted !== null &&
    state.pendingExpiresAt !== null &&
    state.pendingExpiresAt.getTime() > nowMs
  );
}

/**
 * Verify a second-factor code against the ACTIVE secret (TOTP) or a
 * backup code. Returns the method and, for backup codes, the hash to
 * consume. Never verifies against a PENDING secret — pending secrets
 * only count at activation, never at login.
 */
export function verifySecondFactor(
  state: TwoFactorState,
  code: unknown,
  nowMs: number = Date.now()
): { ok: true; method: "totp" | "backup"; consumedHash: string | null } | { ok: false } {
  if (!state.enabled || !state.secretEncrypted) return { ok: false };
  try {
    const secret = decryptTotpSecret(state.secretEncrypted);
    if (verifyTotpCode(secret, code, nowMs)) {
      return { ok: true, method: "totp", consumedHash: null };
    }
  } catch {
    // Decryption failure (e.g. key rotated) fails closed below.
    return { ok: false };
  }
  const matched = findMatchingBackupCodeHash(state.backupCodeHashes, code);
  if (matched) return { ok: true, method: "backup", consumedHash: matched };
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Per-account challenge rate limiting (in-memory, per process).
// This gates ONLY the second-factor challenge — it never locks the
// password / Firebase first factor itself, and a blocked challenge
// issues no session. The /api/auth middleware limiter (5/min/IP) also
// applies to these routes on top.
// ---------------------------------------------------------------------------

interface ChallengeEntry {
  count: number;
  resetAt: number;
}

const challengeStore = new Map<string, ChallengeEntry>();

export function isTwoFactorChallengeBlocked(adminId: string, nowMs = Date.now()): boolean {
  const entry = challengeStore.get(adminId);
  if (!entry) return false;
  if (nowMs > entry.resetAt) {
    challengeStore.delete(adminId);
    return false;
  }
  return entry.count >= MAX_CHALLENGE_ATTEMPTS;
}

export function recordTwoFactorChallengeFailure(adminId: string, nowMs = Date.now()): void {
  const entry = challengeStore.get(adminId);
  if (!entry || nowMs > entry.resetAt) {
    challengeStore.set(adminId, { count: 1, resetAt: nowMs + CHALLENGE_LOCKOUT_MS });
    return;
  }
  entry.count += 1;
}

export function clearTwoFactorChallengeAttempts(adminId: string): void {
  challengeStore.delete(adminId);
}

/** Test seam. */
export function __resetTwoFactorChallengeStoreForTests(): void {
  challengeStore.clear();
}
