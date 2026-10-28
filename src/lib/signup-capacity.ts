/**
 * Signup capacity-class failure classification (moved out of the route
 * file 2026-10-28: Next 16 route modules may not export non-handler
 * symbols — the validator fails the build. Behaviour unchanged; the
 * route and its tests import this module now).
 */
import { isDatastoreQuotaError } from "@/lib/auth";

/**
 * Capacity-class failure (re-audit #3, R3-ai-1): the same honest-503
 * contract as /api/auth/google and /api/public/firebase-config. The
 * signup path's data layer is Firestore (via the Prisma shim) plus
 * Firebase Auth, so capacity surfaces as gRPC codes 8
 * (RESOURCE_EXHAUSTED) / 14 (UNAVAILABLE) — as a number, as a string,
 * or inside the message — or as the shared isDatastoreQuotaError
 * shapes. Anything else keeps the generic 500 below.
 */
export function isSignupCapacityError(err: unknown): boolean {
  if (isDatastoreQuotaError(err)) return true;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code).toLowerCase()
      : "";
  if (code === "8" || code === "14" || code === "unavailable") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /UNAVAILABLE/i.test(msg);
}
