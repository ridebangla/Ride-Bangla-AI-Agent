/**
 * tenant-logo.ts — tenant business-logo resolution (Team Logo-Feature,
 * 2026-11-03).
 *
 * One stored field, Business.logoUrl, is the tenant's OWN logo. It is
 * written by the tenant themselves from the dashboard (Landing settings
 * PUT /api/landing, or Profile PUT /api/profile — both require
 * settings:update and update ONLY `where: { id: auth.businessId }`).
 * It is read back server-side, never client-supplied, for:
 *   - the dashboard (Profile page + header user menu, via GET /api/profile)
 *   - the public landing page /p/[slug] (already rendered it)
 *   - the customer widget header (GET /api/widget/identity, resolved
 *     from the siteKey's business — see that route)
 *
 * This module is the single validation gate for READS. Writes validate
 * again at their own route (landing/profile), so a value that somehow
 * reached storage unvalidated (old row, pasted URL) can never be
 * echoed to a customer surface as a javascript: URL, a non-image data
 * URL, or an unbounded string. Invalid / absent => null, and every
 * surface falls back to the business initial — never to another
 * tenant's logo, never to the platform default, never to a broken
 * <img>.
 *
 * Deliberately NOT the platform agent brand: GET /api/widget/brand
 * serves Firestore agent_brand/current (the Super Admin's agent
 * character — mascot bust/videos, one change everywhere). That record
 * has no tenant dimension and is untouched here; the widget keeps the
 * mascot as its agent avatar and shows the tenant logo as a separate
 * header badge (see public/widget/ride-bangla-chat.js).
 *
 * Sizing rule for logo surfaces (not profile photos): logos are
 * arbitrary-aspect marks, and the cropper lets a tenant pick a free /
 * wide crop — so logo <img> elements MUST use object-fit: contain
 * (whole mark visible, letterboxed on white), never object-fit: cover
 * (which centre-crops a wide logo's sides off in a square box).
 * Profile photos stay object-fit: cover — a face in a circle is a
 * different element and is untouched by this rule.
 */

import { checkImageDataUrl } from "@/lib/data-url";

const HTTP_URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
export const MAX_TENANT_LOGO_HTTP_CHARS = 500;

/**
 * Resolve a stored logoUrl to a safe display value, or null when there
 * is no usable tenant logo. Accepts exactly what the write routes
 * accept: an http(s) URL (max 500 chars) or a PNG/JPEG/WebP image data
 * URL within the Firestore-safe cap (see src/lib/data-url.ts).
 * Anything else — javascript:, data:text/*, ftp:, overlong, non-string
 * — resolves to null, never to a substituted mark.
 */
export function resolveTenantLogoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith("data:")) {
    return checkImageDataUrl(v).ok ? v : null;
  }
  if (v.length > MAX_TENANT_LOGO_HTTP_CHARS) return null;
  return HTTP_URL_RE.test(v) ? v : null;
}

/** True when the stored value resolves to a displayable tenant logo. */
export function hasTenantLogo(value: unknown): boolean {
  return resolveTenantLogoUrl(value) !== null;
}

/**
 * Fallback initial for a business with no logo: first character of the
 * business name, upper-cased; "?" when no usable name exists. Surfaces
 * render this monogram instead of any image when resolveTenantLogoUrl
 * returns null, so a missing logo can never render as a broken image.
 */
export function tenantLogoInitial(name: unknown): string {
  if (typeof name !== "string") return "?";
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}
