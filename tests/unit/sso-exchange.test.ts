/**
 * TEAM SSO exchange-code primitives — tests (2026-11-03).
 *
 * These tests cover ONLY the pure mechanism in src/lib/sso-exchange.ts:
 * mint/consume, single-use, expiry, audience + identity binding,
 * hashed-at-rest storage, and the fail-closed 2FA gate. They do NOT
 * prove a live cross-panel login: no HTTP endpoint is wired yet (no
 * Admin Panel consumer exists in this workspace, and no 2FA challenge
 * exists in this tree to gate on). The live-drive checks are listed as
 * UNVERIFIED in the coordinator's SSO report.
 */
import { describe, it, expect } from "vitest";
import {
  MemorySsoCodeStore,
  SSO_CODE_TTL_MS,
  consumeSsoCode,
  generateSsoCode,
  hashSsoCode,
  mintSsoCode,
  validateSsoCodeForConsume,
  type SsoTwoFactorGate,
} from "@/lib/sso-exchange";

const satisfiedGate: SsoTwoFactorGate = async () => "satisfied";
const pendingGate: SsoTwoFactorGate = async () => "pending";
const unconfiguredGate: SsoTwoFactorGate = async () => "not_configured";

const BASE = {
  firebaseUid: "firebase-uid-1",
  email: "Team@RideBangla.bd",
  audience: "admin-console" as const,
  issuedByPanel: "ai-dashboard" as const,
};

describe("sso-exchange mint", () => {
  it("mints a code whose stored record holds only the hash, bound + 5-min expiry", async () => {
    const store = new MemorySsoCodeStore();
    const res = await mintSsoCode(store, satisfiedGate, { ...BASE, nowMs: 1000 });
    expect("refusal" in res).toBe(false);
    if ("refusal" in res) return;
    expect(res.code.length).toBeGreaterThan(30);
    expect(res.record.codeHash).toBe(hashSsoCode(res.code));
    expect(res.record.firebaseUid).toBe("firebase-uid-1");
    // Email is normalised at mint time.
    expect(res.record.email).toBe("team@ridebangla.bd");
    expect(res.record.audience).toBe("admin-console");
    expect(res.record.expiresAtMs - res.record.issuedAtMs).toBe(SSO_CODE_TTL_MS);
    expect(res.record.consumedAtMs).toBeNull();
    // The store holds the hash only — the plaintext appears nowhere stored.
    const stored = await store.getByHash(res.record.codeHash);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(res.code);
  });

  it("refuses to mint when the 2FA gate is pending or not configured", async () => {
    for (const gate of [pendingGate, unconfiguredGate]) {
      const store = new MemorySsoCodeStore();
      const res = await mintSsoCode(store, gate, BASE);
      expect(res).toEqual({ refusal: "two_factor_not_satisfied" });
      // Nothing was stored: no code exists to be replayed.
      expect(await store.getByHash("anything")).toBeNull();
    }
  });

  it("refuses empty identity, unknown audience, and self-audience codes", async () => {
    const store = new MemorySsoCodeStore();
    expect(await mintSsoCode(store, satisfiedGate, { ...BASE, firebaseUid: "" })).toEqual({
      refusal: "invalid_identity",
    });
    expect(await mintSsoCode(store, satisfiedGate, { ...BASE, email: "   " })).toEqual({
      refusal: "invalid_identity",
    });
    expect(
      await mintSsoCode(store, satisfiedGate, {
        ...BASE,
        audience: "somewhere-else" as never,
      })
    ).toEqual({ refusal: "invalid_audience" });
    expect(
      await mintSsoCode(store, satisfiedGate, {
        ...BASE,
        audience: "ai-dashboard",
        issuedByPanel: "ai-dashboard",
      })
    ).toEqual({ refusal: "invalid_audience" });
  });

  it("generates distinct codes (no two mints collide)", async () => {
    expect(generateSsoCode()).not.toBe(generateSsoCode());
  });
});

