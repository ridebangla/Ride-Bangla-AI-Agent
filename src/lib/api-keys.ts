/**
 * API key handling (H-15).
 *
 * Keys are NEVER stored in plaintext. Only a SHA-256 hash of the full key is
 * persisted (`keyHash`); the full key is shown exactly once, at creation
 * time, and must be copied then. Authentication hashes the presented key
 * and compares hashes (see `authenticateApiKey` in route-auth).
 *
 * Keys also carry per-key `scopes` (permission strings). A key may only use
 * the permissions in its scope list — the old behavior ("every API key gets
 * full admin") is removed. Keys created without explicit scopes get the
 * agent-role permission set: enough to work with conversations/messages/
 * tickets/customers, not enough to administer the system.
 */
import crypto from "crypto";
import { getPermissionsForRole, PERMISSIONS, Permission } from "@/lib/rbac";

/** SHA-256 hex digest of a presented API key. */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/** Last 8 characters of a key, stored so the UI can show a masked key. */
export function keySuffixOf(key: string): string {
  return key.slice(-8);
}

/** Masked display form built from the stored suffix (never the full key). */
export function maskApiKeySuffix(suffix: string): string {
  if (!suffix) return "********";
  return "*".repeat(8) + suffix;
}

/** Default scopes for keys created without an explicit scope list. */
export const DEFAULT_API_KEY_SCOPES: string[] = getPermissionsForRole("agent");

/** Validate a caller-supplied scope list. Returns an error message or null. */
export function validateScopes(scopes: unknown): string | null {
  if (!Array.isArray(scopes)) return "scopes must be an array of permission strings";
  if (scopes.length === 0) return "scopes must not be empty";
  for (const scope of scopes) {
    if (typeof scope !== "string" || !(scope in PERMISSIONS)) {
      return `Unknown permission in scopes: ${String(scope)}`;
    }
  }
  return null;
}

/** Strip the stored hash from an ApiKey row before sending it to a client. */
export function publicApiKey<T extends { keyHash?: string; keySuffix?: string }>(
  row: T
): Omit<T, "keyHash" | "keySuffix"> & { key: string } {
  const { keyHash: _dropped, keySuffix, ...rest } = row;
  void _dropped;
  return { ...rest, key: maskApiKeySuffix(keySuffix ?? "") };
}

export type { Permission };
