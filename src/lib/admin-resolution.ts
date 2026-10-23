/**
 * admin-resolution.ts — deterministic sign-in account resolution.
 *
 * WHY THIS EXISTS (owner rule 2026-10-21): the company's holder account
 * (info@ridebangla.bd) exists on this platform as MORE THAN ONE admin
 * record sharing the same email — the platform Super Admin record and
 * the tenant admin of the internal "Ride Bangla" business. Both sign-in
 * routes used to take `findMany({ email })[0]`, whose order the data
 * layer does not guarantee: the owner could land on either record
 * depending on datastore ordering, and a Google sign-in from the signup
 * page could be mistaken for a brand-new customer.
 *
 * Resolution order (first match wins), identical on every path:
 *   1. The record whose `firebaseUid` equals the VERIFIED token's uid —
 *      the strongest binding: the credential itself names the account.
 *   2. The record whose business carries `isInternalAccount === true`
 *      (the holder/owner account — see subscription.ts). This is what
 *      makes Google sign-in land the owner on his business even when the
 *      Google-minted Firebase uid differs from the one the tenant record
 *      was created with: the token's email is Google-VERIFIED at that
 *      point (the callers enforce it), and the record it resolves to is
 *      the one the platform itself flags as the company's own.
 *   3. The earliest-created record — today's behaviour for the normal
 *      single-account case, made deterministic.
 *
 * This module NEVER creates anything and NEVER trusts a client-supplied
 * string: callers pass only claims from an Admin-SDK-verified ID token
 * plus rows read from the database.
 */
import type { Admin, Business } from "@/lib/models";
import { isDatastoreQuotaError } from "@/lib/auth";
import { logger } from "@/lib/logger";

type Db = {
  admin: {
    findMany: (args: Record<string, unknown>) => Promise<Admin[]>;
  };
  business: {
    findUnique: (args: Record<string, unknown>) => Promise<Business | null>;
  };
};

/** All admin records carrying this (already-normalised) email. */
export async function findAdminsByEmail(
  db: Db,
  email: string
): Promise<Admin[]> {
  const rows = await db.admin.findMany({
    where: { email } as Record<string, unknown>,
  });
  return Array.isArray(rows) ? rows : [];
}

/**
 * True only when the admin's business doc itself carries the internal
 * flag as a literal boolean true — the same strict test subscription.ts
 * and billing-usage.ts apply ("true" / 1 / truthy objects do NOT count).
 */
export async function isInternalAdmin(
  db: Db,
  admin: Admin
): Promise<boolean> {
  if (!admin.businessId) return false;
  try {
    const biz = await db.business.findUnique({
      where: { id: admin.businessId },
    });
    return !!biz && biz.isInternalAccount === true;
  } catch (err) {
    logger.warn(
      `[Auth] isInternalAdmin lookup failed for business ${admin.businessId}: ${
        err instanceof Error ? err.message : "unknown"
      }`
    );
    return false;
  }
}

