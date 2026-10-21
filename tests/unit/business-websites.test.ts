/**
 * business-websites.test.ts — multi-website list + website-creation
 * requests (owner directive 2026-10-21).
 *
 * Covers:
 *  (a) URL normalization + duplicate rules (pure, src/lib/website-url.ts)
 *  (b) the legacy single websiteUrl showing up as a "pending" entry —
 *      never as a fake "indexed"
 *  (c) POST /api/business/websites: add → scrape → indexed with real
 *      counts; fetch failure still saves the entry as "failed" + reason;
 *      duplicate and invalid URLs get a kind 400; the scrape mock proves
 *      no status is ever claimed without a fetch behind it
 *  (d) DELETE removes the site AND its knowledge entries; PATCH re-indexes
 *  (e) tenant isolation: the business id comes from auth only — a body
 *      claiming another business changes nothing
 *  (f) website-creation requests: tenant submits + sees its own; the
 *      Super Admin lists all, moves status, and every change is audited;
 *      a non-super role is refused
 *
 * The scrape itself is mocked here; the REAL scraper over fixture pages
 * is exercised in business-websites-ingest.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const scrapeMock = vi.fn();
vi.mock("@/lib/scrape", () => ({
  scrapeBusinessWebsite: (...args: unknown[]) => scrapeMock(...args),
}));

import {
  normalizeWebsiteUrl,
  hasDuplicateWebsite,
  mergeWebsitesWithLegacy,
  websiteKeyOf,
} from "@/lib/website-url";
import { GET as websitesGET, POST as websitesPOST, PATCH as websitesPATCH, DELETE as websitesDELETE } from "@/app/api/business/websites/route";
import { GET as requestsGET, POST as requestsPOST } from "@/app/api/business/website-requests/route";
import { GET as adminRequestsGET, PATCH as adminRequestsPATCH } from "@/app/api/admin/website-requests/route";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/route-auth";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;
const requireAuthMock = requireAuth as unknown as MockFn;

const TENANT_AUTH = {
  userId: "test-admin-id",
  role: "admin",
  username: "admin",
  name: "Test Admin",
  authMethod: "cookie",
  scopes: [],
  businessId: "test-business",
};

let ipCounter = 0;
function req(method: string, url: string, body?: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.7.0.${ipCounter}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const scrapedFixture = {
  businessName: "Shop Example",
  qa: [
    { question: "What do you sell?", answer: "Cakes and pastries." },
    { question: "Where are you?", answer: "Faridpur." },
  ],
  products: [],
  pagesScraped: ["https://shop.example/", "https://shop.example/about"],
  note: "fixture",
};

function bizDoc(partial: Record<string, unknown> = {}) {
  return {
    id: "test-business",
    name: "Test Biz",
    slug: "test-biz",
    siteKey: "rbsite-test",
    isActive: true,
    websites: [],
    websiteUrl: null,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue(TENANT_AUTH);
  scrapeMock.mockResolvedValue(scrapedFixture);
  db.business.findUnique.mockResolvedValue(bizDoc());
  db.business.update.mockResolvedValue({});
  db.category.findFirst.mockResolvedValue({ id: "cat-1", name: "Website" });
  db.category.create.mockResolvedValue({ id: "cat-1", name: "Website" });
  db.knowledgeEntry.deleteMany.mockResolvedValue({ count: 0 });
  db.knowledgeEntry.create.mockResolvedValue({});
  db.websiteCreationRequest.findMany.mockResolvedValue([]);
  db.websiteCreationRequest.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "wreq-1",
      createdAt: new Date("2026-10-21T00:00:00Z"),
      updatedAt: new Date("2026-10-21T00:00:00Z"),
      ...data,
    })
  );
});

// ---------------------------------------------------------------------
// (a) URL normalization + duplicates
// ---------------------------------------------------------------------
describe("normalizeWebsiteUrl", () => {
  it("adds https:// and lowercases the host", () => {
    const r = normalizeWebsiteUrl("Shop.Example.COM/");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.url).toBe("https://shop.example.com/");
      expect(r.value.host).toBe("shop.example.com");
    }
  });

  it("treats www / bare / trailing-slash variants as the same website", () => {
    const a = normalizeWebsiteUrl("example.com");
    const b = normalizeWebsiteUrl("https://www.example.com/");
    const c = normalizeWebsiteUrl("http://example.com");
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.value.key).toBe(b.value.key);
      expect(a.value.key).toBe(c.value.key);
    }
    expect(websiteKeyOf("https://www.example.com/")).toBe(
      websiteKeyOf("example.com")
    );
  });

  it("keeps a real sub-path distinct from the root site", () => {
    const root = normalizeWebsiteUrl("example.com");
    const sub = normalizeWebsiteUrl("example.com/shop");
    expect(root.ok && sub.ok).toBe(true);
    if (root.ok && sub.ok) expect(root.value.key).not.toBe(sub.value.key);
  });

  it("rejects non-http schemes, credentials and hostnames without a dot", () => {
    expect(normalizeWebsiteUrl("ftp://example.com").ok).toBe(false);
    expect(normalizeWebsiteUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeWebsiteUrl("https://user:pass@example.com").ok).toBe(false);
    expect(normalizeWebsiteUrl("nodot").ok).toBe(false);
    expect(normalizeWebsiteUrl("").ok).toBe(false);
    expect(normalizeWebsiteUrl(42).ok).toBe(false);
  });

  it("hasDuplicateWebsite matches against stored entries", () => {
    const list = [{ id: "1", url: "https://shop.example/" }];
    expect(hasDuplicateWebsite(list, websiteKeyOf("www.shop.example"))).toBe(true);
    expect(hasDuplicateWebsite(list, websiteKeyOf("other.example"))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// (b) legacy merge
// ---------------------------------------------------------------------
describe("mergeWebsitesWithLegacy", () => {
  const make = (url: string, host: string) => ({
    id: "legacy",
    url,
    host,
    status: "pending",
  });

  it("turns a legacy websiteUrl into ONE pending entry (never indexed)", () => {
    const out = mergeWebsitesWithLegacy(undefined, "https://Old.COM/", make);
    expect(out).toHaveLength(1);
    expect(out[0].host).toBe("old.com");
    expect(out[0].status).toBe("pending");
  });

  it("a stored list wins over the legacy field", () => {
    const stored = [{ id: "a", url: "https://a.example/", host: "a.example", status: "indexed" }];
    expect(mergeWebsitesWithLegacy(stored, "https://old.example/", make)).toBe(stored);
  });

  it("invalid legacy values yield an empty list", () => {
    expect(mergeWebsitesWithLegacy(undefined, "not a url", make)).toEqual([]);
    expect(mergeWebsitesWithLegacy(undefined, null, make)).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// (c)+(d) websites route
// ---------------------------------------------------------------------
describe("/api/business/websites", () => {
  it("GET shows the legacy websiteUrl as a pending entry", async () => {
    db.business.findUnique.mockResolvedValue(
      bizDoc({ websites: undefined, websiteUrl: "https://Legacy.com/" })
    );
    const res = await websitesGET(req("GET", "http://localhost/api/business/websites"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.websites).toHaveLength(1);
    expect(body.websites[0].host).toBe("legacy.com");
    expect(body.websites[0].status).toBe("pending");
  });

  it("POST adds a site, indexes it, and persists the honest result", async () => {
    const res = await websitesPOST(
      req("POST", "http://localhost/api/business/websites", { url: "shop.example" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.website.status).toBe("indexed");
    expect(body.website.pageCount).toBe(2);
    expect(body.website.entryCount).toBe(2);
    expect(scrapeMock).toHaveBeenCalledTimes(1);
    // Entries are tagged with the website id so re-index/remove can
    // replace exactly this site's knowledge.
    const creates = db.knowledgeEntry.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data
    );
    expect(creates).toHaveLength(2);
    expect(creates.every((d) => d.sourceWebsiteId === body.website.id)).toBe(true);
    // Final persisted list carries the same honest status.
    const lastUpdate = db.business.update.mock.calls.at(-1)?.[0] as {
      data: { websites: Array<Record<string, unknown>>; websiteUrl: string };
    };
    expect(lastUpdate.data.websites[0].status).toBe("indexed");
    expect(lastUpdate.data.websiteUrl).toBe(body.website.url);
  });

  it("POST a duplicate (www variant) is a kind 400 and never scrapes", async () => {
    db.business.findUnique.mockResolvedValue(
      bizDoc({
        websites: [
          {
            id: "w1",
            url: "https://shop.example/",
            host: "shop.example",
            status: "indexed",
            addedAt: "2026-10-21T00:00:00.000Z",
            lastIndexedAt: null,
          },
        ],
      })
    );
    const res = await websitesPOST(
      req("POST", "http://localhost/api/business/websites", { url: "www.shop.example" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already in your list");
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it("POST an invalid URL is a 400 with the reason", async () => {
    const res = await websitesPOST(
      req("POST", "http://localhost/api/business/websites", { url: "ftp://nope.example" })
    );
    expect(res.status).toBe(400);
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it("POST with a failing fetch still saves the site — as failed, with the reason", async () => {
    scrapeMock.mockRejectedValue(
      new Error("Couldn't load that website. Check the URL and try again.")
    );
    const res = await websitesPOST(
      req("POST", "http://localhost/api/business/websites", { url: "down.example" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.website.status).toBe("failed");
    expect(body.website.statusReason).toContain("Couldn't load");
    expect(body.website.entryCount).toBe(0);
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
    const lastUpdate = db.business.update.mock.calls.at(-1)?.[0] as {
      data: { websites: Array<Record<string, unknown>> };
    };
    expect(lastUpdate.data.websites).toHaveLength(1);
    expect(lastUpdate.data.websites[0].status).toBe("failed");
  });

  it("PATCH re-indexes an existing site", async () => {
    db.business.findUnique.mockResolvedValue(
      bizDoc({
        websites: [
          {
            id: "w1",
            url: "https://shop.example/",
            host: "shop.example",
            status: "failed",
            statusReason: "boom",
            addedAt: "2026-10-21T00:00:00.000Z",
            lastIndexedAt: null,
          },
        ],
      })
    );
    const res = await websitesPATCH(
      req("PATCH", "http://localhost/api/business/websites", { id: "w1" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.website.status).toBe("indexed");
    expect(body.website.entryCount).toBe(2);
    // Old entries for THIS site were cleared before re-creating.
    expect(db.knowledgeEntry.deleteMany).toHaveBeenCalledWith({
      where: { sourceWebsiteId: "w1" },
    });
  });

  it("DELETE removes the site and exactly its knowledge entries", async () => {
    db.business.findUnique.mockResolvedValue(
      bizDoc({
        websites: [
          {
            id: "w1",
            url: "https://shop.example/",
            host: "shop.example",
            status: "indexed",
            addedAt: "2026-10-21T00:00:00.000Z",
            lastIndexedAt: null,
          },
        ],
        websiteUrl: "https://shop.example/",
      })
    );
    const res = await websitesDELETE(
      req("DELETE", "http://localhost/api/business/websites?id=w1")
    );
    expect(res.status).toBe(200);
    expect(db.knowledgeEntry.deleteMany).toHaveBeenCalledWith({
      where: { sourceWebsiteId: "w1" },
    });
    const lastUpdate = db.business.update.mock.calls.at(-1)?.[0] as {
      data: { websites: unknown[]; websiteUrl: unknown };
    };
    expect(lastUpdate.data.websites).toEqual([]);
    expect(lastUpdate.data.websiteUrl).toBeNull();
  });

  it("(e) a body claiming another business changes nothing — auth wins", async () => {
    const res = await websitesPOST(
      req("POST", "http://localhost/api/business/websites", {
        url: "shop.example",
        businessId: "victim-business",
      })
    );
    expect(res.status).toBe(200);
    for (const call of db.business.findUnique.mock.calls) {
      expect((call[0] as { where: { id: string } }).where.id).toBe("test-business");
    }
    for (const call of db.business.update.mock.calls) {
      expect((call[0] as { where: { id: string } }).where.id).toBe("test-business");
    }
  });
});

// ---------------------------------------------------------------------
// (f) website-creation requests
// ---------------------------------------------------------------------
describe("website-creation requests", () => {
  const validBody = {
    businessName: "Dhaka Cake House",
    contactName: "Rahim Uddin",
    contactPhone: "01712345678",
    siteType: "ecommerce",
    notes: "Need online ordering",
  };

  it("tenant submits; the record starts at status new with an audit seed", async () => {
    const res = await requestsPOST(
      req("POST", "http://localhost/api/business/website-requests", validBody)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.status).toBe("new");
    const created = db.websiteCreationRequest.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.status).toBe("new");
    expect(
      (created.data.statusHistory as Array<{ status: string }>)[0].status
    ).toBe("new");
  });

  it("tenant submit with a too-short phone is a 400", async () => {
    const res = await requestsPOST(
      req("POST", "http://localhost/api/business/website-requests", {
        ...validBody,
        contactPhone: "123",
      })
    );
    expect(res.status).toBe(400);
    expect(db.websiteCreationRequest.create).not.toHaveBeenCalled();
  });

  it("tenant GET returns its own requests (tenant-scoped model)", async () => {
    db.websiteCreationRequest.findMany.mockResolvedValue([
      {
        id: "wreq-1",
        businessId: "test-business",
        businessName: "Dhaka Cake House",
        contactName: "Rahim Uddin",
        contactPhone: "01712345678",
        siteType: "ecommerce",
        notes: "",
        status: "contacted",
        statusHistory: [],
        createdAt: new Date("2026-10-21T00:00:00Z"),
        updatedAt: new Date("2026-10-21T00:00:00Z"),
      },
    ]);
    const res = await requestsGET(
      req("GET", "http://localhost/api/business/website-requests")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].status).toBe("contacted");
  });

  it("Super Admin lists all + moves status with an audit entry", async () => {
    requireAuthMock.mockResolvedValue({
      ...TENANT_AUTH,
      role: "super_admin",
      businessId: null,
    });
    db.websiteCreationRequest.findMany.mockResolvedValue([
      {
        id: "wreq-1",
        businessId: "biz-9",
        businessName: "Dhaka Cake House",
        contactName: "Rahim Uddin",
        contactPhone: "01712345678",
        siteType: "ecommerce",
        notes: "",
        status: "new",
        statusHistory: [{ status: "new", by: "Rahim Uddin", at: "2026-10-21T00:00:00.000Z" }],
        createdAt: new Date("2026-10-21T00:00:00Z"),
        updatedAt: new Date("2026-10-21T00:00:00Z"),
      },
    ]);
    const listRes = await adminRequestsGET(
      req("GET", "http://localhost/api/admin/website-requests")
    );
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).requests).toHaveLength(1);

    const existing = {
      id: "wreq-1",
      businessId: "biz-9",
      businessName: "Dhaka Cake House",
      contactName: "Rahim Uddin",
      contactPhone: "01712345678",
      siteType: "ecommerce",
      notes: "",
      status: "new",
      statusHistory: [{ status: "new", by: "Rahim Uddin", at: "2026-10-21T00:00:00.000Z" }],
      createdAt: new Date("2026-10-21T00:00:00Z"),
      updatedAt: new Date("2026-10-21T00:00:00Z"),
    };
    db.websiteCreationRequest.findUnique.mockResolvedValue(existing);
    db.websiteCreationRequest.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...existing,
        ...data,
      })
    );
    db.activityLog.create.mockResolvedValue({});

    const patchRes = await adminRequestsPATCH(
      req("PATCH", "http://localhost/api/admin/website-requests", {
        id: "wreq-1",
        status: "contacted",
      })
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()).request;
    expect(patched.status).toBe("contacted");
    expect(patched.statusHistory).toHaveLength(2);
    expect(patched.statusHistory[1].status).toBe("contacted");
    // Audit: an activityLog row was written for the change.
    expect(db.activityLog.create).toHaveBeenCalledTimes(1);
    const audit = db.activityLog.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(audit.data.action).toBe("website_request.status");
  });

  it("a non-super role is refused the admin queue", async () => {
    requireAuthMock.mockResolvedValue(TENANT_AUTH);
    const res = await adminRequestsGET(
      req("GET", "http://localhost/api/admin/website-requests")
    );
    expect(res.status).toBe(403);
  });

  it("an invalid status move is a 400", async () => {
    requireAuthMock.mockResolvedValue({
      ...TENANT_AUTH,
      role: "super_admin",
      businessId: null,
    });
    const res = await adminRequestsPATCH(
      req("PATCH", "http://localhost/api/admin/website-requests", {
        id: "wreq-1",
        status: "banana",
      })
    );
    expect(res.status).toBe(400);
  });
});
