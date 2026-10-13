import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const TEST_SECRET = "test-secret-key-for-testing-only";

// We test the auth module functions directly
// The module is loaded with JWT_SECRET already set from setup.ts

describe("Auth Module", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("hashPassword / verifyPassword", () => {
    it("should hash a password and verify it correctly", async () => {
      const { hashPassword, verifyPassword } = await import("@/lib/auth");

      const password = "securePassword123";
      const hash = await hashPassword(password);

      expect(hash).not.toBe(password);
      expect(hash).toMatch(/^\$2[aby]\$/);
      expect(await verifyPassword(password, hash)).toBe(true);
    });

    it("should reject wrong password", async () => {
      const { hashPassword, verifyPassword } = await import("@/lib/auth");

      const hash = await hashPassword("correctPassword");
      expect(await verifyPassword("wrongPassword", hash)).toBe(false);
    });

    it("should produce different hashes for same password (salt)", async () => {
      const { hashPassword } = await import("@/lib/auth");

      const hash1 = await hashPassword("samePassword");
      const hash2 = await hashPassword("samePassword");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("generateToken / verifyToken", () => {
    it("should generate a valid JWT token", async () => {
      const { generateToken } = await import("@/lib/auth");

      const token = generateToken("user-123", "admin");
      const decoded = jwt.verify(token, TEST_SECRET) as {
        userId: string;
        role: string;
      };

      expect(decoded.userId).toBe("user-123");
      expect(decoded.role).toBe("admin");
    });

    it("should verify a valid token and return payload", async () => {
      const { generateToken, verifyToken } = await import("@/lib/auth");

      const token = generateToken("user-456", "editor");
      const payload = verifyToken(token);

      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe("user-456");
      expect(payload!.role).toBe("editor");
    });

    it("should return null for invalid token", async () => {
      const { verifyToken } = await import("@/lib/auth");

      expect(verifyToken("invalid.token.here")).toBeNull();
      expect(verifyToken("")).toBeNull();
      expect(verifyToken("random-string")).toBeNull();
    });

    it("should return null for token signed with wrong secret", async () => {
      const { verifyToken } = await import("@/lib/auth");

      const forgedToken = jwt.sign(
        { userId: "hacker", role: "admin" },
        "wrong-secret",
        { expiresIn: "7d" }
      );

      expect(verifyToken(forgedToken)).toBeNull();
    });

    it("should return null for expired token", async () => {
      const { verifyToken } = await import("@/lib/auth");

      const expiredToken = jwt.sign(
        { userId: "user-1", role: "admin" },
        TEST_SECRET,
        { expiresIn: "0s" }
      );

      // Small delay to ensure expiration
      await new Promise((r) => setTimeout(r, 10));
      expect(verifyToken(expiredToken)).toBeNull();
    });
  });

  describe("setAuthCookie", () => {
    it("should return correct cookie properties", async () => {
      const { setAuthCookie } = await import("@/lib/auth");

      const cookie = setAuthCookie("test-token-value");

      expect(cookie.name).toBe("owly-token");
      expect(cookie.value).toBe("test-token-value");
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("lax");
      // M-53: access-token cookie is 1 hour (was 7 days).
      expect(cookie.maxAge).toBe(60 * 60);
      expect(cookie.path).toBe("/");
    });
  });

  describe("clearAuthCookie", () => {
    it("should return cookie with maxAge 0", async () => {
      const { clearAuthCookie } = await import("@/lib/auth");

      const cookie = clearAuthCookie();

      expect(cookie.name).toBe("owly-token");
      expect(cookie.value).toBe("");
      expect(cookie.maxAge).toBe(0);
    });
  });
});