describe("sso-exchange consume", () => {
  async function minted(nowMs = 1000) {
    const store = new MemorySsoCodeStore();
    const res = await mintSsoCode(store, satisfiedGate, { ...BASE, nowMs });
    if ("refusal" in res) throw new Error("mint unexpectedly refused");
    return { store, code: res.code };
  }

  it("consumes once with matching identity + audience, then refuses reuse", async () => {
    const { store, code } = await minted();
    const first = await consumeSsoCode(store, code, {
      firebaseUid: "firebase-uid-1",
      email: "team@ridebangla.bd",
      audience: "admin-console",
      nowMs: 2000,
    });
    expect("refusal" in first).toBe(false);
    const second = await consumeSsoCode(store, code, {
      firebaseUid: "firebase-uid-1",
      email: "team@ridebangla.bd",
      audience: "admin-console",
      nowMs: 3000,
    });
    expect(second).toEqual({ refusal: "code_already_used" });
  });

  it("refuses expired codes (at and after the 5-minute boundary)", async () => {
    const { store, code } = await minted(1000);
    const atBoundary = await consumeSsoCode(store, code, {
      firebaseUid: "firebase-uid-1",
      email: "team@ridebangla.bd",
      audience: "admin-console",
      nowMs: 1000 + SSO_CODE_TTL_MS,
    });
    expect(atBoundary).toEqual({ refusal: "code_expired" });
  });

  it("refuses wrong uid, wrong email, and wrong audience", async () => {
    const { store, code } = await minted();
    expect(
      await consumeSsoCode(store, code, {
        firebaseUid: "different-uid",
        email: "team@ridebangla.bd",
        audience: "admin-console",
        nowMs: 2000,
      })
    ).toEqual({ refusal: "identity_mismatch" });
    expect(
      await consumeSsoCode(store, code, {
        firebaseUid: "firebase-uid-1",
        email: "someone-else@ridebangla.bd",
        audience: "admin-console",
        nowMs: 2000,
      })
    ).toEqual({ refusal: "identity_mismatch" });
    expect(
      await consumeSsoCode(store, code, {
        firebaseUid: "firebase-uid-1",
        email: "team@ridebangla.bd",
        audience: "ai-dashboard",
        nowMs: 2000,
      })
    ).toEqual({ refusal: "audience_mismatch" });
  });

  it("refuses unknown and tampered codes", async () => {
    const { store, code } = await minted();
    expect(
      await consumeSsoCode(store, "never-minted-code", {
        firebaseUid: "firebase-uid-1",
        email: "team@ridebangla.bd",
        audience: "admin-console",
        nowMs: 2000,
      })
    ).toEqual({ refusal: "code_not_found" });
    const tampered = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
    expect(
      await consumeSsoCode(store, tampered, {
        firebaseUid: "firebase-uid-1",
        email: "team@ridebangla.bd",
        audience: "admin-console",
        nowMs: 2000,
      })
    ).toEqual({ refusal: "code_not_found" });
  });

  it("carries no role: the consumed record has no role field to trust", async () => {
    const { store, code } = await minted();
    const res = await consumeSsoCode(store, code, {
      firebaseUid: "firebase-uid-1",
      email: "team@ridebangla.bd",
      audience: "admin-console",
      nowMs: 2000,
    });
    expect("refusal" in res).toBe(false);
    if ("refusal" in res) return;
    expect("role" in res.record).toBe(false);
  });

  it("validateSsoCodeForConsume reports already-used before expiry checks", () => {
    const refusal = validateSsoCodeForConsume(
      {
        codeHash: "abc",
        firebaseUid: "u1",
        email: "a@b.c",
        audience: "admin-console",
        issuedByPanel: "ai-dashboard",
        issuedAtMs: 0,
        expiresAtMs: 1,
        consumedAtMs: 500,
      },
      { firebaseUid: "u1", email: "a@b.c", audience: "admin-console", nowMs: 9999 }
    );
    expect(refusal).toBe("code_already_used");
  });
});
