/**
 * Session persistence (login-once fix, 2026-10-21).
 *
 * The defect: the 1h access cookie gated every page load, the 30d
 * refresh cookie was scoped to Path=/api/auth, and NOTHING ever called
 * the refresh exchange — so every session died after 1 hour and the user
 * had to sign in again on every visit.
 *
 * The fix under test:
 *  - refresh cookie now Path=/ (presence visible to middleware);
 *  - middleware bounces an expired-access PAGE load carrying a refresh
 *    cookie to /api/auth/restore instead of /login (API calls keep 401);
 *  - /api/auth/restore performs the DB-checked rotating exchange and
 *    redirects back; failures clear cookies and land on /login;
 *  - login/refresh responses also expire the legacy Path=/api/auth
 *    refresh cookie so it can never shadow the new one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import { prisma } from "@/lib/prisma";
import { _getStoreForTesting } from "@/lib/rate-limit";
import {
  clearRefreshCookie,
  generateRefreshToken,
  generateToken,
  setRefreshCookie,
  setSessionCookies,
} from "@/lib/auth";

const SECRET = process.env.JWT_SECRET as string;

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

function pageRequest(
  path: string,
  cookies: Record<string, string> = {}
): NextRequest {
  const request = new NextRequest(new URL(path, "http://localhost:3000"));
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

function expiredAccessToken(): string {
  return jwt.sign(
    {
      userId: "admin-1",
      role: "admin",
      jti: "expired-jti",
      type: "access",
      exp: Math.floor(Date.now() / 1000) - 3600,
    },
    SECRET
  );
}

function setCookiesOf(response: { headers: Headers }): string[] {
  const h = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  return typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
}

describe("refresh cookie shape", () => {
  it("is Path=/ with a 30-day Max-Age so middleware can see its presence", () => {
    const c = setRefreshCookie("tok");
    expect(c.name).toBe("rbai-refresh");
    expect(c.path).toBe("/");
    expect(c.maxAge).toBe(60 * 60 * 24 * 30);
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("lax");
  });

  it("clearRefreshCookie targets the same Path=/ identity", () => {
    const c = clearRefreshCookie();
    expect(c.path).toBe("/");
    expect(c.maxAge).toBe(0);
  });

  it("setSessionCookies writes exactly the access + refresh pair", () => {
    const set = vi.fn();
    const fake = { cookies: { set } } as never;
    setSessionCookies(fake, "access-tok", "refresh-tok");
    const written = set.mock.calls.map(
      (call) => call[0] as { name: string; path: string; value: string }
    );
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ name: "rbai-token", value: "access-tok" });
    expect(written[1]).toMatchObject({
      name: "rbai-refresh",
      value: "refresh-tok",
      path: "/",
    });
  });

  it("middleware expires the legacy Path=/api/auth refresh cookie on auth responses", async () => {
    const { middleware } = await import("@/middleware");
    const response = await middleware(pageRequest("/api/auth"));
    const cookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    expect(
      cookies.some(
        (c) =>
          c.startsWith("rbai-refresh=") &&
          c.includes("Path=/api/auth") &&
          c.includes("Max-Age=0")
      )
    ).toBe(true);
  });
});

describe("middleware restore bounce", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _getStoreForTesting().clear();
  });

  it("bounces a page load with only a refresh cookie to /api/auth/restore", async () => {
    const { middleware } = await import("@/middleware");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await middleware(
      pageRequest("/dashboard", { "rbai-refresh": refresh })
    );
    expect(response.status).toBe(307);
    const location = response.headers.get("Location") || "";
    expect(location).toContain("/api/auth/restore");
    expect(location).toContain("next=%2Fdashboard");
  });

  it("bounces an expired-access page load that carries a refresh cookie", async () => {
    const { middleware } = await import("@/middleware");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await middleware(
      pageRequest("/billing", {
        "rbai-token": expiredAccessToken(),
        "rbai-refresh": refresh,
      })
    );
    expect(response.status).toBe(307);
    const location = response.headers.get("Location") || "";
    expect(location).toContain("/api/auth/restore");
    expect(location).toContain("next=%2Fbilling");
  });

  it("still sends an expired-access page load WITHOUT a refresh cookie to /login", async () => {
    const { middleware } = await import("@/middleware");
    const response = await middleware(
      pageRequest("/dashboard", { "rbai-token": expiredAccessToken() })
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain("/login");
  });

  it("does NOT bounce API requests — they keep the 401 contract", async () => {
    const { middleware } = await import("@/middleware");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await middleware(
      pageRequest("/api/conversations", { "rbai-refresh": refresh })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("lets a valid access token straight through (no bounce)", async () => {
    const { middleware } = await import("@/middleware");
    const access = generateToken("admin-1", "admin");
    const response = await middleware(
      pageRequest("/dashboard", { "rbai-token": access })
    );
    expect(response.headers.get("Location")).toBeNull();
  });
});

describe("GET /api/auth/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _getStoreForTesting().clear();
    // Default DB state: nothing revoked, admin exists.
    mockPrisma.revokedToken.findUnique.mockResolvedValue(null);
    mockPrisma.revokedToken.upsert.mockResolvedValue({});
    mockPrisma.admin.findUnique.mockResolvedValue({
      id: "admin-1",
      role: "admin",
    });
  });

  it("exchanges a valid refresh cookie for a fresh pair and redirects to next", async () => {
    const { GET } = await import("@/app/api/auth/restore/route");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await GET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain("/dashboard");

    const cookies = setCookiesOf(response);
    const refreshCookies = cookies.filter((c) => c.startsWith("rbai-refresh="));
    // Exactly ONE refresh cookie: the fresh token at Path=/ (the legacy
    // Path=/api/auth expiry is middleware's job, not this response's —
    // Next can only carry one cookie per name per response).
    expect(refreshCookies).toHaveLength(1);
    expect(refreshCookies[0]).toContain("Path=/");
    expect(refreshCookies[0]).not.toContain("Max-Age=0");
    expect(refreshCookies[0].length).toBeGreaterThan(40);
    expect(cookies.some((c) => c.startsWith("rbai-token="))).toBe(true);

    // Rotation: the presented refresh jti was revoked.
    expect(mockPrisma.revokedToken.upsert).toHaveBeenCalled();
  });

  it("redirects to /login and clears cookies when there is no refresh cookie", async () => {
    const { GET } = await import("@/app/api/auth/restore/route");
    const response = await GET(pageRequest("/api/auth/restore?next=/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain("/login");
    const cookies = setCookiesOf(response);
    expect(
      cookies.some(
        (c) => c.startsWith("rbai-token=") && c.includes("Max-Age=0")
      )
    ).toBe(true);
  });

  it("rejects a REVOKED refresh token (logout stays final)", async () => {
    mockPrisma.revokedToken.findUnique.mockResolvedValue({ jti: "x" });
    const { GET } = await import("@/app/api/auth/restore/route");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await GET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    expect(response.headers.get("Location")).toContain("/login");
    expect(mockPrisma.revokedToken.upsert).not.toHaveBeenCalled();
  });

  it("rejects a forged refresh token (wrong secret)", async () => {
    const { GET } = await import("@/app/api/auth/restore/route");
    const forged = jwt.sign(
      { userId: "admin-1", role: "admin", jti: "f", type: "refresh" },
      "some-other-secret",
      { expiresIn: "30d" }
    );
    const response = await GET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": forged,
      })
    );
    expect(response.headers.get("Location")).toContain("/login");
  });

  it("rejects an access token presented as a refresh token (type check)", async () => {
    const { GET } = await import("@/app/api/auth/restore/route");
    const access = generateToken("admin-1", "admin");
    const response = await GET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": access,
      })
    );
    expect(response.headers.get("Location")).toContain("/login");
  });

  it("passes straight through when the access cookie is still valid (no rotation)", async () => {
    const { GET } = await import("@/app/api/auth/restore/route");
    const access = generateToken("admin-1", "admin");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await GET(
      pageRequest("/api/auth/restore?next=/settings", {
        "rbai-token": access,
        "rbai-refresh": refresh,
      })
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain("/settings");
    expect(setCookiesOf(response)).toHaveLength(0);
    expect(mockPrisma.revokedToken.upsert).not.toHaveBeenCalled();
  });

  it("blocks open redirects: an absolute-URL next falls back to /dashboard", async () => {
    const { GET } = await import("@/app/api/auth/restore/route");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await GET(
      pageRequest("/api/auth/restore?next=https://evil.example/phish", {
        "rbai-refresh": refresh,
      })
    );
    const location = response.headers.get("Location") || "";
    expect(location).toContain("/dashboard");
    expect(location).not.toContain("evil.example");
  });

  it("fails closed to /login when the admin no longer exists", async () => {
    mockPrisma.admin.findUnique.mockResolvedValue(null);
    const { GET } = await import("@/app/api/auth/restore/route");
    const refresh = generateRefreshToken("admin-1", "admin");
    const response = await GET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    expect(response.headers.get("Location")).toContain("/login");
  });
});
