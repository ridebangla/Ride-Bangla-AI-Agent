/**
 * website-url.ts — pure helpers for the business-websites feature
 * (owner directive 2026-10-21: a business can add ALL its websites —
 * 10 sites = 10 entries — and the agent learns from every one).
 *
 * No I/O here: URL normalization, duplicate detection and list merging
 * only, so the rules are unit-testable and shared by the tenant API,
 * onboarding confirm and the settings UI contract.
 */

export interface NormalizedWebsiteUrl {
  /** Canonical URL we store + fetch: scheme + lowercase host + path. */
  url: string;
  /** Lowercase hostname (no port, no www handling — kept as entered). */
  host: string;
  /**
   * Duplicate-detection key: lowercase host WITHOUT a leading "www.",
   * plus the path without a trailing slash. "example.com",
   * "www.example.com" and "https://example.com/" are the same website.
   */
  key: string;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedWebsiteUrl }
  | { ok: false; error: string };

const MAX_URL_LENGTH = 300;

export function normalizeWebsiteUrl(raw: unknown): NormalizeResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Please enter a website address." };
  }
  let input = raw.trim();
  if (!input) {
    return { ok: false, error: "Please enter a website address." };
  }
  if (input.length > MAX_URL_LENGTH) {
    return { ok: false, error: "That website address is too long." };
  }
  // Be forgiving about a missing scheme — business owners type
  // "mysite.com" far more often than "https://mysite.com".
  if (!/^https?:\/\//i.test(input)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      // Some other scheme was typed (ftp:, javascript:, …) — refuse it
      // rather than silently rewriting it.
      return {
        ok: false,
        error: "Only http:// or https:// website addresses are allowed.",
      };
    }
    input = "https://" + input;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "That website address doesn't look valid." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: "Only http:// or https:// website addresses are allowed.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: "Please enter the website address without a username or password.",
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || (!host.includes(".") && host !== "localhost")) {
    return {
      ok: false,
      error: "That website address doesn't look valid — check the domain name.",
    };
  }

  // Canonical form: default ports dropped (URL already normalizes them
  // away in .host only when explicit — rebuild by hand to be sure),
  // fragment dropped, root path collapsed to "/".
  const port =
    parsed.port &&
    !(
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    )
      ? `:${parsed.port}`
      : "";
  const path = parsed.pathname || "/";
  const url = `${parsed.protocol}//${host}${port}${path}${parsed.search}`;

  const keyHost = host.startsWith("www.") ? host.slice(4) : host;
  const keyPath = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const key = `${keyHost}${port}${keyPath}${parsed.search}`;

  return { ok: true, value: { url, host, key } };
}

/** Duplicate key for an already-stored URL (stored URLs are canonical). */
export function websiteKeyOf(url: string): string {
  const res = normalizeWebsiteUrl(url);
  return res.ok ? res.value.key : url.trim().toLowerCase();
}

export interface StoredWebsiteLike {
  id: string;
  url: string;
}

/**
 * Merge the stored website list with the legacy single `websiteUrl`
 * field. Businesses created before this feature have at most the legacy
 * field (set at signup or in the landing-page editor) and it was NEVER
 * scraped — so it enters the list as status "pending" (not yet learned),
 * never as a fake "indexed". Once a real list exists it wins outright.
 */
export function mergeWebsitesWithLegacy<
  T extends StoredWebsiteLike & { status: string },
>(
  stored: T[] | undefined | null,
  legacyUrl: string | undefined | null,
  makeLegacy: (url: string, host: string) => T
): T[] {
  if (Array.isArray(stored) && stored.length > 0) return stored;
  if (typeof legacyUrl === "string" && legacyUrl.trim()) {
    const res = normalizeWebsiteUrl(legacyUrl);
    if (res.ok) return [makeLegacy(res.value.url, res.value.host)];
  }
  return Array.isArray(stored) ? stored : [];
}

/** True when `candidate` (a dedupe key) already exists in the list. */
export function hasDuplicateWebsite(
  list: StoredWebsiteLike[],
  candidateKey: string
): boolean {
  return list.some((w) => websiteKeyOf(w.url) === candidateKey);
}
