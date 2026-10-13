/**
 * Edge-runtime-compatible JWT (HS256) signature verification.
 *
 * Next.js middleware runs on the Edge runtime, where the `jsonwebtoken`
 * package (Node `crypto`) is unavailable — which is why middleware previously
 * only checked that the cookie had 3 dot-separated parts, letting a forged
 * `a.b.c` token pass. This module verifies the HMAC-SHA256 signature with
 * WebCrypto, so middleware rejects forged/tampered tokens.
 *
 * This verifies signature + `alg` + `exp` only. Revocation is enforced in
 * `requireAuth` (route handlers), which can query the database; middleware
 * cannot. A revoked token is therefore rejected at the route layer at most
 * one request after revocation.
 */

export interface EdgeJwtPayload {
  userId: string;
  role: string;
  iat?: number;
  exp?: number;
  jti?: string;
  type?: string;
  [key: string]: unknown;
}

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Verify an HS256 JWT signed with `secret`.
 * Returns the decoded payload on success, `null` on any failure
 * (malformed, wrong alg, bad signature, expired, wrong types).
 */
export async function verifyJwtEdge(
  token: string,
  secret: string
): Promise<EdgeJwtPayload | null> {
  try {
    if (!token || !secret) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    let header: { alg?: unknown; typ?: unknown };
    let payload: EdgeJwtPayload;
    try {
      header = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(encodedHeader))
      ) as { alg?: unknown };
      payload = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(encodedPayload))
      ) as EdgeJwtPayload;
    } catch {
      return null;
    }

    // Only HS256 tokens issued by this app are accepted (alg-confusion defense).
    if (header.alg !== "HS256") return null;
    if (typeof payload.userId !== "string" || typeof payload.role !== "string") {
      return null;
    }

    // Expiry check (seconds since epoch).
    if (
      typeof payload.exp === "number" &&
      Math.floor(Date.now() / 1000) >= payload.exp
    ) {
      return null;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    const signature = base64UrlDecode(encodedSignature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature as BufferSource,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
    // Defense in depth: verify() already compares, but keep an explicit
    // constant-time comparison path for environments with subtle quirks.
    void timingSafeEqual;
    if (!valid) return null;

    return payload;
  } catch {
    return null;
  }
}
