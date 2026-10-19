/**
 * scrape.ts — server-side website scraper + rule-based knowledge structuring
 * (Phase 1 onboarding: "give us your business info via website URL").
 *
 * What it does:
 *  - Fetches the homepage + up to 5 same-origin "key" pages (about, services,
 *    products, pricing, contact, FAQ…), guarded by the SSRF validator in
 *    `src/lib/ssrf.ts` (fail-closed: private/internal URLs are rejected).
 *  - Extracts title, meta description, headings, body text, and product-like
 *    entries (text lines carrying a price: ৳ / Tk / BDT / $ / USD …).
 *  - Structures everything WITHOUT any AI key: headings become Q&A-style
 *    knowledge entries, contact/hours lines are detected by regex, and price
 *    lines become product drafts.
 *
 * AI UPGRADE PATH (no key is hardcoded anywhere): when `OPENAI_API_KEY` is
 * configured, Phase 2 can route the raw scraped text through the AI engine
 * (`src/lib/ai/engine.ts`) for higher-quality Q&A extraction. This
 * rule-based pass always runs first and its output stays editable, so the
 * AI pass is a strict improvement, never a dependency.
 */

import { validateOutboundUrl } from "./ssrf";
import { logger } from "./logger";

export interface ProductDraft {
  name: string;
  price: number | null;
  currency: string;
  sourceUrl: string;
}

export interface QAPair {
  question: string;
  answer: string;
}

export interface ScrapedPage {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  products: ProductDraft[];
}

export interface StructuredBusinessInfo {
  businessName: string;
  qa: QAPair[];
  products: ProductDraft[];
  pagesScraped: string[];
  /** Shown in the onboarding review step: how this was built. */
  note: string;
}

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 2_000_000;
/** Homepage + up to this many same-origin key pages. */
const MAX_PAGES = 6;
const SCRAPE_UA =
  "Mozilla/5.0 (compatible; RideBanglaAIAgent-Onboarding/1.0; +https://ai.ridebangla.bd)";

/** Price spellings we recognise: ৳ 150 | Tk 150 | BDT 150 | $ 15 | 150 taka … */
const PRICE_RE =
  /(৳|Tk\.?|BDT|taka|US\$|\$|USD)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(৳|Tk\.?|BDT|taka|US\$|\$|USD)/i;

