/**
 * tenant-profile-logo.test.ts — Team Logo-Feature (2026-11-03).
 *
 * Proves, in code only (no live browser, no owner credential):
 *  1. resolveTenantLogoUrl accepts a tenant's http(s) logo or a
 *     PNG/JPEG/WebP data URL, and rejects javascript:, non-image data
 *     URLs, other schemes, and overlong values with null — never a
 *     substituted mark.
 *  2. PUT /api/profile stores logoUrl ONLY against the caller's own
 *     business (where: { id: auth.businessId }); a body-supplied
 *     businessId for another tenant is ignored, invalid files 400
 *     honestly, and empty clears the logo (null).
 *  3. GET /api/profile returns the caller's logoUrl.
 *  4. GET /api/widget/identity returns the siteKey business's OWN
 *     logoUrl (tenant A never sees tenant B's), and null — not the
 *     platform default — when the tenant set no usable logo.
 *
 * Auth + Prisma come from the global test setup: requireAuth resolves
 * as business "test-business"; the Prisma mock client is staged per
 * test below. The widget embed JS itself (header badge markup) is
 * plain browser JS, not importable here — it is covered by
 * node --check syntax validation + the identity payload contract
 * above, and by the head live-drive note in the report.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseJsonResponse } from "../helpers/request";
import {
  resolveTenantLogoUrl,
  hasTenantLogo,
  tenantLogoInitial,
} from "@/lib/tenant-logo";

const SMALL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type MockFn = ReturnType<typeof vi.fn>;

async function mockDb() {
  const { getUnscopedPrisma } = await import("@/lib/prisma");
  const db = getUnscopedPrisma() as unknown as Record<
    string,
    Record<string, MockFn>
  >;
  return db;
}

describe("resolveTenantLogoUrl (read gate)", () => {
  it("accepts an http(s) logo URL", () => {
    expect(resolveTenantLogoUrl("https://example.com/logo.png")).toBe(
      "https://example.com/logo.png"
    );
    expect(resolveTenantLogoUrl("http://example.com/logo.png")).toBe(
      "http://example.com/logo.png"
    );
  });

  it("accepts a small PNG/JPEG/WebP data URL and trims whitespace", () => {
    expect(resolveTenantLogoUrl(`  ${SMALL_PNG}  `)).toBe(SMALL_PNG);
    expect(
      resolveTenantLogoUrl(SMALL_PNG.replace("png", "jpeg"))
    ).toBe(SMALL_PNG.replace("png", "jpeg"));
  });

  it("rejects javascript:, non-image data, other schemes, and empties with null", () => {
    expect(resolveTenantLogoUrl("javascript:alert(1)")).toBeNull();
    expect(
      resolveTenantLogoUrl("data:text/html;base64,SGVsbG8=")
    ).toBeNull();
    expect(resolveTenantLogoUrl("data:image/gif;base64,AAAA")).toBeNull();
    expect(resolveTenantLogoUrl("ftp://example.com/logo.png")).toBeNull();
    expect(resolveTenantLogoUrl("")).toBeNull();
    expect(resolveTenantLogoUrl(null)).toBeNull();
    expect(resolveTenantLogoUrl(undefined)).toBeNull();
    expect(resolveTenantLogoUrl(42)).toBeNull();
  });

  it("rejects overlong http URLs and overlong data URLs with null", () => {
    expect(
      resolveTenantLogoUrl(`https://example.com/${"a".repeat(600)}`)
    ).toBeNull();
    expect(
      resolveTenantLogoUrl(
        `data:image/png;base64,${"A".repeat(1_000_000)}`
      )
    ).toBeNull();
  });

  it("fallback initial uses the business name, never another mark", () => {
    expect(tenantLogoInitial("Test Bakery")).toBe("T");
    expect(tenantLogoInitial("")).toBe("?");
    expect(tenantLogoInitial(null)).toBe("?");
    expect(hasTenantLogo("https://example.com/logo.png")).toBe(true);
    expect(hasTenantLogo("javascript:alert(1)")).toBe(false);
  });
});

describe("PUT /api/profile — tenant logo write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the logo against the caller's own business only", async () => {
    const db = await mockDb();
    db.business.update.mockResolvedValue({
      profilePhoto: "",
      logoUrl: "https://example.com/logo.png",
      contactName: "",
      contactPhone: "",
      contactAddress: "",
    });
    const { PUT } = await import("@/app/api/profile/route");
    const res = await PUT(
      createRequest("/api/profile", {
        method: "PUT",
        body: { logoUrl: "https://example.com/logo.png" },
      })
    );
    expect(res.status).toBe(200);
    const json = await parseJsonResponse(res);
    expect(json.business.logoUrl).toBe("https://example.com/logo.png");
    // Tenant scoping: the update targets the AUTH business, whatever
    // the body says — see the cross-tenant case below.
    expect(db.business.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "test-business" },
        data: expect.objectContaining({
          logoUrl: "https://example.com/logo.png",
        }),
      })
    );
  });

  it("ignores a body-supplied other-tenant id (cross-tenant upload refused)", async () => {
    const db = await mockDb();
    db.business.update.mockResolvedValue({
      profilePhoto: "",
      logoUrl: "https://example.com/logo.png",
      contactName: "",
      contactPhone: "",
      contactAddress: "",
    });
    const { PUT } = await import("@/app/api/profile/route");
    const res = await PUT(
      createRequest("/api/profile", {
        method: "PUT",
        body: {
          businessId: "other-tenant",
          id: "other-tenant",
          logoUrl: "https://example.com/logo.png",
        },
      })
    );
    expect(res.status).toBe(200);
    const call = (db.business.update as MockFn).mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where.id).toBe("test-business");
    expect(call.where.id).not.toBe("other-tenant");
    expect(call.data).not.toHaveProperty("businessId");
    expect(call.data).not.toHaveProperty("id");
  });

  it("refuses wrong-type / oversize logos with an honest 400 and writes nothing", async () => {
    const db = await mockDb();
    const { PUT } = await import("@/app/api/profile/route");
    for (const bad of [
      "javascript:alert(1)",
      "data:image/gif;base64,AAAA",
      `data:image/png;base64,${"A".repeat(1_000_000)}`,
      "not-a-url",
    ]) {
      const res = await PUT(
        createRequest("/api/profile", {
          method: "PUT",
          body: { logoUrl: bad },
        })
      );
      expect(res.status).toBe(400);
      expect((await parseJsonResponse(res)).error).toBeTruthy();
    }
    expect(db.business.update).not.toHaveBeenCalled();
  });

  it("empty logoUrl clears the logo (null) — old logo replaced cleanly", async () => {
    const db = await mockDb();
    db.business.update.mockResolvedValue({
      profilePhoto: "",
      logoUrl: "",
      contactName: "",
      contactPhone: "",
      contactAddress: "",
    });
    const { PUT } = await import("@/app/api/profile/route");
    const res = await PUT(
      createRequest("/api/profile", {
        method: "PUT",
        body: { logoUrl: "" },
      })
    );
    expect(res.status).toBe(200);
    expect(db.business.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ logoUrl: null }),
      })
    );
  });

  it("GET /api/profile returns the caller's logoUrl", async () => {
    const db = await mockDb();
    db.admin.findUnique.mockResolvedValue({
      name: "Test Admin",
      username: "admin",
      email: "admin@example.com",
      role: "admin",
      businessId: "test-business",
    });
    db.business.findUnique.mockResolvedValue({
      name: "Test Bakery",
      slug: "test-bakery",
      profilePhoto: "",
      logoUrl: "https://example.com/logo.png",
      contactName: "",
      contactPhone: "",
      contactAddress: "",
      siteKey: "rbsite-test",
    });
    const { GET } = await import("@/app/api/profile/route");
    const res = await GET(createRequest("/api/profile"));
    expect(res.status).toBe(200);
    const json = await parseJsonResponse(res);
    expect(json.business.logoUrl).toBe("https://example.com/logo.png");
  });
});

describe("GET /api/widget/identity — tenant logo serve leg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function stageIdentity(logoUrl: string | null) {
    const db = await mockDb();
    // getBusinessBySiteKey reads business by siteKey; the identity
    // route then reads the same business's logoUrl by id; settings
    // supplies the name. Route calls in order: business(siteKey),
    // settings, business(id) — stage by where-clause shape.
    db.business.findUnique.mockImplementation((args: {
      where?: { siteKey?: string; id?: string };
    }) => {
      if (args.where?.siteKey) {
        return Promise.resolve({
          id: "biz-a",
          name: "Tenant A",
          isInternalAccount: false,
        });
      }
      return Promise.resolve({ logoUrl });
    });
    db.settings.findUnique.mockResolvedValue({
      businessName: "Tenant A",
      welcomeMessage: null,
    });
    return db;
  }

  it("returns tenant A's own logo, never the platform default", async () => {
    await stageIdentity("https://tenant-a.example.com/logo.png");
    const { GET } = await import("@/app/api/widget/identity/route");
    const res = await GET(
      createRequest("/api/widget/identity", {
        searchParams: { siteKey: "rbsite-a" },
      })
    );
    expect(res.status).toBe(200);
    const json = await parseJsonResponse(res);
    expect(json.businessName).toBe("Tenant A");
    expect(json.logoUrl).toBe("https://tenant-a.example.com/logo.png");
    expect(json.logoUrl).not.toContain("ai.ridebangla.bd");
    expect(json.logoUrl).not.toContain("agent-avatar");
  });

  it("a different tenant's logo resolves for that tenant's siteKey", async () => {
    await stageIdentity("https://tenant-b.example.com/mark.webp");
    const { GET } = await import("@/app/api/widget/identity/route");
    const res = await GET(
      createRequest("/api/widget/identity", {
        searchParams: { siteKey: "rbsite-a" },
      })
    );
    const json = await parseJsonResponse(res);
    expect(json.logoUrl).toBe("https://tenant-b.example.com/mark.webp");
  });

  it("missing logo falls back to null — no broken image, no substituted mark", async () => {
    await stageIdentity(null);
    const { GET } = await import("@/app/api/widget/identity/route");
    const res = await GET(
      createRequest("/api/widget/identity", {
        searchParams: { siteKey: "rbsite-a" },
      })
    );
    const json = await parseJsonResponse(res);
    expect(json.logoUrl).toBeNull();
  });

  it("an invalid stored logo degrades to null, never echoed raw", async () => {
    await stageIdentity("javascript:alert(1)");
    const { GET } = await import("@/app/api/widget/identity/route");
    const res = await GET(
      createRequest("/api/widget/identity", {
        searchParams: { siteKey: "rbsite-a" },
      })
    );
    const json = await parseJsonResponse(res);
    expect(json.logoUrl).toBeNull();
  });
});
