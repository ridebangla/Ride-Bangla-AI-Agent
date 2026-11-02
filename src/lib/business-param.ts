/**
 * business-param.ts — propagate the dashboard's ?business=<slug>
 * selector to API calls (Super Admin flow).
 *
 * Server rule (src/lib/route-auth.ts): a Super Admin session has no
 * business of its own. With exactly one active business, calls resolve
 * into it automatically; with several, every call WITHOUT
 * ?business=<slug> is rejected 400 BUSINESS_REQUIRED ("Multiple
 * businesses exist — pass ?business=..."). Adding "business" to the
 * JSON body does NOT satisfy it — only the query string counts.
 *
 * Dashboard pages therefore read the slug from the page URL itself
 * (the documented Super Admin flow opens e.g.
 * /knowledge?business=<slug>) and append it to every API call via
 * withBusinessParam(). This reads window.location at call time (not
 * cached state), so client-side navigation stays correct, and it
 * needs no Suspense restructuring: during SSR prerender window is
 * undefined and calls go out exactly as before (no regression).
 *
 * errorText() exists for the companion crash: auth failures return
 * { error: { code, message } } (nested), while most route errors
 * return { error: "string" }. Passing the nested object into setState
 * and rendering it crashes React ("Objects are not valid as a React
 * child") — that is the Settings > Websites add crash.
 */

/** The ?business=<slug> selector from the current page URL, if any. */
export function getBusinessSlugFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const slug = new URLSearchParams(window.location.search).get("business");
    return slug && slug.trim() ? slug.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Append ?business=<slug> to an API URL when the page URL carries a
 * selector and the API URL does not already carry one. Returns the URL
 * unchanged when there is no selector (tenant sessions resolve their
 * own business server-side and must not gain a param).
 */
export function withBusinessParam(url: string): string {
  const slug = getBusinessSlugFromUrl();
  if (!slug) return url;
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  if (params.has("business")) return url;
  params.set("business", slug);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Renderable error string from an API error body: flat string errors
 * pass through; nested { error: { message } } auth failures yield
 * their message; anything else yields the fallback. Never returns an
 * object (rendering one crashes React).
 */
export function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err) return err;
    if (err && typeof err === "object") {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === "string" && msg) return msg;
    }
  }
  return fallback;
}
