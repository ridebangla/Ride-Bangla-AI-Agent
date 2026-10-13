import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { prisma } from "@/lib/prisma";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

describe("Auth hygiene (M-53)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues access tokens that expire in 1 hour, not 7 days", async () => {
    const { generateToken } = await import("@/lib/auth");
    const token = generateToken("user-1", "admin");
    const decoded = jwt.decode(token) as { iat: number; exp: number; type: string };
    expect(decoded.type).toBe("access");
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  it("issues refresh tokens with type=refresh and 7-day expiry", async () => {
    const { generateRefreshToken } = await import("@/lib/auth");
    const token = generateRefreshToken("user-1", "admin");
    const decoded = jwt.decode(token) as { iat: number; exp: number; type: string };
    expect(decoded.type).toBe("refresh");
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 3600);
  });

  it("verifySessionToken rejects refresh tokens", async () => {
    const { generateRefreshToken, verifySessionToken } = await import("@/lib/auth");
    const refresh = generateRefreshToken("user-1", "admin");
    await expect(verifySessionToken(refresh)).resolves.toBeNull();
  });

  it("verifyRefreshToken rejects access tokens", async () => {
    const { generateToken, verifyRefreshToken } = await import("@/lib/auth");
    const access = generateToken("user-1", "admin");
    await expect(verifyRefreshToken(access)).resolves.toBeNull();
  });

  it("verifySessionToken rejects revoked access tokens", async () => {
    const { generateToken, verifySessionToken } = await import("@/lib/auth");
    const token = generateToken("user-1", "admin");
    const { jti } = jwt.decode(token) as { jti: string };
    mockPrisma.revokedToken.findUnique.mockResolvedValue({ jti });
    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it("verifySessionToken accepts a valid, non-revoked access token", async () => {
    const { generateToken, verifySessionToken } = await import("@/lib/auth");
    const token = generateToken("user-1", "admin");
    mockPrisma.revokedToken.findUnique.mockResolvedValue(null);
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe("user-1");
  });

  it("revokeToken records the jti (logout)", async () => {
    const { revokeToken } = await import("@/lib/auth");
    mockPrisma.revokedToken.upsert.mockResolvedValue({});
    await revokeToken("jti-123", new Date(Date.now() + 3600_000));
    expect(mockPrisma.revokedToken.upsert).toHaveBeenCalledWith({
      where: { jti: "jti-123" },
      update: {},
      create: expect.objectContaining({ jti: "jti-123" }),
    });
  });

  it("setup is disabled unless ALLOW_SETUP=true", async () => {
    const { isSetupAllowed } = await import("@/lib/auth");
    delete process.env.ALLOW_SETUP;
    expect(isSetupAllowed()).toBe(false);
    process.env.ALLOW_SETUP = "true";
    expect(isSetupAllowed()).toBe(true);
    delete process.env.ALLOW_SETUP;
  });
});
