/**
 * meta-oauth-state.ts — signed OAuth `state` for the Meta connect flow.
 *
 * A-to-Z audit 2026-10-20 (HIGH fix): the state used to be a bare
 * base64url JSON blob `{ businessId, nonce: Date.now() }` and the callback
 * trusted it without any signature or session check — anyone could forge
 * a state naming ANY businessId and bind their own Facebook/Instagram
 * pages into that tenant on the callback. The state is now HMAC-SHA256
 * signed with a server-only secret (META_APP_SECRET, falling back to
 * JWT_SECRET) and carries an issued-at timestamp; the callback verifies
 * the signature (timing-safe) and rejects states older than 30 minutes.
 * Only the authenticated connect route can mint a valid state.
 */
import { createHmac, timingSafeEqual } from "crypto";

const MAX_AGE_MS = 30 * 60 * 1000;

function secret(): string | null {
  return process.env.META_APP_SECRET || process.env.JWT_SECRET || null;
}

function sign(payloadB64: string, key: string): string {
  return createHmac("sha256", key).update(payloadB64).digest("base64url");
}

export function createMetaOAuthState(businessId: string): string | null {
  const key = secret();
  if (!key) return null;
  const payload = Buffer.from(
    JSON.stringify({ businessId, iat: Date.now(), nonce: Math.random().toString(36).slice(2) })
  ).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export function verifyMetaOAuthState(state: string): { businessId: string } | null {
  const key = secret();
  if (!key || typeof state !== "string") return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = sign(payload, key);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      businessId?: unknown;
      iat?: unknown;
    };
    if (typeof parsed.businessId !== "string" || !parsed.businessId) return null;
    if (typeof parsed.iat !== "number" || Date.now() - parsed.iat > MAX_AGE_MS || parsed.iat > Date.now() + 60_000) {
      return null;
    }
    return { businessId: parsed.businessId };
  } catch {
    return null;
  }
}
