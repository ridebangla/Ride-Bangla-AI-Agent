import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import {
  clearAuthCookie,
  clearRefreshCookie,
  decodeRefreshPayload,
  generateRefreshToken,
  generateToken,
  getRefreshCookieName,
  isDatastoreQuotaError,
  revokeToken,
  setSessionCookies,
  verifyRefreshToken,
  verifySessionToken,
  wasRevokedWithinGrace,
} from "@/lib/auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/auth/restore?next=<path> — silent session restore.
 *
 * The login-once fix (2026-10-21): the access cookie lives 1h, the
 * rotating refresh cookie 30d. Middleware bounces a page load whose
 * access token is missing/expired (but which carries a refresh cookie)
 * here instead of to /login. This handler performs the SAME exchange as
 * POST /api/auth {action:"refresh"} — refresh-token signature + type +
 * revocation verified against the DB, old refresh jti revoked (rotation),
 * admin must still exist — then redirects back to `next` with a fresh
 * cookie pair. Any failure clears both cookies and lands on /login,
 * exactly the pre-fix behaviour, so a dead session can never loop:
 * without a refresh cookie middleware never bounces here, and a failed
 * restore removes the cookie that triggered the bounce.
 *
 * `next` is validated to a same-origin path (no open redirect).
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (raw.length > 512) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  if (raw.startsWith("/api/auth")) return "/dashboard";
  return raw;
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get("next"));

  const toLogin = () => {
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.set(clearAuthCookie());
    response.cookies.set(clearRefreshCookie());
    // Middleware expires the legacy Path=/api/auth refresh identity on
    // this same response (single-cookie-per-name limit — see lib/auth).
    return noStore(response);
  };

  try {
    // Access cookie still valid (e.g. a second tab raced us) — nothing
    // to exchange, just continue to the destination.
    const accessToken = request.cookies.get("rbai-token")?.value;
    if (accessToken && (await verifySessionToken(accessToken))) {
      return noStore(NextResponse.redirect(new URL(next, request.url)));
    }

    const refreshTokenValue = request.cookies
      .get(getRefreshCookieName())
      ?.value;
    if (!refreshTokenValue) return toLogin();

    // Performance: the revocation check (verifyRefreshToken) and the
    // admin lookup are INDEPENDENT — both key off the refresh token's
    // own claims (userId comes from the token's signature, decoded
    // locally by decodeRefreshPayload with no DB read) and neither
    // consumes the other's result — so they run in one window instead
    // of two sequential DB windows. Outcome preservation:
    //  - a revoked/invalid token still lands on toLogin() and the
    //    admin row is never used (discarded, never trusted);
    //  - a throwing revocation read rethrows into the catch below,
    //    preserving the quota branch (cookies preserved) and the
    //    fail-closed toLogin() for other errors exactly; a throwing
    //    admin read rethrows only when the token itself verified —
    //    for a revoked token it is discarded, as the old code never
    //    ran the lookup then;
    //  - rotation, revocation and expiry checks are untouched:
    //    verifyRefreshToken still performs signature + type +
    //    revocation, and nothing here mints a session on its own.
    // (When the token fails even local signature/type decoding, no
    // admin read runs at all — matching the old path, where the admin
    // lookup never ran for an invalid token.)
    const decoded = decodeRefreshPayload(refreshTokenValue);
    const [refreshResult, adminResult] = await Promise.allSettled([
      verifyRefreshToken(refreshTokenValue),
      decoded
        ? getUnscopedPrisma().admin.findUnique({
            where: { id: decoded.userId },
            select: {
              id: true,
              role: true,
              twoFactorEnabled: true,
              twoFactorActivatedAt: true,
            } as Record<string, unknown>,
          })
        : Promise.resolve(null),
    ]);
    if (refreshResult.status === "rejected") throw refreshResult.reason;
    const payload = refreshResult.value;
    if (!payload) {
      // Rotation race (session-persistence fix, 2026-10-22): another
      // tab rotated this exact token moments ago and its fresh cookie
      // pair is already in the browser. Do NOT clear those cookies and
      // do NOT bounce to /login — just continue to the destination;
      // the browser's current pair authenticates the load, and if it
      // somehow does not, the next load fails closed to /login as
      // before. The old token itself is never honoured here.
      const raced = decodeRefreshPayload(refreshTokenValue);
      if (raced?.jti && (await wasRevokedWithinGrace(raced.jti))) {
        return noStore(NextResponse.redirect(new URL(next, request.url)));
      }
      return toLogin();
    }

    // Only now is the admin result needed: a null payload above
    // returned before this point, so a failing admin read for a
    // revoked token is discarded exactly as before (the old code
    // never ran the lookup then). For a VERIFIED token, a failing
    // admin read rethrows into the catch below (quota branch intact).
    if (adminResult.status === "rejected") throw adminResult.reason;
    const admin = adminResult.value;
    if (!admin) return toLogin();

    // TEAM 2FA (2026-11-03) — restore-chain kill, delimited addition:
    // same rule as POST /api/auth {action:"refresh"}: a refresh token
    // minted before 2FA activation must not restore a session past the
    // challenge. Revoke it and land on /login (cookies cleared there).
    {
      const a = admin as unknown as {
        twoFactorEnabled?: unknown;
        twoFactorActivatedAt?: unknown;
      };
      const activatedMs = a.twoFactorActivatedAt
        ? new Date(a.twoFactorActivatedAt as string | number | Date).getTime()
        : NaN;
      if (
        a.twoFactorEnabled === true &&
        !Number.isNaN(activatedMs) &&
        payload.iat &&
        payload.iat * 1000 < activatedMs
      ) {
        await revokeToken(
          payload.jti,
          new Date(
            (payload.exp ?? 0) * 1000 || Date.now() + 30 * 24 * 3600 * 1000
          )
        );
        return toLogin();
      }
    }

    // Rotation: the presented refresh token is single-use from here.
    await revokeToken(
      payload.jti,
      new Date(
        (payload.exp ?? 0) * 1000 || Date.now() + 30 * 24 * 3600 * 1000
      )
    );

    const token = generateToken(admin.id, admin.role);
    const newRefreshToken = generateRefreshToken(admin.id, admin.role);

    const response = NextResponse.redirect(new URL(next, request.url));
    setSessionCookies(response, token, newRefreshToken);
    return noStore(response);
  } catch (err) {
    // Q-SIGNIN (2026-10-23): a QUOTA failure is not a dead session —
    // the data store rejected the read, so nothing about the refresh
    // token was actually proven either way. Send the user to /login
    // WITHOUT clearing the cookies: clearing them would destroy the
    // 30-day chain for the whole outage and force a full sign-in
    // (which itself faces the quota wall) once the store recovers.
    // The preserved cookie pair lets the very next load restore
    // silently as soon as reads succeed again. No session is minted
    // here — entry stays fail-closed, only the chain survives.
    if (isDatastoreQuotaError(err)) {
      logger.warn(
        `[Auth] Session restore deferred (data store quota-exhausted) — cookies preserved`
      );
      return noStore(NextResponse.redirect(new URL("/login", request.url)));
    }
    // Fail closed: a restore that cannot complete is a login, never a
    // half-session. (DB hiccup => the user signs in once; the next
    // successful login re-establishes the 30-day chain.)
    logger.warn(
      `[Auth] Session restore failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    return toLogin();
  }
}
