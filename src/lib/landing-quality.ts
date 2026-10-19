/**
 * landing-quality.ts — visual quality gate for auto-generated landing pages.
 *
 * `checkLandingQuality(slug)` verifies a business's hosted page (`/p/[slug]`)
 * before (or after) it goes live:
 *   1. every product/logo image URL resolves (HTTP HEAD, 8s timeout),
 *   2. required sections are present and non-empty,
 *   3. brand-color vs text contrast passes WCAG-ish thresholds,
 *   4. SEO basics (title, meta description, OG tags) are present.
 *
 * Warnings never block publishing — they are advisory. Only `fail`
 * entries set `ready = false`.
 *
 * ---------------------------------------------------------------------------
 * PHASE 6 CONTRACT — Launch Readiness checklist consumes this shape.
 * ---------------------------------------------------------------------------
 * Source: GET /api/landing/quality?slug=<slug>  (public; slug is the
 * fail-closed scoping mechanism, same as /p/[slug]; no session required).
 *
 *   interface LandingQualityStatus {
 *     slug: string;            // the checked page slug
 *     theme: string;           // resolved theme id, e.g. "modern-minimal"
 *     ready: boolean;          // TRUE iff no check has status "fail".
 *                              //   Phase 6: gate the readiness item on this.
 *     fails: number;           // count of status === "fail"
 *     warnings: number;        // count of status === "warn"
 *     checks: LandingQualityCheck[];  // render label + detail in the UI
 *     checkedAt: string;       // ISO-8601 timestamp of the check
 *   }
 *   interface LandingQualityCheck {
 *     id: string;              // stable id, e.g. "images.logo", "contrast.hero"
 *     label: string;           // human-readable label
 *     status: "pass" | "warn" | "fail";
 *     detail: string;          // one-line explanation
 *   }
 *
 * Dashboard persistence: after running the check, the editor records a
 * compact summary via PUT /api/landing { landingQuality: { ready, fails,
 * warnings, checkedAt } } — see summarizeQualityForRecord().
 * ---------------------------------------------------------------------------
 */

import { getLandingData, buildLandingMeta, type PublicLandingData } from "./landing";
import { themeContrastPairs, contrastRatio, type LandingThemeId } from "./landing-themes";

export type QualityCheckStatus = "pass" | "warn" | "fail";

export interface LandingQualityCheck {
  id: string;
  label: string;
  status: QualityCheckStatus;
  detail: string;
}

export interface LandingQualityStatus {
  slug: string;
  theme: LandingThemeId;
  ready: boolean;
  fails: number;
  warnings: number;
  checks: LandingQualityCheck[];
  checkedAt: string;
}

