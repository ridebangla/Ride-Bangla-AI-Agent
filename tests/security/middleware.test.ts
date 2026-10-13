import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { _getStoreForTesting } from "@/lib/rate-limit";

// Mock rate-limit module with real implementation
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  return importOriginal();
});

describe("Middleware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _getStoreForTesting().clear();
  });

  function createMiddlewareRequest(
    path: string,
    options: { cookies?: Record<string, string>; headers?: Record<string, string> } = {}
  ): NextRequest {
    const url = new URL(path, "http://localhost:3000");
    const request = new NextRequest(url, {
      headers: options.headers || {},
    });
    if (options.cookies) {
      for (const [name, value] of Object.entries(options.cookies)) {
        request.cookies.set(name, value);
      }
    }
    return request;
  }

  describe("Public paths", () => {
    it("should allow /login without token", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/login");
      const response = await middleware(request);

      expect(response.status).not.toBe(401);
      expect(response.headers.get("Location")).toBeNull();
    });

    it("should allow /setup without token", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/setup");
      const response = await middleware(request);

      expect(response.status).not.toBe(401);
    });

    it("should allow /api/auth without token", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/auth");
      const response = await middleware(request);

      expect(response.status).not.toBe(401);
    });

    it("should allow /api/health without token", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/health");
      const response = await middleware(request);

      expect(response.status).not.toBe(401);
    });

    it("should require auth for /api/openapi.json (M-59)", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/openapi.json");
      const response = await middleware(request);

      expect(response.status).toBe(401);
    });

    it("should allow Twilio webhook paths without token", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/channels/phone/incoming");
      const response = await middleware(request);

      expect(response.status).not.toBe(401);
    });
  });

  describe("Protected paths", () => {
    it("should return 401 for API routes without token", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/conversations");
      const response = await middleware(request);

      expect(response.status).toBe(401);
    });

    it("should redirect pages to /login without token", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/conversations");
      const response = await middleware(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("/login");
    });

    it("should allow access with a correctly signed JWT", async () => {
      const jwt = await import("jsonwebtoken");
      const { middleware } = await import("@/middleware");
      // Signed with the real test secret from tests/setup.ts.
      const realToken = jwt.sign(
        { userId: "user-1", role: "admin" },
        process.env.JWT_SECRET as string,
        { expiresIn: "1h" }
      );
      const request = createMiddlewareRequest("/api/conversations", {
        cookies: { "owly-token": realToken },
      });
      const response = await middleware(request);

      expect(response.status).not.toBe(401);
    });

    it("should reject a forged JWT with valid shape but bad signature (C-07)", async () => {
      const { middleware } = await import("@/middleware");
      // Proper 3-part JWT structure, but the signature is fake.
      const fakeToken = "eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.signature";
      const request = createMiddlewareRequest("/api/conversations", {
        cookies: { "owly-token": fakeToken },
      });
      const response = await middleware(request);

      expect(response.status).toBe(401);
    });

    it("should reject a JWT signed with the wrong secret", async () => {
      const jwt = await import("jsonwebtoken");
      const { middleware } = await import("@/middleware");
      const forged = jwt.sign(
        { userId: "hacker", role: "admin" },
        "wrong-secret",
        { expiresIn: "1h" }
      );
      const request = createMiddlewareRequest("/api/conversations", {
        cookies: { "owly-token": forged },
      });
      const response = await middleware(request);

      expect(response.status).toBe(401);
    });

    it("should reject malformed token (not 3 parts)", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/conversations", {
        cookies: { "owly-token": "not-a-jwt" },
      });
      const response = await middleware(request);

      expect(response.status).toBe(401);
    });
  });

  describe("Security headers", () => {
    it("should include X-Content-Type-Options header", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/health");
      const response = await middleware(request);

      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("should include X-Frame-Options header", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/health");
      const response = await middleware(request);

      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("should include X-XSS-Protection header", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/health");
      const response = await middleware(request);

      expect(response.headers.get("X-XSS-Protection")).toBe("1; mode=block");
    });

    it("should include Referrer-Policy header", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/health");
      const response = await middleware(request);

      expect(response.headers.get("Referrer-Policy")).toBe(
        "strict-origin-when-cross-origin"
      );
    });

    it("should include Permissions-Policy header", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/api/health");
      const response = await middleware(request);

      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    });
  });

  describe("Rate limiting", () => {
    it("should allow requests within auth rate limit", async () => {
      const { middleware } = await import("@/middleware");

      for (let i = 0; i < 5; i++) {
        const request = createMiddlewareRequest("/api/auth", {
          headers: { "x-forwarded-for": "1.2.3.4" },
        });
        const response = await middleware(request);
        expect(response.status).not.toBe(429);
      }
    });

    it("should block after exceeding auth rate limit", async () => {
      const { middleware } = await import("@/middleware");

      // Exhaust the rate limit
      for (let i = 0; i < 5; i++) {
        const request = createMiddlewareRequest("/api/auth", {
          headers: { "x-forwarded-for": "10.0.0.1" },
        });
        await middleware(request);
      }

      // 6th request should be blocked
      const request = createMiddlewareRequest("/api/auth", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      const response = await middleware(request);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBeDefined();
    });

    it("should track different IPs independently", async () => {
      const { middleware } = await import("@/middleware");

      // Exhaust rate limit for IP A
      for (let i = 0; i < 6; i++) {
        const request = createMiddlewareRequest("/api/auth", {
          headers: { "x-forwarded-for": "192.168.1.1" },
        });
        await middleware(request);
      }

      // IP B should still be allowed
      const request = createMiddlewareRequest("/api/auth", {
        headers: { "x-forwarded-for": "192.168.1.2" },
      });
      const response = await middleware(request);

      expect(response.status).not.toBe(429);
    });
  });

  describe("Static files", () => {
    it("should pass through _next paths", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/_next/static/chunk.js");
      const response = await middleware(request);

      expect(response.status).toBe(200);
    });

    it("should pass through .png files", async () => {
      const { middleware } = await import("@/middleware");
      const request = createMiddlewareRequest("/logo.png");
      const response = await middleware(request);

      expect(response.status).toBe(200);
    });
  });
});
