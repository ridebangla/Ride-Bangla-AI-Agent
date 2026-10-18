import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { fixtures } from "../helpers/fixtures";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

// Mock auth functions
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    isSetupComplete: vi.fn(),
  };
});

describe("POST /api/auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("login action", () => {
    it("should login with valid credentials", async () => {
      const { hashPassword } = await import("@/lib/auth");
      const hashedPassword = await hashPassword("admin123");

      mockPrisma.admin.findUnique.mockResolvedValue({
        ...fixtures.admin,
        password: hashedPassword,
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "admin", password: "admin123" },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.user.username).toBe("admin");
    });

    it("should reject invalid password", async () => {
      const { hashPassword } = await import("@/lib/auth");
      const hashedPassword = await hashPassword("correctpass");

      mockPrisma.admin.findUnique.mockResolvedValue({
        ...fixtures.admin,
        password: hashedPassword,
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "admin", password: "wrongpass" },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should reject nonexistent user", async () => {
      mockPrisma.admin.findUnique.mockResolvedValue(null);

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "noone", password: "pass" },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should reject missing credentials", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "", password: "" },
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe("setup action", () => {
    it("should reject setup when ALLOW_SETUP is not enabled (M-53)", async () => {
      delete process.env.ALLOW_SETUP;
      const { isSetupComplete } = await import("@/lib/auth");
      (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "setup", username: "newadmin", password: "pass123" },
      });

      const response = await POST(request);
      expect(response.status).toBe(403);
      expect(mockPrisma.admin.create).not.toHaveBeenCalled();
    });

    it("should create first admin", async () => {
      process.env.ALLOW_SETUP = "true";
      try {
        const { isSetupComplete } = await import("@/lib/auth");
        (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      mockPrisma.business.create.mockResolvedValue({
        id: "biz-1",
        name: "My Business",
        slug: "my-business-abc123",
        siteKey: "rbsite-test",
      });
      mockPrisma.admin.create.mockResolvedValue({
        id: "new-admin",
        username: "newadmin",
        name: "New Admin",
        role: "super_admin",
      });
      mockPrisma.settings.upsert.mockResolvedValue({});
      mockPrisma.channel.upsert.mockResolvedValue({});

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: {
          action: "setup",
          username: "newadmin",
          password: "secure123",
          name: "New Admin",
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      } finally {
        delete process.env.ALLOW_SETUP;
      }
    });

    it("should reject setup when already completed", async () => {
      process.env.ALLOW_SETUP = "true";
      try {
      const { isSetupComplete } = await import("@/lib/auth");
      (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "setup", username: "admin", password: "pass123" },
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
      } finally {
        delete process.env.ALLOW_SETUP;
      }
    });
  });

  describe("logout action", () => {
    it("should clear auth cookie", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "logout" },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe("invalid action", () => {
    it("should reject unknown action", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "invalid" },
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe("lockout (M-53)", () => {
    it("should return 429 for a locked account", async () => {
      mockPrisma.admin.findUnique.mockResolvedValue({
        ...fixtures.admin,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60_000),
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "admin", password: "admin123" },
      });

      const response = await POST(request);
      expect(response.status).toBe(429);
    });

    it("should lock the account on the 5th failed login", async () => {
      const { hashPassword } = await import("@/lib/auth");
      const hashedPassword = await hashPassword("correctpass");

      mockPrisma.admin.findUnique.mockResolvedValue({
        ...fixtures.admin,
        password: hashedPassword,
        failedLoginAttempts: 4,
        lockedUntil: null,
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "admin", password: "wrongpass" },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
      const updateArg = mockPrisma.admin.update.mock.calls.at(-1)[0];
      expect(updateArg.data.failedLoginAttempts).toBe(0);
      expect(updateArg.data.lockedUntil instanceof Date).toBe(true);
      expect(updateArg.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it("should reset failures after a successful login", async () => {
      const { hashPassword } = await import("@/lib/auth");
      const hashedPassword = await hashPassword("admin123");

      mockPrisma.admin.findUnique.mockResolvedValue({
        ...fixtures.admin,
        password: hashedPassword,
        failedLoginAttempts: 3,
        lockedUntil: null,
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "admin", password: "admin123" },
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      const updateArg = mockPrisma.admin.update.mock.calls.at(-1)[0];
      expect(updateArg.data).toEqual({
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    });
  });

  describe("CAPTCHA (M-53)", () => {
    it("should reject login when CAPTCHA is configured but fails", async () => {
      process.env.HCAPTCHA_SECRET_KEY = "test-secret";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: false }) })
      );
      try {
        mockPrisma.admin.findUnique.mockResolvedValue({
          ...fixtures.admin,
          failedLoginAttempts: 0,
          lockedUntil: null,
        });

        const { POST } = await import("@/app/api/auth/route");
        const request = createRequest("/api/auth", {
          method: "POST",
          body: {
            action: "login",
            username: "admin",
            password: "admin123",
            captchaToken: "bad-token",
          },
        });

        const response = await POST(request);
        expect(response.status).toBe(403);
      } finally {
        delete process.env.HCAPTCHA_SECRET_KEY;
        vi.unstubAllGlobals();
      }
    });

    it("should reject login when CAPTCHA is configured but no token is sent", async () => {
      process.env.HCAPTCHA_SECRET_KEY = "test-secret";
      try {
        mockPrisma.admin.findUnique.mockResolvedValue({
          ...fixtures.admin,
          failedLoginAttempts: 0,
          lockedUntil: null,
        });

        const { POST } = await import("@/app/api/auth/route");
        const request = createRequest("/api/auth", {
          method: "POST",
          body: { action: "login", username: "admin", password: "admin123" },
        });

        const response = await POST(request);
        expect(response.status).toBe(403);
      } finally {
        delete process.env.HCAPTCHA_SECRET_KEY;
      }
    });

    it("should allow login when CAPTCHA verifies", async () => {
      process.env.HCAPTCHA_SECRET_KEY = "test-secret";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true }) })
      );
      try {
        const { hashPassword } = await import("@/lib/auth");
        const hashedPassword = await hashPassword("admin123");
        mockPrisma.admin.findUnique.mockResolvedValue({
          ...fixtures.admin,
          password: hashedPassword,
          failedLoginAttempts: 0,
          lockedUntil: null,
        });

        const { POST } = await import("@/app/api/auth/route");
        const request = createRequest("/api/auth", {
          method: "POST",
          body: {
            action: "login",
            username: "admin",
            password: "admin123",
            captchaToken: "good-token",
          },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);
      } finally {
        delete process.env.HCAPTCHA_SECRET_KEY;
        vi.unstubAllGlobals();
      }
    });
  });

  describe("refresh (M-53)", () => {
    it("should exchange a valid refresh token for a new access token and rotate", async () => {
      const { generateRefreshToken } = await import("@/lib/auth");
      const refreshToken = generateRefreshToken("admin-1", "admin");

      mockPrisma.revokedToken.findUnique.mockResolvedValue(null);
      mockPrisma.revokedToken.upsert.mockResolvedValue({});
      mockPrisma.admin.findUnique.mockResolvedValue({
        id: "admin-1",
        username: "admin",
        name: "Admin",
        role: "admin",
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "refresh" },
        cookies: { "rbai-refresh": refreshToken },
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      // Old refresh token revoked (rotation).
      expect(mockPrisma.revokedToken.upsert).toHaveBeenCalled();
      // New cookies issued.
      const setCookie = response.headers.getSetCookie();
      expect(setCookie.some((c) => c.startsWith("rbai-token="))).toBe(true);
      expect(setCookie.some((c) => c.startsWith("rbai-refresh="))).toBe(true);
    });

    it("should reject a refresh attempt with an access token", async () => {
      const { generateToken } = await import("@/lib/auth");
      const accessToken = generateToken("admin-1", "admin");
      mockPrisma.revokedToken.findUnique.mockResolvedValue(null);

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "refresh" },
        cookies: { "rbai-refresh": accessToken },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should reject a refresh attempt with no cookie", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "refresh" },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should revoke tokens on logout", async () => {
      const { generateToken, generateRefreshToken } = await import("@/lib/auth");
      const accessToken = generateToken("admin-1", "admin");
      const refreshToken = generateRefreshToken("admin-1", "admin");
      mockPrisma.revokedToken.upsert.mockResolvedValue({});
      const callsBefore = mockPrisma.revokedToken.upsert.mock.calls.length;

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "logout" },
        cookies: { "rbai-token": accessToken, "rbai-refresh": refreshToken },
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockPrisma.revokedToken.upsert.mock.calls.length).toBe(
        callsBefore + 2
      );
    });
  });
});

describe("GET /api/auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return setupRequired when no admin exists", async () => {
    const { isSetupComplete, getCurrentUser } = await import("@/lib/auth");
    (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/auth/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.authenticated).toBe(false);
    expect(data.setupRequired).toBe(true);
  });

  it("should return authenticated user", async () => {
    const { isSetupComplete, getCurrentUser } = await import("@/lib/auth");
    (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "admin-1",
      username: "admin",
      name: "Admin",
      role: "admin",
    });

    const { GET } = await import("@/app/api/auth/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.authenticated).toBe(true);
    expect(data.user.username).toBe("admin");
  });
});