function createdAtMs(admin: Admin): number {
  const raw = (admin as { createdAt?: unknown }).createdAt;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string" || typeof raw === "number") {
    const t = new Date(raw).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

function byCreatedAt(a: Admin, b: Admin): number {
  const diff = createdAtMs(a) - createdAtMs(b);
  if (diff !== 0) return diff;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Pick THE admin record a verified sign-in lands on, from the records
 * that carry the token's email. `firebaseUid` is the uid claim of the
 * verified token (never a request-body field). Returns null only for an
 * empty candidate list (callers keep their existing fail-closed paths).
 */
export async function pickSignInAdmin(
  db: Db,
  candidates: Admin[],
  firebaseUid?: string | null
): Promise<Admin | null> {
  if (!candidates || candidates.length === 0) return null;
  const sorted = [...candidates].sort(byCreatedAt);

  if (firebaseUid) {
    const uidMatch = sorted.find(
      (a) =>
        typeof (a as { firebaseUid?: unknown }).firebaseUid === "string" &&
        (a as { firebaseUid?: unknown }).firebaseUid === firebaseUid
    );
    if (uidMatch) return uidMatch;
  }

  for (const candidate of sorted) {
    if (await isInternalAdmin(db, candidate)) return candidate;
  }

  return sorted[0];
}

// ---------------------------------------------------------------------------
// Q-SIGNIN (2026-10-23): quota-outage sign-in fallback.
//
// The admins-by-email read is the ONE indispensable Firestore read on
// the sign-in path: the session JWT carries the admin doc's id + role,
// which exist nowhere else — minting a session without them would mean
// FABRICATING a role (fail-closed forbids it). So when that read fails
// with RESOURCE_EXHAUSTED and this instance has never resolved the
// account, sign-in still answers the honest 503.
//
// But when this instance HAS resolved the exact (email, firebaseUid)
// pair before, the proven record is remembered (process memory only)
// and a quota failure falls back to it: sign-in completes with EXACTLY
// the id/role that were proven against the database — never elevated,
// never invented, and never for an (email, uid) pair that was not
// itself resolved. The normal path NEVER reads the cache: every
// successful data-layer read re-resolves fresh and refreshes the
// memory. The fallback can only engage while Firestore is rejecting
// operations — a window in which platform writes (role changes,
// revocations recorded in the data store) cannot land either.
// ---------------------------------------------------------------------------

export const SIGNIN_RESOLUTION_FALLBACK_TTL_MS = 2 * 60 * 60 * 1000;

const signInResolutionMemory = new Map<
  string,
  { admin: Admin; at: number }
>();

function signInResolutionKey(email: string, firebaseUid?: string | null): string {
  return `${email}|${firebaseUid ?? ""}`;
}

/** Remember a resolution that was just proven against the database. */
export function rememberSignInResolution(
  email: string,
  firebaseUid: string | null | undefined,
  admin: Admin
): void {
  signInResolutionMemory.set(signInResolutionKey(email, firebaseUid), {
    admin,
    at: Date.now(),
  });
}

/** The remembered resolution for this exact (email, uid) pair, if fresh. */
export function recallSignInResolution(
  email: string,
  firebaseUid: string | null | undefined,
  nowMs: number = Date.now()
): Admin | null {
  const hit = signInResolutionMemory.get(signInResolutionKey(email, firebaseUid));
  if (!hit) return null;
  if (nowMs - hit.at > SIGNIN_RESOLUTION_FALLBACK_TTL_MS) return null;
  return hit.admin;
}

/** Test seam (mirrors __resetCompanyIdentityCacheForTests). */
export function __resetSignInResolutionMemoryForTests(): void {
  signInResolutionMemory.clear();
}

/**
 * The sign-in routes' resolution entry point: fresh database resolution
 * first (findAdminsByEmail + pickSignInAdmin, unchanged semantics); on a
 * QUOTA failure only, fall back to the remembered proven resolution for
 * the same (email, uid) and report `degraded: true`. Any other error —
 * and a quota failure with nothing remembered — propagates to the
 * caller, whose existing honest-503 mapping handles it.
 */
export async function resolveSignInAdmin(
  db: Db,
  email: string,
  firebaseUid?: string | null
): Promise<{ admin: Admin | null; degraded: boolean }> {
  try {
    const candidates = await findAdminsByEmail(db, email);
    const admin =
      candidates.length > 0
        ? await pickSignInAdmin(db, candidates, firebaseUid)
        : null;
    if (admin) rememberSignInResolution(email, firebaseUid, admin);
    return { admin, degraded: false };
  } catch (err) {
    if (isDatastoreQuotaError(err)) {
      const remembered = recallSignInResolution(email, firebaseUid);
      if (remembered) {
        logger.warn(
          `[Auth] Sign-in resolution degraded: data store quota-exhausted; ` +
            `using the proven resolution for ${email} from this instance's memory`
        );
        return { admin: remembered, degraded: true };
      }
    }
    throw err;
  }
}
