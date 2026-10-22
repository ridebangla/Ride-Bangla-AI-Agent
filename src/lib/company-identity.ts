/**
 * company-identity.ts — estate-scoped company identity, AI read leg (B9).
 *
 * Canonical contract (identical across the AI platform, Studio and the
 * Admin Console — do not deviate): ONE shared Firestore doc
 * `company_identity/current`:
 *   {
 *     aiBusinessIds: string[],   // AI-platform business ids of the company
 *     studioUids: string[],      // Studio Firebase Auth uids of the company
 *     version: 1,
 *     updatedAt, updatedBy,
 *   }
 * The Admin Console writes it (Super Admin, same batch as the flag
 * write + audit). The per-platform flags (businesses/{id}
 * .isInternalAccount here) remain as a synchronised projection /
 * fallback: a business is COMPANY when its id is listed in
 * aiBusinessIds OR its own doc carries isInternalAccount === true.
 *
 * Read pattern: the repo's Admin-SDK access (getAdminDb, same as
 * plan-catalog / the widget brand record), with a short in-process TTL
 * cache. The TTL is 60s — the same value the widget brand record uses:
 * gates resolve per request, so an uncached read would burn one
 * Firestore read per chat message for EVERY tenant, while a long TTL
 * would delay a Super Admin revocation. 60s bounds revocation latency
 * to a minute per instance at one read per minute per instance.
 *
 * Fail-soft by contract: ANY read error (Admin SDK unconfigured,
 * Firestore down, malformed doc) degrades to the projection flag only
 * — an error is never treated as "company", and the resolver never
 * throws into a gate. An absent doc is the correct pre-migration
 * production state and resolves to empty lists. Error results are
 * cached for the same TTL (brand-record precedent) so a dead data
 * layer is not re-hit on every gate call.
 *
 * Spoof discipline: only strict boolean `true` on the business doc, or
 * exact string membership in aiBusinessIds, counts. Nothing
 * client-supplied is ever consulted — callers pass the server-resolved
 * business record (or its id, resolved server-side).
 *
 * SERVER-ONLY (Admin SDK + the unscoped data layer).
 */

import { getAdminDb } from "./admin-db";
import { getUnscopedPrisma } from "./prisma";
import { logger } from "./logger";

export interface CompanyIdentity {
  aiBusinessIds: string[];
  studioUids: string[];
  version: number | null;
}

const EMPTY_IDENTITY: CompanyIdentity = {
  aiBusinessIds: [],
  studioUids: [],
  version: null,
};

export const COMPANY_IDENTITY_TTL_MS = 60_000;

let cached: CompanyIdentity | null = null;
let cachedAt = 0;
let inflight: Promise<CompanyIdentity> | null = null;

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Load the shared company-identity record (TTL-cached, fail-soft).
 * Never throws; on any error returns the empty identity.
 */
export async function getCompanyIdentity(
  nowMs: number = Date.now()
): Promise<CompanyIdentity> {
  if (cached && nowMs - cachedAt < COMPANY_IDENTITY_TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    let identity = EMPTY_IDENTITY;
    try {
      const snap = await getAdminDb()
        .collection("company_identity")
        .doc("current")
        .get();
      const data = snap?.exists ? snap.data() : undefined;
      identity = {
        aiBusinessIds: parseIdList(data?.aiBusinessIds),
        studioUids: parseIdList(data?.studioUids),
        version:
          typeof data?.version === "number" && Number.isFinite(data.version)
            ? data.version
            : null,
      };
    } catch (err) {
      logger.warn(
        "[company-identity] shared record read failed — projection flags only",
        { error: err instanceof Error ? err.message : String(err) }
      );
      identity = EMPTY_IDENTITY;
    }
    cached = identity;
    cachedAt = Date.now();
    inflight = null;
    return identity;
  })();
  return inflight;
}

type RecordLike = Record<string, unknown> | null | undefined;

/**
 * Pure check against an already-loaded identity snapshot:
 * company ⇔ the record's flag is strict boolean true, OR its id is
 * listed in aiBusinessIds.
 */
export function isCompanyBusinessWithIdentity(
  record: RecordLike,
  identity: CompanyIdentity
): boolean {
  if (!record || typeof record !== "object") return false;
  if ((record as { isInternalAccount?: unknown }).isInternalAccount === true) {
    return true;
  }
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && identity.aiBusinessIds.includes(id);
}

/**
 * The B9 gate check. Accepts the server-resolved business record
 * (flag OR shared-list membership) or a bare business id (shared-list
 * membership, falling back to the business doc's own flag read
 * server-side). Never throws; a resolver error degrades to the
 * projection flag only — never to "company".
 */
export async function isCompanyBusiness(
  input: string | RecordLike
): Promise<boolean> {
  try {
    if (typeof input === "string") {
      if (!input) return false;
      const identity = await getCompanyIdentity();
      if (identity.aiBusinessIds.includes(input)) return true;
      // Projection fallback for the id form: the doc's own flag.
      try {
        const biz = (await getUnscopedPrisma().business.findUnique({
          where: { id: input },
          select: { isInternalAccount: true },
        })) as unknown as { isInternalAccount?: unknown } | null;
        return biz?.isInternalAccount === true;
      } catch {
        return false;
      }
    }
    if (!input || typeof input !== "object") return false;
    // Flag fast path: no shared-doc read needed (also what keeps the
    // pre-migration state — doc absent — at zero added reads for the
    // company's already-flagged record).
    if ((input as { isInternalAccount?: unknown }).isInternalAccount === true) {
      return true;
    }
    const identity = await getCompanyIdentity();
    return isCompanyBusinessWithIdentity(input, identity);
  } catch {
    // Last-resort: projection flag only, never "company" on error.
    return (
      !!input &&
      typeof input === "object" &&
      (input as { isInternalAccount?: unknown }).isInternalAccount === true
    );
  }
}

/** Test seam (mirrors __resetAdminDbForTests in admin-db.ts). */
export function __resetCompanyIdentityCacheForTests(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}