const PHONE_RE =
  /(\+?880[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{3,4}|\+?\d[\d\s\-()]{7,}\d)/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const HOURS_HINT_RE =
  /(mon|tue|wed|thu|fri|sat|sun|daily|everyday|open|close|hours|am|pm)/i;

const KEY_PAGE_KEYWORDS = [
  "about",
  "service",
  "product",
  "price",
  "pricing",
  "menu",
  "shop",
  "store",
  "catalog",
  "contact",
  "faq",
  "offer",
];

function currencyOf(symbol: string): string {
  const s = symbol.replace(/\./g, "").toLowerCase();
  if (s === "৳" || s === "tk" || s === "bdt" || s === "taka") return "BDT";
  return "USD";
}

async function fetchHtml(url: string): Promise<string | null> {
  const check = await validateOutboundUrl(url);
  if (!check.ok) {
    logger.warn(`[Scrape] blocked URL ${url}: ${check.error}`);
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": SCRAPE_UA,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(type)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) return null;
    // Best-effort charset handling: TextDecoder with utf-8 + fatal:false.
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch (err) {
    logger.warn(
      `[Scrape] fetch failed for ${url}: ${err instanceof Error ? err.message : "unknown"}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(header|nav|footer)[\s>][\s\S]*?<\/(header|nav|footer)>/gi, " ");
  // Keep headings + paragraphs as separate lines for structuring.
  s = s
    .replace(/<\/(h1|h2|h3|h4|p|li|tr|div|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 1)
    .join("\n");
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]{1,200})<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function extractMetaDescription(html: string): string {
  const m = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i
  );
  if (m) return decodeEntities(m[1]).trim();
  const m2 = html.match(
    /<meta[^>]+content=["']([^"']{1,400})["'][^>]+name=["']description["']/i
  );
  return m2 ? decodeEntities(m2[1]).trim() : "";
}

function extractHeadings(html: string): string[] {
  const out: string[] = [];
  const re = /<h[123][^>]*>([\s\S]{1,160}?)<\/h[123]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 30) {
    const t = stripToText(m[1]).replace(/\s+/g, " ").trim();
    if (t.length >= 3 && t.length <= 120 && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Same-origin links, scored so "key" pages (about/pricing/…) come first. */
function discoverKeyPages(html: string, origin: string, base: string): string[] {
  const seen = new Set<string>();
  const scored: { url: string; score: number }[] = [];
  const re = /<a[^>]+href=["']([^"'#]{1,300})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.origin !== origin) continue;
      const norm = u.origin + u.pathname.replace(/\/+$/, "");
      if (seen.has(norm)) continue;
      seen.add(norm);
      const path = u.pathname.toLowerCase();
      const score = KEY_PAGE_KEYWORDS.some((k) => path.includes(k)) ? 1 : 0;
      scored.push({ url: norm, score });
    } catch {
      /* ignore bad hrefs */
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_PAGES - 1).map((s) => s.url);
}

/** Pull product-like drafts out of plain-text lines carrying a price. */
export function extractProductsFromText(
  text: string,
  sourceUrl: string
): ProductDraft[] {
  const drafts: ProductDraft[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length < 4 || line.length > 220) continue;
    // Skip nav-ish junk and sentences that merely mention money.
    if (/^(home|menu|search|login|cart|skip|copyright|all rights)/i.test(line))
      continue;
    const pm = line.match(PRICE_RE);
    if (!pm) continue;
    const symbol = (pm[1] || pm[4] || "").trim();
    const amountRaw = (pm[2] || pm[3] || "").replace(/,/g, "");
    const price = Number(amountRaw);
    if (!Number.isFinite(price) || price <= 0 || price > 100_000_000) continue;

    let name = line
      .replace(PRICE_RE, " ")
      .replace(/[-–—:|•·]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (name.length > 90) name = name.slice(0, 90).trim();
    if (name.length < 2) name = line.slice(0, 60).trim();
    const key = `${name.toLowerCase()}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      name,
      price,
      currency: currencyOf(symbol),
      sourceUrl,
    });
    if (drafts.length >= 40) break;
  }
  return drafts;
}

function pageFromHtml(url: string, html: string): ScrapedPage {
  const text = stripToText(html);
  return {
    url,
    title: extractTitle(html),
    description: extractMetaDescription(html),
    headings: extractHeadings(html),
    text: text.slice(0, 60_000),
    products: extractProductsFromText(text, url),
  };
}

/** Fetch a site (homepage + key pages) and structure it into Q&A + products. */
export async function scrapeBusinessWebsite(
  rawUrl: string
): Promise<StructuredBusinessInfo> {
  let start = rawUrl.trim();
  if (!/^https?:\/\//i.test(start)) start = "https://" + start;

  const check = await validateOutboundUrl(start);
  if (!check.ok) {
    throw new Error(`That website URL can't be fetched: ${check.error}`);
  }

  const homeHtml = await fetchHtml(start);
  if (!homeHtml) {
    throw new Error(
      "Couldn't load that website. Check the URL and try again, or paste your business info as text instead."
    );
  }

  const base = new URL(start);
  const pages: ScrapedPage[] = [pageFromHtml(base.origin + base.pathname, homeHtml)];
  const keyPages = discoverKeyPages(homeHtml, base.origin, start);
  for (const url of keyPages) {
    if (pages.length >= MAX_PAGES) break;
    const html = await fetchHtml(url);
    if (html) pages.push(pageFromHtml(url, html));
  }

  return structurePages(pages);
}

export function structurePages(pages: ScrapedPage[]): StructuredBusinessInfo {
  const qa: QAPair[] = [];
  const products: ProductDraft[] = [];
  const seenQ = new Set<string>();
  const seenP = new Set<string>();

  const pushQA = (question: string, answer: string) => {
    question = question.trim().replace(/\s+/g, " ");
    answer = answer.trim().replace(/\s+/g, " ");
    if (question.length < 3 || answer.length < 10) return;
    if (question.length > 160) question = question.slice(0, 160);
    if (answer.length > 2000) answer = answer.slice(0, 2000);
    const key = question.toLowerCase();
    if (seenQ.has(key)) return;
    seenQ.add(key);
    qa.push({ question, answer });
  };

  let businessName = "";
  const contactLines: string[] = [];
  const hoursLines: string[] = [];

  for (const page of pages) {
    if (!businessName && page.title) {
      // "Acme Bakery — Fresh bread daily" -> "Acme Bakery"
      businessName = page.title.split(/[-–—|]/)[0].trim().slice(0, 80);
    }
    if (page.description) {
      pushQA(
        `What is ${businessName || "this business"}?`,
        page.description
      );
    }

    // Headings -> Q&A pairs (answer = following body text, best effort).
    for (const h of page.headings) {
      const idx = page.text.indexOf(h);
      const snippet =
        idx >= 0
          ? page.text.slice(idx + h.length, idx + h.length + 600)
          : "";
      const answer = snippet.split("\n").filter((l) => l.trim().length > 12).slice(0, 4).join(" ");
      if (answer) pushQA(h, answer);
    }

    for (const line of page.text.split("\n")) {
      const l = line.trim();
      if (l.length < 4 || l.length > 200) continue;
      if (PHONE_RE.test(l) || EMAIL_RE.test(l)) {
        if (!contactLines.includes(l)) contactLines.push(l);
      } else if (HOURS_HINT_RE.test(l) && /\d/.test(l)) {
        if (!hoursLines.includes(l) && hoursLines.length < 6)
          hoursLines.push(l);
      }
    }

    for (const p of page.products) {
      const key = `${p.name.toLowerCase()}|${p.price}`;
      if (seenP.has(key)) continue;
      seenP.add(key);
      products.push(p);
    }
  }

  if (contactLines.length) {
    pushQA("How can I contact you?", contactLines.slice(0, 8).join(" · "));
  }
  if (hoursLines.length) {
    pushQA("What are your business hours?", hoursLines.join(" · "));
  }

  return {
    businessName,
    qa: qa.slice(0, 60),
    products: products.slice(0, 60),
    pagesScraped: pages.map((p) => p.url),
    note:
      "Built automatically from your website (rule-based extraction — no AI key needed). " +
      "Review everything below, edit freely, then save. When an AI key is connected, " +
      "a smarter AI pass can refine this further.",
  };
}

/** Structure pasted / uploaded free-form text (onboarding options b & d). */
export function structureFreeText(
  raw: string,
  sourceName: string
): StructuredBusinessInfo {
  const text = raw.replace(/\r\n/g, "\n").trim().slice(0, 100_000);
  const qa: QAPair[] = [];
  const seen = new Set<string>();

  // Split into blocks on blank lines; first line = title, rest = answer.
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length >= 20);

  for (const block of blocks.slice(0, 60)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let title = lines[0].replace(/^#+\s*/, "").replace(/[:\-–—]+$/, "").trim();
    let body = lines.slice(1).join(" ").trim() || block;
    if (title.length > 120 || title.length < 3) {
      title = `About ${sourceName}`;
      body = block;
    }
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    qa.push({
      question: title.slice(0, 160),
      answer: body.replace(/\s+/g, " ").slice(0, 2000),
    });
  }

  return {
    businessName: "",
    qa,
    products: extractProductsFromText(text, sourceName).slice(0, 60),
    pagesScraped: [sourceName],
    note:
      "Built from the text you provided (rule-based structuring — no AI key needed). " +
      "Review everything below, edit freely, then save.",
  };
}

/** Structure the guided Q&A answers (onboarding option c). */
export function structureGuidedAnswers(fields: {
  businessName?: string;
  category?: string;
  whatYouSell?: string;
  hours?: string;
  location?: string;
  contact?: string;
  policies?: string;
}): StructuredBusinessInfo {
  const qa: QAPair[] = [];
  const name = (fields.businessName || "").trim();
  const push = (q: string, a?: string) => {
    const answer = (a || "").trim();
    if (answer.length >= 3) qa.push({ question: q, answer: answer.slice(0, 2000) });
  };
  push("What category is your business in?", fields.category);
  push(`What does ${name || "your business"} do?`, fields.whatYouSell);
  push("What are your business hours?", fields.hours);
  push("Where are you located?", fields.location);
  push("How can customers contact you?", fields.contact);
  push("What are your policies (returns, refunds, delivery)?", fields.policies);
  return {
    businessName: name,
    qa,
    products: [],
    pagesScraped: ["Guided Q&A"],
    note:
      "Built from your answers. Review everything below, edit freely, then save.",
  };
}
