import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

describe("Auth Security", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("JWT Token Security", () => {
    it("should reject token signed with different secret", async () => {
      const { verifyToken } = await import("@/lib/auth");

      const forgedToken = jwt.sign(
        { userId: "admin-1", role: "admin" },
        "attacker-secret-key",
        { expiresIn: "7d" }
      );

      expect(verifyToken(forgedToken)).toBeNull();
    });

    it("should reject expired tokens", async () => {
      const { verifyToken } = await import("@/lib/auth");

      const expiredToken = jwt.sign(
        { userId: "admin-1", role: "admin" },
        "test-secret-key-for-testing-only",
        { expiresIn: "-1s" }
      );

      expect(verifyToken(expiredToken)).toBeNull();
    });

    it("should reject token with tampered payload", async () => {
      const { generateToken, verifyToken } = await import("@/lib/auth");

      const token = generateToken("user-1", "viewer");
      // Tamper with the payload by modifying the middle part
      const parts = token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      payload.role = "admin"; // escalation attempt
      parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const tamperedToken = parts.join(".");

      expect(verifyToken(tamperedToken)).toBeNull();
    });

    it("should reject completely empty token", async () => {
      const { verifyToken } = await import("@/lib/auth");
      expect(verifyToken("")).toBeNull();
    });

    it("should reject random base64 strings", async () => {
      const { verifyToken } = await import("@/lib/auth");
      expect(verifyToken("dGVzdA==.dGVzdA==.dGVzdA==")).toBeNull();
    });

    it("should include userId and role in token payload", async () => {
      const { generateToken, verifyToken } = await import("@/lib/auth");

      const token = generateToken("user-abc", "editor");
      const payload = verifyToken(token);

      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe("user-abc");
      expect(payload!.role).toBe("editor");
    });
  });

  describe("Password Security", () => {
    it("should use bcrypt with sufficient work factor", async () => {
      const { hashPassword } = await import("@/lib/auth");

      const hash = await hashPassword("testpass");
      // bcrypt hash format: $2a$12$... (12 is the cost factor)
      expect(hash).toMatch(/^\$2[aby]\$12\$/);
    });

    it("should produce different hashes for same input (salt)", async () => {
      const { hashPassword } = await import("@/lib/auth");

      const hash1 = await hashPassword("samepass");
      const hash2 = await hashPassword("samepass");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Cookie Security", () => {
    it("should set httpOnly flag to prevent JS access", async () => {
      const { setAuthCookie } = await import("@/lib/auth");
      const cookie = setAuthCookie("token-value");
      expect(cookie.httpOnly).toBe(true);
    });

    it("should set sameSite to lax", async () => {
      const { setAuthCookie } = await import("@/lib/auth");
      const cookie = setAuthCookie("token-value");
      expect(cookie.sameSite).toBe("lax");
    });

    it("should set path to root", async () => {
      const { setAuthCookie } = await import("@/lib/auth");
      const cookie = setAuthCookie("token-value");
      expect(cookie.path).toBe("/");
    });

    it("should set reasonable max age", async () => {
      const { setAuthCookie } = await import("@/lib/auth");
      const cookie = setAuthCookie("token-value");
      // M-53: access-token cookie is 1 hour = 3600 seconds (was 7 days).
      expect(cookie.maxAge).toBe(3600);
    });
  });
});
