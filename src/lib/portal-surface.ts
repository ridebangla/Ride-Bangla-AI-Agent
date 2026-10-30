/**
 * portal-surface.ts — the ONE place that decides whether a widget turn
 * is a "portal" turn (the Ride Bangla AI Agent product speaking as
 * itself on its own site) rather than a tenant turn.
 *
 * THE PORTAL RULE (owner-escalated AI-site fix, 2026-10-30):
 *   portal = isCompanyBusiness AND origin host == "ai.ridebangla.bd"
 * where isCompanyBusiness =
 *   business.isInternalAccount === true
 *   OR business.id is listed in company_identity/current.aiBusinessIds.
 *
 * WHY BOTH CONDITIONS (do not weaken either):
 * - The company business's siteKey is embedded on MORE than one own
 *   site: the AI homepage AND Main, Studio, Tools and IT all embed the
 *   SAME company siteKey. A flag-only rule would flip Main's widget
 *   to portal mode too and break the one correct site — that design
 *   was explicitly REJECTED.
 * - The origin host is the request's own Origin/Referer host,
 *   server-resolved only. It is NEVER a client-supplied body field:
 *   a body `source` value is metadata only and must never decide
 *   identity (it is caller-controlled). Only the Origin/Referer
 *   headers, parsed exactly like the widget route's existing
 *   sourceSite parsing (host only, no path/query), count here.
 *
 * LIVE-DATA DEPENDENCY (stated plainly, not papered over): if live
 * data has NEITHER isInternalAccount=true on the company business
 * NOR its id in aiBusinessIds, this rule resolves portal=false and
 * the AI site keeps today's tenant behaviour until the company-flag
 * step is done. Nothing here invents a flag, a business, or a key.
 *
 * PURE MODULE: no imports, no DB, no network. The widget chat route
 * and the widget identity route both call resolvePortalSurface with
 * server-resolved inputs; the unit traces execute this file directly.
 */

/** The only origin host on which a company business speaks as portal. */
export const PORTAL_ORIGIN_HOST = "ai.ridebangla.bd";

/**
 * Plan NAMES only, from the platform's own public catalogue
 * (src/app/page.tsx plan cards: Starter, Growth, Pro). Prices,
 * feature lists and setup steps are deliberately NOT in this module
 * and must never be added here without owner approval — a portal
 * turn may name the plans and nothing more about them.
 */
export const PORTAL_PLAN_NAMES: readonly string[] = [
  "Starter",
  "Growth",
  "Pro",
];

/** The single line a portal turn may add to its identity prompt. */
export const PORTAL_PLAN_NAMES_LINE =
  "Available plans (names only): Starter, Growth, Pro.";

/**
 * VERIFIER FIX (2026-10-30): the ONLY tools a portal turn may be
 * offered. Every other agent tool operates on the current business's
 * data (show_products/search_catalog return the company catalog,
 * take_order/request_booking write company orders/bookings), so
 * offering them on a portal turn would re-open the Main-content leak
 * through tool results even with an empty prompt. The two kept tools
 * are the product-support ticket flow: a portal visitor reporting a
 * problem with the AI Agent product itself reaches the Ride Bangla
 * team, which owns that product. The engine also refuses any other
 * tool call on a portal turn at execution time (fail-closed).
 */
export const PORTAL_TOOL_NAMES: readonly string[] = [
  "create_ticket",
  "assign_to_person",
];

/**
 * The portal turn's content scope, applied by the engine over the
 * company business's own settings/KB/catalog for that turn ONLY.
 * Every field is empty: a portal turn must not consume the company
 * business's Main-services description, knowledge, catalog brief,
 * business rules, or behaviour instructions. The engine spreads this
 * over the turn context; tenant turns never touch it.
 */
export const PORTAL_TURN_SCOPE = {
  businessDesc: "",
  agentBehavior: "",
  businessRulesSection: "",
  knowledgeBase: [] as never[],
  catalogBrief: "",
} as const;

/**
 * Parse an Origin/Referer header value to its host only, mirroring
 * the widget route's existing sourceSite parsing. Unparseable or
 * empty input yields "" (never a guess, never a path/query).
 */
export function originHostFromHeaderValue(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

/**
 * The request's origin host from its Origin/Referer headers.
 * `getHeader` is the request's header reader (NextRequest headers
 * in the routes). Origin wins; Referer is the fallback — the embed's
 * identity fetch from the AI site itself typically carries Referer
 * rather than Origin, so both must be honoured.
 */
export function requestOriginHost(
  getHeader: (name: string) => string | null
): string {
  return originHostFromHeaderValue(
    getHeader("origin") || getHeader("referer")
  );
}

export interface PortalSurfaceInput {
  /** Server-resolved business.isInternalAccount (strict true only). */
  isInternalAccount?: boolean | null;
  /** Server-resolved business id. */
  businessId?: string | null;
  /**
   * company_identity/current.aiBusinessIds, when readable; unknown
   * (read failed / not set) is [] — never a guessed membership.
   */
  aiBusinessIds?: readonly string[] | null;
  /** Server-parsed Origin/Referer host (host only). */
  originHost?: string | null;
}

/**
 * True exactly when the business is the company business AND the
 * request came from the AI site itself. Every other combination —
 * Main origin + company business, tenant origin + tenant business,
 * AI origin + tenant business, missing host — is a tenant turn.
 */
export function resolvePortalSurface(input: PortalSurfaceInput): boolean {
  if ((input.originHost ?? "") !== PORTAL_ORIGIN_HOST) return false;
  if (input.isInternalAccount === true) return true;
  const ids = input.aiBusinessIds ?? [];
  const id = input.businessId ?? "";
  return id !== "" && ids.includes(id);
}

/**
 * Extract a string array from an unknown company-identity doc shape
 * without ever throwing: a missing doc, a missing field, or a
 * non-array field all yield [] (portal then falls back to the
 * isInternalAccount leg only — fail-closed to tenant behaviour).
 */
export function companyAiBusinessIds(
  doc: { aiBusinessIds?: unknown } | null | undefined
): string[] {
  const ids = doc?.aiBusinessIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((v): v is string => typeof v === "string");
}