export interface ImageCheckResult {
  url: string;
  label: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

const IMAGE_TIMEOUT_MS = 8000;
const IMAGE_CONCURRENCY = 6;

/** Single image URL check: HEAD, falling back to a ranged GET (some CDNs reject HEAD). */
export async function checkImageUrl(
  url: string,
  label: string,
  timeoutMs = IMAGE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<ImageCheckResult> {
  // SSRF guard: only http(s) URLs are ever fetched.
  if (!/^https?:\/\//i.test(url)) {
    return { url, label, ok: false, status: null, error: "unsupported protocol" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: controller.signal,
      });
    }
    // Drain the body so sockets are released (best-effort).
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    const ok = res.status >= 200 && res.status < 400;
    return {
      url,
      label,
      ok,
      status: res.status,
      ...(ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (e) {
    const reason =
      e instanceof Error
        ? e.name === "AbortError"
          ? `timed out after ${timeoutMs}ms`
          : e.message
        : "fetch failed";
    return { url, label, ok: false, status: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Check many image URLs with bounded concurrency. */
export async function checkImageUrls(
  items: Array<{ url: string; label: string }>,
  opts?: { timeoutMs?: number; concurrency?: number; fetchImpl?: typeof fetch }
): Promise<ImageCheckResult[]> {
  const timeoutMs = opts?.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const concurrency = Math.max(1, opts?.concurrency ?? IMAGE_CONCURRENCY);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const results: ImageCheckResult[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      results[i] = await checkImageUrl(item.url, item.label, timeoutMs, fetchImpl);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Heuristic: the about text the generator emits when it has nothing real to say. */
function isPlaceholderAbout(data: PublicLandingData): boolean {
  const t = data.copy.aboutText.trim();
  if (!t) return true;
  return t.startsWith(`${data.business.name} — contact us to learn more`);
}

/**
 * Pure assembly of the checklist from loaded landing data + image results.
 * Unit-testable without network or database.
 */
export function evaluateQuality(
  data: PublicLandingData,
  imageResults: ImageCheckResult[],
  checkedAt = new Date().toISOString()
): LandingQualityStatus {
  const checks: LandingQualityCheck[] = [];
  const meta = buildLandingMeta(data);

  // -- SEO -----------------------------------------------------------
  checks.push({
    id: "seo.title",
    label: "Page title",
    status: meta.title.trim() ? "pass" : "fail",
    detail: meta.title.trim() ? `“${meta.title.slice(0, 80)}”` : "Missing page title.",
  });
  checks.push({
    id: "seo.description",
    label: "Meta description",
    status: meta.description.trim() ? "pass" : "fail",
    detail: meta.description.trim()
      ? `${meta.description.slice(0, 110)}${meta.description.length > 110 ? "…" : ""}`
      : "Missing meta description.",
  });
  checks.push({
    id: "seo.og-image",
    label: "Social share image (OG)",
    status: meta.ogImage ? "pass" : "warn",
    detail: meta.ogImage
      ? "Logo will be used when the page is shared."
      : "No logo set — shares will show no preview image. Add a logo URL in Branding.",
  });

  // -- Branding ------------------------------------------------------
  checks.push({
    id: "branding.logo",
    label: "Business logo",
    status: data.business.logoUrl ? "pass" : "warn",
    detail: data.business.logoUrl
      ? "Custom logo is set."
      : "No logo URL — the page shows a monogram with your business initial instead.",
  });

  // -- Images --------------------------------------------------------
  for (const r of imageResults) {
    checks.push({
      id: `images.${r.label === "logo" ? "logo" : `product:${r.label.slice(0, 40)}`}`,
      label: r.label === "logo" ? "Logo image loads" : `Image loads: ${r.label}`,
      status: r.ok ? "pass" : "fail",
      detail: r.ok
        ? `HTTP ${r.status} — ${r.url.slice(0, 90)}`
        : `BROKEN (${r.error ?? "unknown error"}) — ${r.url.slice(0, 90)}`,
    });
  }

  // -- Sections ------------------------------------------------------
  checks.push({
    id: "sections.hero",
    label: "Hero section",
    status: data.business.name.trim() && data.copy.tagline.trim() ? "pass" : "fail",
    detail: "Business name, tagline, and chat CTA render in the hero.",
  });
  checks.push({
    id: "sections.products",
    label: "Products section",
    status: data.products.length > 0 ? "pass" : "warn",
    detail:
      data.products.length > 0
        ? `${data.products.length} item${data.products.length === 1 ? "" : "s"} across ${data.productGroups.length} categor${data.productGroups.length === 1 ? "y" : "ies"}.`
        : "No products yet — the products section is hidden until you add items in Catalog.",
  });
  checks.push({
    id: "sections.about",
    label: "About section",
    status: isPlaceholderAbout(data) ? "warn" : "pass",
    detail: isPlaceholderAbout(data)
      ? "About text is a placeholder — add a business description or an About knowledge entry."
      : "About text is present.",
  });
  const testimonialCount = data.aboutEntries.filter((e) =>
    /testimonial|review/i.test(`${e.category ?? ""} ${e.title}`)
  ).length;
  checks.push({
    id: "sections.testimonials",
    label: "Testimonials section",
    status: "pass",
    detail:
      testimonialCount > 0
        ? `${testimonialCount} testimonial${testimonialCount === 1 ? "" : "s"} will be shown.`
        : "Hidden — add knowledge entries tagged as testimonials to show this section.",
  });
  checks.push({
    id: "sections.contact",
    label: "Contact section",
    status: "pass",
    detail: "Chat CTA, hours, and direct channels render in the contact section.",
  });
  checks.push({
    id: "sections.contact-channels",
    label: "Direct contact channels",
    status: data.contact.whatsappPhone || data.contact.email ? "pass" : "warn",
    detail:
      data.contact.whatsappPhone || data.contact.email
        ? "WhatsApp and/or email is listed."
        : "No WhatsApp number or email — visitors can only reach you through chat.",
  });
  checks.push({
    id: "sections.hours",
    label: "Opening hours",
    status: data.hours ? "pass" : "warn",
    detail: data.hours
      ? `${Object.keys(data.hours).length} day${Object.keys(data.hours).length === 1 ? "" : "s"} listed.`
      : "No hours set — the page says the chat assistant is available 24/7.",
  });
  checks.push({
    id: "sections.widget",
    label: "Chat widget",
    status: data.business.siteKey ? "pass" : "fail",
    detail: data.business.siteKey
      ? "Your chat widget (site key) is embedded on the page."
      : "Missing site key — the chat widget cannot load.",
  });

  // -- Contrast (WCAG-ish: fail < 3.0, warn < 4.5) --------------------
  for (const pair of themeContrastPairs(data.theme, data.business.brandColor)) {
    const ratio = contrastRatio(pair.fg, pair.bg);
    const status: QualityCheckStatus =
      ratio < 3 ? "fail" : ratio < 4.5 ? "warn" : "pass";
    checks.push({
      id: pair.id,
      label: pair.label,
      status: status === "fail" && pair.id === "contrast.muted" ? "warn" : status,
      detail: `Contrast ratio ${ratio.toFixed(2)}:1 (AA needs 4.5:1).`,
    });
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  return {
    slug: data.business.slug,
    theme: data.theme,
    ready: fails === 0,
    fails,
    warnings,
    checks,
    checkedAt,
  };
}

/**
 * Full gate: load the page data (fail-closed on unknown slug), check every
 * image, and evaluate. Returns null when the slug has no landing page.
 */
export async function checkLandingQuality(
  slug: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<LandingQualityStatus | null> {
  const data = await getLandingData(slug);
  if (!data) return null;

  const images: Array<{ url: string; label: string }> = [];
  if (data.business.logoUrl) images.push({ url: data.business.logoUrl, label: "logo" });
  const seen = new Set<string>();
  for (const p of data.products) {
    if (p.imageUrl && !seen.has(p.imageUrl)) {
      seen.add(p.imageUrl);
      images.push({ url: p.imageUrl, label: p.name });
    }
  }
  const imageResults = await checkImageUrls(images, opts);
  return evaluateQuality(data, imageResults);
}

/**
 * Compact summary the dashboard persists via PUT /api/landing
 * (`landingQuality`) after a check runs — the "record the status" step.
 */
export function summarizeQualityForRecord(status: LandingQualityStatus): {
  ready: boolean;
  fails: number;
  warnings: number;
  checkedAt: string;
} {
  return {
    ready: status.ready,
    fails: status.fails,
    warnings: status.warnings,
    checkedAt: status.checkedAt,
  };
}
