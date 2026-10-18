/**
 * prisma.ts — compatibility shim.
 *
 * The Prisma/Postgres data layer has been replaced by the Firestore
 * data-access layer (`./firestore`, Firebase Admin SDK). This module keeps
 * the historical import path (`@/lib/prisma`) working: it re-exports the
 * Firestore-backed client under the exact same names (`prisma`,
 * `getUnscopedPrisma`, `runWithBusiness`, `enterBusinessContext`,
 * `getBusinessId`, `withBusinessId`, `withBusinessIdMany`,
 * `TenantContextError`) with identical fail-closed multi-tenancy semantics.
 *
 * New code should import from `@/lib/firestore` directly.
 */
export {
  prisma,
  getUnscopedPrisma,
  runWithBusiness,
  enterBusinessContext,
  getBusinessId,
  withBusinessId,
  withBusinessIdMany,
  TenantContextError,
  closeDb,
} from "./firestore";
export type { DbClient, ModelDelegate } from "./firestore";
