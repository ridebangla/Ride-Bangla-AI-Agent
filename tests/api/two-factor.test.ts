/**
 * TEAM 2FA (2026-11-03) — route-level tests for the 2FA feature.
 *
 * Proves, with the mocked data layer (tests/setup.ts):
 *  - setup does NOT activate (enabled stays false; only a pending
 *    secret is stored, encrypted — the stored update contains no
 *    plaintext secret);
 *  - activation with a wrong code does NOT enable;
 *  - activation with the holder's own current code DOES enable and
 *    returns backup codes once, stored as hashes only;
 *  - the login challenge (pending token + code) issues a session only
 *    on a valid code, and a pending token is never a session token;
 *  - a spent backup code cannot be reused.
 *
 * All secrets here are obviously-fake test fixtures. The global
 * route-auth mock authenticates as test-admin-id; the admin records
 * below are the mocked rows it resolves to.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import {
  generateTotpSecret,
  encryptTotpSecret,
  totpCode,
  hashBackupCode,
  __resetTwoFactorChallengeStoreForTests,
} from "@/lib/two-factor";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

beforeAll(() => {
  process.env.TOTP_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetTwoFactorChallengeStoreForTests();
});

function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-admin-id",
    username: "owner@example.test",
    name: "Test Owner",
    role: "super_admin",
    twoFactorEnabled: false,
    twoFactorSecretEncrypted: null,
    twoFactorPendingSecretEncrypted: null,
    twoFactorPendingExpiresAt: null,
    twoFactorBackupCodeHashes: [],
    twoFactorActivatedAt: null,
    ...overrides,
  };
}

describe("POST /api/auth/two-factor/setup", () => {
  it("starts setup WITHOUT activating and never stores a plaintext secret", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(adminRow());
    mockPrisma.admin.update.mockResolvedValue({});

    const { POST } = await import("@/app/api/auth/two-factor/setup/route");
    const response = await POST(createRequest("/api/auth/two-factor/setup", { method: "POST", body: {} }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.setupStarted).toBe(true);
    expect(data.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(typeof data.manualSecret).toBe("string");

    // The write is a PENDING secret only — enabled is never set here.
    expect(mockPrisma.admin.update).toHaveBeenCalledTimes(1);
    const written = mockPrisma.admin.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written.twoFactorPendingSecretEncrypted).toBeTruthy();
    expect(written.twoFactorEnabled).toBeUndefined();
    // Stored form must not contain the one-time plaintext secret.
    expect(JSON.stringify(written)).not.toContain(data.manualSecret);
  });

  it("refuses to start setup when already enabled", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(adminRow({ twoFactorEnabled: true }));
    const { POST } = await import("@/app/api/auth/two-factor/setup/route");
    const response = await POST(createRequest("/api/auth/two-factor/setup", { method: "POST", body: {} }));
    expect(response.status).toBe(400);
    expect(mockPrisma.admin.update).not.toHaveBeenCalled();
  });

  it("GET status exposes only booleans, never a secret", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(
      adminRow({
        twoFactorPendingSecretEncrypted: "stored-encrypted-value",
        twoFactorPendingExpiresAt: new Date(Date.now() + 600_000),
      })
    );
    const { GET } = await import("@/app/api/auth/two-factor/setup/route");
    const response = await GET(createRequest("/api/auth/two-factor/setup", { method: "GET" }));
    const data = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(data).toEqual({ enabled: false, pending: true });
    expect(JSON.stringify(data)).not.toContain("stored-encrypted-value");
  });
});

describe("POST /api/auth/two-factor/activate", () => {
  it("does NOT activate on a wrong code", async () => {
    const secret = generateTotpSecret();
    mockPrisma.admin.findUnique.mockResolvedValue(
      adminRow({
        twoFactorPendingSecretEncrypted: encryptTotpSecret(secret),
        twoFactorPendingExpiresAt: new Date(Date.now() + 600_000),
      })
    );
    const { POST } = await import("@/app/api/auth/two-factor/activate/route");
    const response = await POST(
      createRequest("/api/auth/two-factor/activate", { method: "POST", body: { code: "000000" } })
    );
    expect(response.status).toBe(401);
    expect(mockPrisma.admin.update).not.toHaveBeenCalled();
  });

  it("does NOT activate when the pending secret expired", async () => {
    const secret = generateTotpSecret();
    mockPrisma.admin.findUnique.mockResolvedValue(
      adminRow({
        twoFactorPendingSecretEncrypted: encryptTotpSecret(secret),
        twoFactorPendingExpiresAt: new Date(Date.now() - 60_000),
      })
    );
    const { POST } = await import("@/app/api/auth/two-factor/activate/route");
    const response = await POST(
      createRequest("/api/auth/two-factor/activate", {
        method: "POST",
        body: { code: totpCode(secret) },
      })
    );
    expect(response.status).toBe(400);
    const calls = mockPrisma.admin.update.mock.calls;
    // Only the stale-pending cleanup may run — never an activation.
    for (const call of calls) {
      expect((call[0].data as Record<string, unknown>).twoFactorEnabled).toBeUndefined();
    }
  });

  it("activates ONLY on the holder's own current code, issuing backup codes once (hashed in storage)", async () => {
    const secret = generateTotpSecret();
    mockPrisma.admin.findUnique.mockResolvedValue(
      adminRow({
        twoFactorPendingSecretEncrypted: encryptTotpSecret(secret),
        twoFactorPendingExpiresAt: new Date(Date.now() + 600_000),
      })
    );
    mockPrisma.admin.update.mockResolvedValue({});
    const { POST } = await import("@/app/api/auth/two-factor/activate/route");
    const response = await POST(
      createRequest("/api/auth/two-factor/activate", {
        method: "POST",
        body: { code: totpCode(secret) },
      })
    );
    const data = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(data.enabled).toBe(true);
    expect(data.backupCodes).toHaveLength(10);

    const written = mockPrisma.admin.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written.twoFactorEnabled).toBe(true);
    expect(written.twoFactorPendingSecretEncrypted).toBeNull();
    const hashes = written.twoFactorBackupCodeHashes as string[];
    expect(hashes).toHaveLength(10);
    // Stored hashes match the issued codes, but no plaintext code is stored.
    for (const code of data.backupCodes as string[]) {
      expect(hashes).toContain(hashBackupCode(code));
      expect(JSON.stringify(written)).not.toContain(code);
    }
  });
});

describe("POST /api/auth/two-factor/verify (login challenge)", () => {
  async function pendingTokenFor() {
    const { generateTwoFactorPendingToken } = await import("@/lib/auth");
    return generateTwoFactorPendingToken("test-admin-id", "super_admin");
  }

  it("a pending token is NOT a session token", async () => {
    const { verifySessionToken, verifyRefreshToken } = await import("@/lib/auth");
    const pending = await pendingTokenFor();
    expect(await verifySessionToken(pending)).toBeNull();
    expect(await verifyRefreshToken(pending)).toBeNull();
  });

  it("issues a session only on a valid code; wrong code gets nothing", async () => {
    const secret = generateTotpSecret();
    const enabled = adminRow({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: encryptTotpSecret(secret),
      twoFactorBackupCodeHashes: [],
    });
    mockPrisma.admin.findUnique.mockResolvedValue(enabled);
    mockPrisma.admin.update.mockResolvedValue({});
    const { POST } = await import("@/app/api/auth/two-factor/verify/route");

    const bad = await POST(
      createRequest("/api/auth/two-factor/verify", {
        method: "POST",
        body: { code: "000000" },
        cookies: { "rbai-twofa": await pendingTokenFor() },
      })
    );
    expect(bad.status).toBe(401);

    const good = await POST(
      createRequest("/api/auth/two-factor/verify", {
        method: "POST",
        body: { code: totpCode(secret) },
        cookies: { "rbai-twofa": await pendingTokenFor() },
      })
    );
    const data = await parseJsonResponse(good);
    expect(good.status).toBe(200);
    expect(data.success).toBe(true);
    const setCookie = good.headers.get("set-cookie") || "";
    expect(setCookie).toContain("rbai-token=");
  });

  it("a backup code works once and is then consumed", async () => {
    const secret = generateTotpSecret();
    const backup = "1234-5678";
    const enabled = adminRow({
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: encryptTotpSecret(secret),
      twoFactorBackupCodeHashes: [hashBackupCode(backup)],
    });
    mockPrisma.admin.findUnique.mockResolvedValue(enabled);
    mockPrisma.admin.update.mockResolvedValue({});
    const { POST } = await import("@/app/api/auth/two-factor/verify/route");

    const first = await POST(
      createRequest("/api/auth/two-factor/verify", {
        method: "POST",
        body: { code: backup },
        cookies: { "rbai-twofa": await pendingTokenFor() },
      })
    );
    expect(first.status).toBe(200);
    // The spent hash is removed in the update.
    const written = mockPrisma.admin.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written.twoFactorBackupCodeHashes).toEqual([]);
  });

  it("no pending cookie means no session, whatever the code", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(adminRow({ twoFactorEnabled: true }));
    const { POST } = await import("@/app/api/auth/two-factor/verify/route");
    const response = await POST(
      createRequest("/api/auth/two-factor/verify", { method: "POST", body: { code: "123456" } })
    );
    expect(response.status).toBe(401);
    expect(mockPrisma.admin.findUnique).not.toHaveBeenCalled();
  });

  it("a pending token for a now-disabled account issues nothing", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(adminRow({ twoFactorEnabled: false }));
    const { POST } = await import("@/app/api/auth/two-factor/verify/route");
    const response = await POST(
      createRequest("/api/auth/two-factor/verify", {
        method: "POST",
        body: { code: "123456" },
        cookies: { "rbai-twofa": await pendingTokenFor() },
      })
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/auth/two-factor/disable", () => {
  it("requires a valid code; a wrong code disables nothing", async () => {
    const secret = generateTotpSecret();
    mockPrisma.admin.findUnique.mockResolvedValue(
      adminRow({
        twoFactorEnabled: true,
        twoFactorSecretEncrypted: encryptTotpSecret(secret),
        twoFactorBackupCodeHashes: [],
      })
    );
    const { POST } = await import("@/app/api/auth/two-factor/disable/route");
    const response = await POST(
      createRequest("/api/auth/two-factor/disable", { method: "POST", body: { code: "000000" } })
    );
    expect(response.status).toBe(401);
    expect(mockPrisma.admin.update).not.toHaveBeenCalled();
  });

  it("a valid code wipes all 2FA material", async () => {
    const secret = generateTotpSecret();
    mockPrisma.admin.findUnique.mockResolvedValue(
      adminRow({
        twoFactorEnabled: true,
        twoFactorSecretEncrypted: encryptTotpSecret(secret),
        twoFactorBackupCodeHashes: ["somehash"],
      })
    );
    mockPrisma.admin.update.mockResolvedValue({});
    const { POST } = await import("@/app/api/auth/two-factor/disable/route");
    const response = await POST(
      createRequest("/api/auth/two-factor/disable", {
        method: "POST",
        body: { code: totpCode(secret) },
      })
    );
    expect(response.status).toBe(200);
    const written = mockPrisma.admin.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written.twoFactorEnabled).toBe(false);
    expect(written.twoFactorSecretEncrypted).toBeNull();
    expect(written.twoFactorBackupCodeHashes).toEqual([]);
  });
});
