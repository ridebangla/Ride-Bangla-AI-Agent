/**
 * fullsite-scrape.ts — full-site crawl for website ingest (owner order
 * 2026-11-02: "full-site scraper").
 *
 * Problem it fixes: the legacy ingest path (`scrapeBusinessWebsite` in
 * `./scrape`) fetches the homepage + up to 5 keyword-scored "key" pages
 * only, so a catalog site (e.g. Tools, dozens of tool pages) is never
 * fully learned, and re-index is manual-only.
 *
 * What this module does instead:
 *  - Sitemap-driven discovery: robots.txt `Sitemap:` lines + /sitemap.xml
 *    (including sitemap indexes, depth-capped), then same-origin
 *    internal-link BFS from every page found, so ingest covers the whole
 *    site, not homepage + 5 pages.
 *  - Same safety posture as the legacy scraper: every fetch goes through
 *    the SSRF validator (`./ssrf`, fail-closed), no page scripts are ever
 *    executed (plain fetch + regex text extraction, as in `./scrape`),
 *    same-origin only, auth-gated paths skipped, per-page timeouts and
 *    size caps kept, polite pacing, and a failed page is skipped and
 *    reported — never aborts the whole crawl.
 *  - Re-index semantics are unchanged: `ingestBusinessWebsite` still
 *    replaces exactly the `sourceWebsiteId`-tagged entries for one site
 *    (see `./business-websites`); this module only changes WHICH pages
 *    are fetched and how many Q&A pairs structuring may yield.
 *
 * Backwards compatibility: nothing here alters the legacy path. The
 * legacy `scrapeBusinessWebsite` keeps its homepage + 5 key pages and
 * its 60-pair structuring cap; callers opt into the full-site path
 * explicitly (see `scrapeBusinessWebsiteFull` and the `fullSite` flag
 * on the website record).
 */

import { validateOutboundUrl } from "./ssrf";
import { logger } from "./logger";
import {
  fetchHtml,
  pageFromHtml,
  structurePages,
  type ScrapedPage,
  type StructuredBusinessInfo,
} from "./scrape";

/** Hard ceiling on pages fetched per full-site crawl. Tools-scale sites
 *  (dozens of pages) fit comfortably; the cap bounds worst-case crawl
 *  time and keeps a runaway link graph from crawling forever. */
export const FULLSITE_MAX_PAGES = 300;
/** Structuring ceiling for a full-site crawl (legacy path keeps 60).
 *  This is a CEILING, not a target: stored entries equal the measured
 *  yield, never the cap. See the build report for the measured Tools
 *  yield and the prompt-size tradeoff (the chat engine inlines every
 *  active entry into the system prompt). */
export const FULLSITE_MAX_QA = 1000;
/** Parallel fetches per crawl batch. */
export const FULLSITE_CONCURRENCY = 4;
/** Pause between crawl batches (polite pacing). */
export const FULLSITE_PACE_MS = 100;
/** Wall-clock budget per crawl; on expiry the crawl stops gracefully
 *  with the pages collected so far (`partial: true`), never hanging. */
export const FULLSITE_WALL_CLOCK_MS = 240_000;
/** Max sitemap documents followed (index + children). */
const MAX_SITEMAP_DOCS = 10;
/** Max sitemap depth (index -> child sitemap). */
const MAX_SITEMAP_DEPTH = 2;
/** Per-fetch timeout + size cap, mirroring the legacy scraper. */
const FETCH_TIMEOUT_MS = 15000;
const MAX_TEXT_BYTES = 2_000_000;
/** User agent, same family as the legacy scraper. */
const FULLSITE_UA =
  "Mozilla/5.0 (compatible; RideBanglaAIAgent-FullSite/1.0; +https://ai.ridebangla.bd)";

/** Path segments that are (almost) always auth-gated: never crawled. */
const AUTH_SEGMENTS = new Set([
  "login",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "register",
  "auth",
  "logout",
  "admin",
  "wp-admin",
  "dashboard",
]);

/** File extensions that are never pages: skipped at discovery time. */
const ASSET_EXT_RE =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|mp4|webm|mp3|wav|woff2?|ttf|eot|csv|docx?|xlsx?|txt)$/i;

