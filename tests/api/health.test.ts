import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { parseJsonResponse } from "../helpers/request";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: vi.fn(),
  };
});

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>> | ReturnType<typeof vi.fn>>;

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Mock settings for OpenAI check
    (mockPrisma.settings as Record<string, ReturnType<typeof vi.fn>>).findFirst.mockResolvedValue({ aiApiKey: "" });
  });

  async function mockUser(user: { role: string } | null) {
    const { getCurrentUser } = await import("@/lib/auth");
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue(user);
  }

  it("should return ok status when database is connected (admin sees details)", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    await mockUser({ role: "super_admin" });

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.services.database).toBe("connected");
    expect(data.uptime).toBeDefined();
    expect(data.memory).toBeDefined();
    expect(data.environment).toBeDefined();
  });

  it("should return degraded status when database is down (admin sees details)", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"));
    await mockUser({ role: "super_admin" });

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    expect(data.services.database).toBe("error");
  });

  it("should report openai as not_configured when no API key (admin)", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    (mockPrisma.settings as Record<string, ReturnType<typeof vi.fn>>).findFirst.mockResolvedValue({ aiApiKey: "" });
    await mockUser({ role: "super_admin" });

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.services.openai).toBe("not_configured");
  });

  it("should return ONLY status to unauthenticated callers (M-59)", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    await mockUser(null);

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.services).toBeUndefined();
    expect(data.uptime).toBeUndefined();
    expect(data.memory).toBeUndefined();
    expect(data.environment).toBeUndefined();
    expect(data.version).toBeUndefined();
  });

  it("should return ONLY status to non-admin roles (M-59)", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    await mockUser({ role: "viewer" });

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.status).toBe("ok");
    expect(data.services).toBeUndefined();
    expect(data.environment).toBeUndefined();
  });
});
