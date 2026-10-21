/**
 * business-websites-ingest.test.ts — the REAL fetch-and-learn pipeline
 * over fixture sites (owner directive 2026-10-21 verification).
 *
 * The actual `scrapeBusinessWebsite` from src/lib/scrape.ts runs against
 * two fixture HTML pages served by a stubbed global fetch (the SSRF
 * validator is stubbed open — DNS resolution is not what is under test;
 * the fail-closed SSRF behaviour has its own coverage). We assert:
 *  - both fixture pages are discovered + read (homepage + /about),
 *  - Q&A knowledge is structured out of the fixture content,
 *  - ingestBusinessWebsite saves those entries tagged with the website
 *    id, and reports page/entry counts that match what was produced,
 *  - a site whose fetch fails reports status "failed" with the reason
 *    and saves NOTHING — "trained" is never claimed for a failed site.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/ssrf", () => ({
  validateOutboundUrl: vi.fn(async () => ({ ok: true })),
}));

import { scrapeBusinessWebsite } from "@/lib/scrape";
import { ingestBusinessWebsite } from "@/lib/business-websites";
import { prisma } from "@/lib/prisma";
import type { BusinessWebsite } from "@/lib/models";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

const HOME = `<!doctype html>
<html><head>
<title>Fixture Cake Shop</title>
<meta name="description" content="Fixture Cake Shop bakes custom cakes in Faridpur.">
</head><body>
<h1>Fixture Cake Shop</h1>
<p>We bake custom birthday and wedding cakes to order in Faridpur.</p>
<h2>Our Cakes</h2>
<p>Chocolate Truffle Cake ৳ 850</p>
<p>Vanilla Celebration Cake ৳ 650</p>
<h2>Delivery</h2>
<p>We deliver inside Faridpur town within 3 hours. Call us at +880 1712-345678 to order.</p>
<nav><a href="/about">About us</a></nav>
</body></html>`;

const ABOUT = `<!doctype html>
<html><head><title>About — Fixture Cake Shop</title></head><body>
<h1>About Fixture Cake Shop</h1>
<h2>Opening Hours</h2>
<p>Open daily from 9 am to 10 pm, including Fridays.</p>
<h2>Our Story</h2>
<p>Fixture Cake Shop started in 2020 as a home bakery and now serves all of Faridpur.</p>
</body></html>`;

const PAGES: Record<string, string> = {
  "https://fixture-shop.example": HOME,
  "https://fixture-shop.example/about": ABOUT,
};

function htmlResponse(html: string) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html" : null),
    },
    arrayBuffer: async () =>
      new TextEncoder().encode(html).buffer as ArrayBuffer,
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.category.findFirst.mockResolvedValue({ id: "cat-9", name: "Website" });
  db.category.create.mockResolvedValue({ id: "cat-9", name: "Website" });
  db.knowledgeEntry.deleteMany.mockResolvedValue({ count: 0 });
  db.knowledgeEntry.create.mockResolvedValue({});
});

describe("real scraper over fixture pages", () => {
  it("reads the homepage + the discovered /about page and structures Q&A", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        PAGES[url] ? htmlResponse(PAGES[url]) : notFoundResponse()
      )
    );
    const info = await scrapeBusinessWebsite("https://fixture-shop.example");
    expect(info.pagesScraped).toHaveLength(2);
    expect(info.pagesScraped.some((u) => u.includes("/about"))).toBe(true);
    expect(info.qa.length).toBeGreaterThan(0);
    const allText = info.qa.map((q) => `${q.question} ${q.answer}`).join("\n");
    expect(allText).toContain("Faridpur");
    vi.unstubAllGlobals();
  });

  it("ingest saves the fixture site's entries, tagged with the website id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        PAGES[url] ? htmlResponse(PAGES[url]) : notFoundResponse()
      )
    );
    const website: BusinessWebsite = {
      id: "w-fixture",
      url: "https://fixture-shop.example",
      host: "fixture-shop.example",
      status: "pending",
      addedAt: "2026-10-21T00:00:00.000Z",
      lastIndexedAt: null,
    };
    const result = await ingestBusinessWebsite("biz-fixture", website);
    expect(result.status).toBe("indexed");
    expect(result.pageCount).toBe(2);
    expect(result.entryCount).toBeGreaterThan(0);
    const creates = db.knowledgeEntry.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data
    );
    expect(creates).toHaveLength(result.entryCount);
    expect(creates.every((d) => d.sourceWebsiteId === "w-fixture")).toBe(true);
    expect(
      creates.every(
        (d) =>
          (d.metadata as { source?: string }).source === "website"
      )
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it("a site that cannot be fetched reports failed and saves nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => notFoundResponse()));
    const website: BusinessWebsite = {
      id: "w-down",
      url: "https://down.example",
      host: "down.example",
      status: "pending",
      addedAt: "2026-10-21T00:00:00.000Z",
      lastIndexedAt: null,
    };
    const result = await ingestBusinessWebsite("biz-fixture", website);
    expect(result.status).toBe("failed");
    expect(result.entryCount).toBe(0);
    expect(result.reason).toBeTruthy();
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
