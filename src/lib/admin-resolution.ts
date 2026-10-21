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