export interface SkippedPage {
  url: string;
  reason: string;
}

export interface CrawlResult {
  pages: ScrapedPage[];
  skipped: SkippedPage[];
  /** True when at least one sitemap document was found and parsed. */
  sitemapFound: boolean;
  /** True when the crawl stopped early (page cap or wall-clock budget). */
  partial: boolean;
  /** Pages still queued when the crawl stopped (0 unless partial). */
  queueRemaining: number;
}

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  paceMs?: number;
  wallClockMs?: number;
  /** Test seam: production defaults to the SSRF-guarded HTML fetcher. */
  fetchPage?: (url: string) => Promise<string | null>;
  /** Test seam: production defaults to the SSRF-guarded text fetcher. */
  fetchText?: (url: string) => Promise<string | null>;
  /** Test seam: production defaults to the SSRF validator. */
  validateUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Normalize a link target to a canonical same-origin page URL, or null
 * when it must not be crawled (cross-origin, non-http(s), asset file,
 * auth-gated path, unparseable). Query + fragment are dropped: for the
 * static catalog sites this crawler targets, they are variants of the
 * same page, not distinct content.
 */
export function normalizePageUrl(
  href: string,
  base: string,
  origin: string
): string | null {
  const h = href.trim();
  if (!h || /^(javascript:|mailto:|tel:|#)/i.test(h)) return null;
  let u: URL;
  try {
    u = new URL(h, base);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let path = u.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";
  if (ASSET_EXT_RE.test(path)) return null;
  const segments = path.toLowerCase().split("/").filter(Boolean);
  if (segments.some((s) => AUTH_SEGMENTS.has(s))) return null;
  return u.origin + path;
}

/**
 * Parse one sitemap XML document. Returns same-origin page URLs plus
 * same-origin child-sitemap URLs (when the document is a sitemap
 * index). Malformed XML yields empty lists, never a throw — sitemaps
 * are third-party input.
 */
export function parseSitemapXml(
  xml: string,
  origin: string
): { pageUrls: string[]; childSitemaps: string[] } {
  const pageUrls: string[] = [];
  const childSitemaps: string[] = [];
  const seen = new Set<string>();
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const re = /<loc[^>]*>([\s\S]{1,500}?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    const norm = u.origin + u.pathname.replace(/\/+$/, "");
    if (norm === u.origin) continue; // bare origin is the homepage, not a sitemap entry
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (isIndex) childSitemaps.push(norm);
    else pageUrls.push(norm);
    if (pageUrls.length + childSitemaps.length >= 5000) break;
  }
  return { pageUrls, childSitemaps };
}

/** Extract `Sitemap:` URLs from robots.txt (same-origin only). */
export function parseRobotsTxt(txt: string, origin: string): string[] {
  const out: string[] = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*Sitemap:\s*(\S+)/i);
    if (!m) continue;
    try {
      const u = new URL(m[1].trim());
      if (u.origin === origin) out.push(u.origin + u.pathname);
    } catch {
      /* ignore bad URLs */
    }
  }
  return out;
}

/** All same-origin page links on a page, normalized + deduped. Unlike
 *  the legacy keyword-scored discovery, this returns EVERY link: the
 *  crawl budget (page cap), not keyword guessing, decides coverage. */
export function discoverSiteLinks(
  html: string,
  origin: string,
  base: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /<a[^>]+href=["']([^"'#]{1,300})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const norm = normalizePageUrl(m[1], base, origin);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Conservative login-page heuristic: a password field AND a login-ish
 * title/heading. Used post-fetch only (redirects to a login page are
 * otherwise invisible to the plain fetcher). False negatives are safe:
 * an unrecognized login page yields no usable Q&A pairs anyway, and
 * its content is never presented as business knowledge beyond generic
 * headings — but skipping known login pages keeps credentials-adjacent
 * UI text out of the knowledge base entirely.
 */
export function looksLikeLoginPage(html: string): boolean {
  const hasPassword = /<input[^>]+type=["']password["']/i.test(html);
  if (!hasPassword) return false;
  const title = html.match(/<title[^>]*>([\s\S]{1,200})<\/title>/i)?.[1] ?? "";
  const h1 = html.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i)?.[1] ?? "";
  return /log\s?in|sign\s?in|sign\s?up|register/i.test(title + " " + h1);
}

/**
 * SSRF-guarded plain-text fetch for sitemaps/robots.txt. The legacy
 * HTML fetcher rejects non-HTML content types, which would reject
 * every sitemap (served as XML) — so sitemaps get their own fetcher
 * with the same SSRF validation, timeout, and size cap, but accepting
 * text/* and XML content types. Never executes anything fetched.
 */
export async function fetchText(url: string): Promise<string | null> {
  const check = await validateOutboundUrl(url);
  if (!check.ok) {
    logger.warn(`[FullSite] blocked URL ${url}: ${check.error}`);
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": FULLSITE_UA, Accept: "text/*,application/xml" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!/text\/|application\/(xml|rss\+xml)/i.test(type)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_TEXT_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch (err) {
    logger.warn(
      `[FullSite] text fetch failed for ${url}: ${err instanceof Error ? err.message : "unknown"}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Directory base for resolving relative links on a page. A page URL
 * like /pdf (no trailing slash, no file extension) is a directory in
 * practice: resolving "tool.html" against "/pdf" as a FILE would wrongly
 * yield "/tool.html" (a 404), while browsers resolve it against "/pdf/"
 * (the served directory URL). Appending "/" for extensionless paths
 * makes discovery match what the site itself serves.
 */
export function dirBase(pageUrl: string): string {
  const u = new URL(pageUrl);
  const path = u.pathname;
  if (path.endsWith("/")) return pageUrl;
  const last = path.split("/").pop() ?? "";
  if (last.includes(".")) return pageUrl;
  return pageUrl + "/";
}
/**
 * Crawl a whole site: sitemap seeds first (authoritative), then BFS
 * over discovered same-origin links. A failed page is recorded in
 * `skipped` and never aborts the crawl; the page cap and wall-clock
 * budget stop the crawl gracefully with `partial: true`.
 */
export async function crawlSite(
  rawUrl: string,
  opts: CrawlOptions = {}
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? FULLSITE_MAX_PAGES;
  const concurrency = Math.max(1, opts.concurrency ?? FULLSITE_CONCURRENCY);
  const paceMs = opts.paceMs ?? FULLSITE_PACE_MS;
  const wallClockMs = opts.wallClockMs ?? FULLSITE_WALL_CLOCK_MS;
  const fetchPage = opts.fetchPage ?? fetchHtml;
  const fetchTextFn = opts.fetchText ?? fetchText;
  const validateUrl = opts.validateUrl ?? validateOutboundUrl;

  let start = rawUrl.trim();
  if (!/^https?:\/\//i.test(start)) start = "https://" + start;
  const check = await validateUrl(start);
  if (!check.ok) {
    throw new Error(`That website URL can't be fetched: ${check.error}`);
  }
  const base = new URL(start);
  const origin = base.origin;

  const startedAt = Date.now();
  const pages: ScrapedPage[] = [];
  const skipped: SkippedPage[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];
  const enqueue = (url: string) => {
    if (!visited.has(url)) {
      visited.add(url);
      queue.push(url);
    }
  };

  // Homepage first (fail fast, same contract as the legacy scraper).
  const homeHtml = await fetchPage(start);
  if (!homeHtml) {
    throw new Error(
      "Couldn't load that website. Check the URL and try again, or paste your business info as text instead."
    );
  }
  const strippedHome = base.pathname.replace(/\/+$/, "");
  const homeUrl = origin + (strippedHome === "" ? "/" : strippedHome);
  visited.add(homeUrl);
  pages.push(pageFromHtml(homeUrl, homeHtml));
  for (const link of discoverSiteLinks(homeHtml, origin, dirBase(homeUrl))) enqueue(link);

  // Sitemap seeds: robots.txt declarations, then /sitemap.xml (index
  // followed to children, depth-capped). Sitemap URLs jump the queue:
  // they are the site's own statement of what exists.
  let sitemapFound = false;
  const sitemapQueue: { url: string; depth: number }[] = [];
  const robots = await fetchTextFn(origin + "/robots.txt");
  if (robots) {
    for (const sm of parseRobotsTxt(robots, origin)) {
      sitemapQueue.push({ url: sm, depth: 0 });
    }
  }
  sitemapQueue.push({ url: origin + "/sitemap.xml", depth: 0 });
  const seenSitemaps = new Set<string>();
  let sitemapDocs = 0;
  const sitemapPageUrls: string[] = [];
  while (sitemapQueue.length > 0 && sitemapDocs < MAX_SITEMAP_DOCS) {
    const doc = sitemapQueue.shift()!;
    if (seenSitemaps.has(doc.url)) continue;
    seenSitemaps.add(doc.url);
    const xml = await fetchTextFn(doc.url);
    if (!xml) continue;
    sitemapDocs++;
    sitemapFound = true;
    const parsed = parseSitemapXml(xml, origin);
    for (const p of parsed.pageUrls) sitemapPageUrls.push(p);
    if (doc.depth < MAX_SITEMAP_DEPTH) {
      for (const child of parsed.childSitemaps) {
        sitemapQueue.push({ url: child, depth: doc.depth + 1 });
      }
    }
  }
  // Sitemap URLs first in the crawl queue, in sitemap order.
  const rest = queue.splice(0);
  visited.clear();
  visited.add(pages[0].url);
  for (const u of sitemapPageUrls) enqueue(u);
  for (const u of rest) enqueue(u);

  let partial = false;
  while (queue.length > 0 && pages.length < maxPages) {
    if (Date.now() - startedAt > wallClockMs) {
      partial = true;
      break;
    }
    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(
      batch.map(async (url) => {
        const html = await fetchPage(url);
        return { url, html };
      })
    );
    for (const { url, html } of results) {
      if (!html) {
        skipped.push({ url, reason: "fetch failed" });
        continue;
      }
      if (looksLikeLoginPage(html)) {
        skipped.push({ url, reason: "login-like page" });
        continue;
      }
      pages.push(pageFromHtml(url, html));
      if (pages.length >= maxPages) break;
      for (const link of discoverSiteLinks(html, origin, dirBase(url))) enqueue(link);
    }
    if (paceMs > 0 && queue.length > 0 && pages.length < maxPages) {
      await new Promise((r) => setTimeout(r, paceMs));
    }
  }
  if (queue.length > 0 && pages.length >= maxPages) partial = true;

  return {
    pages,
    skipped,
    sitemapFound,
    partial,
    queueRemaining: queue.length,
  };
}

/**
 * Full-site equivalent of `scrapeBusinessWebsite`: crawl the whole
 * site, then structure with the full-site Q&A ceiling. The returned
 * shape is identical to the legacy one (same `note` contract aside
 * from the crawl description), so ingest code consumes it unchanged.
 */
export async function scrapeBusinessWebsiteFull(
  rawUrl: string,
  opts: CrawlOptions & { maxQA?: number } = {}
): Promise<StructuredBusinessInfo> {
  const { maxQA, ...crawlOpts } = opts;
  const result = await crawlSite(rawUrl, crawlOpts);
  const info = structurePages(result.pages, {
    maxQA: maxQA ?? FULLSITE_MAX_QA,
  });
  const skippedNote =
    result.skipped.length > 0
      ? ` ${result.skipped.length} page(s) skipped (fetch failed or login-like).`
      : "";
  const partialNote = result.partial
    ? ` Crawl stopped early (page cap or time budget); ${result.queueRemaining} page(s) not fetched.`
    : "";
  return {
    ...info,
    pagesScraped: result.pages.map((p) => p.url),
    note:
      "Built automatically from a full-site crawl of your website " +
      `(sitemap + internal links; ${result.pages.length} page(s) fetched` +
      `${result.sitemapFound ? ", sitemap found" : ", no sitemap found"}.` +
      ` Rule-based extraction — no AI key needed).` +
      skippedNote +
      partialNote +
      " Review everything below, edit freely, then save.",
  };
}
