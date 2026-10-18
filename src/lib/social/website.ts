/**
 * Website grounding: fetch the public Ride Bangla site (home, services,
 * about) and strip it to plain text so post content can be grounded in
 * real site content. 404s are tolerated; results are cached in memory for
 * one hour. Uses the repo's SSRF validator before any fetch.
 */
import { validateOutboundUrl } from "@/lib/ssrf";
import { logger } from "@/lib/logger";

export interface WebsitePage {
  url: string;
  title: string;
  text: string;
}

const PAGES = [
  "https://ridebangla.bd",
  "https://ridebangla.bd/services",
  "https://ridebangla.bd/about",
];

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { at: number; pages: WebsitePage[] } | null = null;

const TIMEOUT_MS = 15_000;

function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim();

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return { title, text: text.slice(0, 8000) };
}

async function fetchPage(url: string): Promise<WebsitePage | null> {
  const check = await validateOutboundUrl(url);
  if (!check.ok) {
    logger.warn("Website fetch blocked", { url, error: check.error });
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RideBangla-AIAgent/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 404s tolerated — a page may simply not exist yet
      logger.warn("Website page fetch failed", { url, status: res.status });
      return null;
    }
    const html = await res.text();
    const { title, text } = stripHtml(html);
    return { url, title, text };
  } catch (err) {
    logger.warn("Website page fetch error", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWebsiteContent(): Promise<WebsitePage[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.pages;
  }
  const results = await Promise.all(PAGES.map(fetchPage));
  const pages = results.filter((p): p is WebsitePage => p !== null);
  cache = { at: Date.now(), pages };
  return pages;
}
