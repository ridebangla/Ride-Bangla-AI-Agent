/**
 * TEAM 2FA (2026-11-03) — unit tests for the TOTP library.
 *
 * All secrets/codes here are obviously-fake test fixtures (generated at
 * runtime or fixed example values). No real account secret appears here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  findMatchingBackupCodeHash,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  totpCode,
  verifyTotpCode,
  isTwoFactorChallengeBlocked,
  recordTwoFactorChallengeFailure,
  clearTwoFactorChallengeAttempts,
  __resetTwoFactorChallengeStoreForTests,
} from "@/lib/two-factor";

beforeAll(() => {
  // Obviously-fake test key (repeated hex pattern, 32 bytes). The
  // library fails closed without a key outside tests.
  process.env.TOTP_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
});

describe("TOTP generation and verification", () => {
  it("generates a 32-char base32 secret, different every time", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });

  it("base32 round-trips", () => {
    const bytes = Buffer.from("test-bytes-for-roundtrip");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("a code verifies at its own time and ±1 step, but not ±3 steps", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code, now)).toBe(true);
    expect(verifyTotpCode(secret, code, now + 30_000)).toBe(true);
    expect(verifyTotpCode(secret, code, now - 30_000)).toBe(true);
    // ±90 s is outside the ±1-step window: an expired code fails closed.
    expect(verifyTotpCode(secret, code, now + 90_000)).toBe(false);
    expect(verifyTotpCode(secret, code, now - 90_000)).toBe(false);
  });

  it("wrong, malformed, and empty codes all fail closed", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    expect(verifyTotpCode(secret, wrong, now)).toBe(false);
    expect(verifyTotpCode(secret, "abcdef", now)).toBe(false);
    expect(verifyTotpCode(secret, "12345", now)).toBe(false);
    expect(verifyTotpCode(secret, "", now)).toBe(false);
    expect(verifyTotpCode(secret, undefined, now)).toBe(false);
    expect(verifyTotpCode(secret, " 12 34 56 ", now)).toBe(false);
  });

  it("codes tolerate spaces/hyphens only when the digits are right", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    expect(verifyTotpCode(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });

  it("builds a well-formed otpauth URI", () => {
    const uri = buildOtpauthUri("JBSWY3DPEHPK3PXP", "owner@example.test");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("secret encryption at rest", () => {
  it("round-trips and never returns plaintext from the stored form", () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptTotpSecret(encrypted)).toBe(secret);
  });

  it("tampered ciphertext fails closed", () => {
    const encrypted = encryptTotpSecret(generateTotpSecret());
    const raw = Buffer.from(encrypted, "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptTotpSecret(raw.toString("base64"))).toThrow();
  });
});

describe("backup codes", () => {
  it("generates 10 unique codes, hashed only, single-use matchable", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^\d{4}-\d{4}$/);
    const hashes = codes.map(hashBackupCode);
    // Stored form contains no plaintext code.
    for (const code of codes) expect(hashes.join(",")).not.toContain(code);
    const matched = findMatchingBackupCodeHash(hashes, codes[0]);
    expect(matched).toBe(hashes[0]);
    // Consuming it (removing the hash) makes reuse fail.
    const remaining = hashes.filter((h) => h !== matched);
    expect(findMatchingBackupCodeHash(remaining, codes[0])).toBeNull();
    expect(findMatchingBackupCodeHash(hashes, "0000-0000")).toBeNull();
    expect(findMatchingBackupCodeHash(hashes, "not-a-code")).toBeNull();
  });
});

describe("challenge rate limiting (challenge only, never the password)", () => {
  it("blocks after 5 failures and clears on success", () => {
    __resetTwoFactorChallengeStoreForTests();
    const adminId = "test-admin-rate-limit";
    expect(isTwoFactorChallengeBlocked(adminId)).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect(isTwoFactorChallengeBlocked(adminId)).toBe(false);
      recordTwoFactorChallengeFailure(adminId);
    }
    expect(isTwoFactorChallengeBlocked(adminId)).toBe(true);
    clearTwoFactorChallengeAttempts(adminId);
    expect(isTwoFactorChallengeBlocked(adminId)).toBe(false);
    __resetTwoFactorChallengeStoreForTests();
  });
});
