/**
 * comp.ts — first-class complimentary-access grant (comp) on a business.
 *
 * Canonical contract (identical across the AI platform, Studio and the
 * Admin Console — do not deviate): a `comp` map on businesses/{id}:
 *   {
 *     active: boolean,
 *     planId: string,
 *     startsAt, endsAt,            // Firestore timestamps
 *     reason: string,
 *     grantedBy: string,           // email
 *     grantedAt,
 *     source: "panel" | "referral" | "review" | "offer",
 *     referredBy?: string,
 *     requestId?: string,
 *     scope?: { features?: string[] },   // AI feature universe = ["chat"]
 *     snapshot: { exists: boolean, plan, subscriptionStatus,
 *                 billingInterval, subscriptionEndsAt, trialEndsAt,
 *                 isActive },
 *     revokedAt?, revokedBy?, revokeReason?,
 *   }
 *
 * The Admin panel writes comp AND the real activation fields (plan,
 * subscriptionStatus="active", subscriptionEndsAt=endsAt, isActive=true);
 * the resolvers in this repo ALSO read comp directly (belt-and-braces),
 * so a comp is honoured even if the mirrored fields drift.
 *
 * Auto-expire is purely by endsAt comparison — no cron.
 *
 * Pure helpers only (no DB imports): callers pass the business record
 * they already read. SERVER + CLIENT SAFE (no server-only imports).
 */

/** AI feature universe for scope checks. */
export const AI_FEATURES = ["chat"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export interface CompScope {
  features?: string[];
}

export interface CompGrant {
  active: boolean;
  planId: string;
  startsAt: Date | null;
  endsAt: Date | null;
  reason: string;
  grantedBy: string;
  grantedAt: Date | null;
  source: string;
  referredBy?: string;
  requestId?: string;
  scope?: CompScope;
}

type RecordLike = Record<string, unknown> | null | undefined;

function toDateValue(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof (v as { toDate?: unknown }).toDate === "function") {
    try {
      const d = (v as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function dateMs(v: unknown): number | null {
  const d = toDateValue(v);
  return d ? d.getTime() : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseScope(v: unknown): CompScope | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  const feats = rec.features;
  if (Array.isArray(feats)) {
    return {
      features: feats.filter(
        (f): f is string => typeof f === "string" && f.length > 0
      ),
    };
  }
  return {};
}

/**
 * Read + normalise the comp map from a business record. Returns null
 * when there is no usable comp map (absent, not an object, or no
 * planId). Timestamps are normalised to Date (or null when unparseable —
 * an unparseable bound fails closed in isCompActive).
 */
export function readComp(biz: RecordLike): CompGrant | null {
  if (!biz) return null;
  const raw = asRecord((biz as Record<string, unknown>).comp);
  if (!raw) return null;
  const planId =
    typeof raw.planId === "string" && raw.planId.trim() ? raw.planId.trim() : null;
  if (!planId) return null;
  const scope = parseScope(raw.scope);
  return {
    active: raw.active === true,
    planId,
    startsAt: toDateValue(raw.startsAt),
    endsAt: toDateValue(raw.endsAt),
    reason: typeof raw.reason === "string" ? raw.reason : "",
    grantedBy: typeof raw.grantedBy === "string" ? raw.grantedBy : "",
    grantedAt: toDateValue(raw.grantedAt),
    source: typeof raw.source === "string" ? raw.source : "",
    referredBy:
      typeof raw.referredBy === "string" && raw.referredBy
        ? raw.referredBy
        : undefined,
    requestId:
      typeof raw.requestId === "string" && raw.requestId
        ? raw.requestId
        : undefined,
    ...(scope ? { scope } : {}),
  };
}

/** Alias kept short for call sites that already hold a business record. */
export const getComp = readComp;

/**
 * True iff the business carries an ACTIVE comp at `nowMs`:
 * comp.active === true AND startsAt <= now < endsAt. A comp with a
 * missing/unparseable startsAt or endsAt is never active (fail-closed).
 */
export function isCompActive(
  biz: RecordLike,
  nowMs: number = Date.now()
): boolean {
  if (!biz) return false;
  const raw = asRecord((biz as Record<string, unknown>).comp);
  if (!raw || raw.active !== true) return false;
  const start = dateMs(raw.startsAt);
  const end = dateMs(raw.endsAt);
  if (start === null || end === null) return false;
  return start <= nowMs && nowMs < end;
}

/** The comp plan id when a comp is active at `nowMs`, else null. */
export function activeCompPlanId(
  biz: RecordLike,
  nowMs: number = Date.now()
): string | null {
  if (!isCompActive(biz, nowMs)) return null;
  const comp = readComp(biz);
  return comp ? comp.planId : null;
}

/** The active comp's period end (comp.endsAt), else null. */
export function activeCompEndsAt(
  biz: RecordLike,
  nowMs: number = Date.now()
): Date | null {
  if (!isCompActive(biz, nowMs)) return null;
  const comp = readComp(biz);
  return comp ? comp.endsAt : null;
}

/**
 * Extract a feature list from a scope-shaped value. Supports both
 * shapes seen in the contract:
 *   { features: ["chat", ...] }        — the canonical comp scope
 *   { chat: true, ... }                — a boolean grantScope map
 * Returns null when the value carries NO feature restriction at all
 * (absent, not an object, or an object with neither shape).
 */
function scopeFeaturesOf(v: unknown): string[] | null {
  const rec = asRecord(v);
  if (!rec) return null;
  if (Array.isArray(rec.features)) {
    return rec.features.filter(
      (f): f is string => typeof f === "string" && f.length > 0
    );
  }
  const boolKeys = Object.keys(rec).filter(
    (k) => typeof rec[k] === "boolean"
  );
  if (boolKeys.length > 0) {
    return boolKeys.filter((k) => rec[k] === true);
  }
  return null;
}

/**
 * Feature-scope gate (B6): true when the record's ACTIVE grant carries
 * no scope/features restriction, or when its restriction includes the
 * feature. False only when an active grant HAS a scope and that scope
 * excludes the feature.
 *
 * Active grants considered, in order:
 *   1. an active comp (comp.scope)
 *   2. an internal record (isInternalAccount === true) carrying a
 *      `grantScope` map (or a top-level `scope`)
 * A record with no active grant has no scope to enforce — true — so
 * unscoped accounts keep byte-identical behaviour (the subscription
 * gate is what blocks inactive accounts, not this helper).
 */
export function scopeAllows(
  record: RecordLike,
  feature: string,
  nowMs: number = Date.now()
): boolean {
  if (!record) return true;
  const rec = record as Record<string, unknown>;

  if (isCompActive(rec, nowMs)) {
    const comp = readComp(rec);
    const features = comp?.scope ? scopeFeaturesOf(comp.scope) : null;
    if (features === null) return true;
    return features.includes(feature);
  }

  if (rec.isInternalAccount === true) {
    const scoped = rec.grantScope ?? rec.scope;
    const features = scopeFeaturesOf(scoped);
    if (features === null) return true;
    return features.includes(feature);
  }

  // A comp exists but is not active: its scope does not govern.
  // Any grantScope on a non-internal, non-comped record likewise does
  // not govern — there is no active grant for it to scope.
  return true;
}
