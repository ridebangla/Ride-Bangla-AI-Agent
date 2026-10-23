import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import type { NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { logger } from "@/lib/logger";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV !== "test") {
    throw new Error(
      "JWT_SECRET environment variable is required. Set it before starting the application."
    );
  }
  return secret || "test-only-fallback-secret";
}

const JWT_SECRET = getJwtSecret();
const TOKEN_NAME = "rbai-token";
const REFRESH_TOKEN_NAME = "rbai-refresh";
// M-53: short-lived access tokens (1h) + refresh tokens (30d), instead of
// a single long-lived token with no revocation.
// Auth doctrine (user): login ONCE per device and stay logged in — the
// 30-day rotating refresh token keeps the session alive across browser
// restarts. PAYMENT gates activity, never the session itself: an expired
// trial / unpaid subscription still hard-stops at 402 even with a valid
// session (see the subscription checks in route handlers).
// Session restore (2026-10-21): the refresh token is exchanged silently —
// middleware bounces an expired-access page load to /api/auth/restore
// (full DB-checked rotation), and the dashboard SessionKeeper refreshes
// proactively while a tab stays open. Before this, NOTHING ever called
// the refresh exchange, so every session died with the 1h access token
// and the user had to sign in again on every visit.
const TOKEN_EXPIRY = "1h";
const REFRESH_TOKEN_EXPIRY = "30d";

// M-53: persistent per-account lockout — 5 failed logins → 15-minute lock.
// Stored in the DB (Admin.failedLoginAttempts / lockedUntil), so it cannot
// be defeated by switching tabs/IPs like the old in-memory 5/min/IP limit.
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

export interface JwtPayload {
  userId: string;
  role: string;
  jti: string;
  type: "access" | "refresh";
  iat?: number;
  exp?: number;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(userId: string, role: string): string {
  return jwt.sign(
    { userId, role, jti: randomUUID(), type: "access" },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

export function generateRefreshToken(userId: string, role: string): string {
  return jwt.sign(
    { userId, role, jti: randomUUID(), type: "refresh" },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

/**
 * Verify signature + expiry only (no DB). Use `verifySessionToken` for
 * authenticated requests — it additionally checks type + revocation.
 * Tokens issued before this change have no `type`; they are treated as
 * access tokens (they expire on their own within 7 days of issuance).
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<JwtPayload> & {
      userId: string;
      role: string;
    };
    if (!payload.userId || !payload.role) return null;
    return {
      userId: payload.userId,
      role: payload.role,
      jti: payload.jti ?? "",
      type: payload.type ?? "access",
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/** Verify an access token: signature + type + not revoked. */
export async function verifySessionToken(
  token: string
): Promise<JwtPayload | null> {
  const payload = verifyToken(token);
  if (!payload) return null;
  if (payload.type !== "access") return null;
  if (payload.jti && (await isTokenRevoked(payload.jti))) return null;
  return payload;
}

/** Verify a refresh token: signature + type + not revoked. */
export async function verifyRefreshToken(
  token: string
): Promise<JwtPayload | null> {
  const payload = verifyToken(token);
  if (!payload) return null;
  if (payload.type !== "refresh") return null;
  if (payload.jti && (await isTokenRevoked(payload.jti))) return null;
  return payload;
}

export async function isTokenRevoked(jti: string): Promise<boolean> {
  if (!jti) return false;
  const row = await getUnscopedPrisma().revokedToken.findUnique({ where: { jti } });
  return row !== null;
}

/**
 * Rotation grace (session-persistence fix, re-audit #2 2026-10-22).
 *
 * Refresh tokens are single-use (rotation): the first tab/request to
 * refresh revokes the presented jti and issues a new pair. A second
 * tab whose request was already in flight with the SAME jti then
 * presents a just-revoked token — indistinguishable from theft by the
 * revocation row alone. Without a grace, that second tab was treated
 * as a dead session: /api/auth/restore CLEARED the fresh cookies the
 * winning tab had just set (killing the real session), and the
 * SessionKeeper navigated to /login on the refresh action's 401.
 * That is exactly the "keep asking me to log in on this device"
 * defect the owner banned.
 *
 * The grace NEVER honours the old token and never issues anything —
 * it only lets the caller distinguish "revoked a moment ago by a
 * rotation" (benign race: do not destroy state, do not declare the
 * session dead; the browser's current cookie pair decides the next
 * step, fail-closed as always) from a genuinely dead session.
 */
export const ROTATION_GRACE_MS = 90 * 1000;

export async function wasRevokedWithinGrace(jti: string): Promise<boolean> {
  if (!jti) return false;
  const row = await getUnscopedPrisma().revokedToken.findUnique({
    where: { jti },
  });
  if (!row?.createdAt) return false;
  const age = Date.now() - new Date(row.createdAt).getTime();
  return age >= 0 && age < ROTATION_GRACE_MS;
}

/**
 * Decode a refresh token WITHOUT the revocation check (signature +
 * type only). Used solely to identify a rotation race for
 * wasRevokedWithinGrace — the result must never authenticate anyone.
 */
export function decodeRefreshPayload(token: string): JwtPayload | null {
  const payload = verifyToken(token);
  if (!payload || payload.type !== "refresh") return null;
  return payload;
}

/** Revoke a token by its `jti` (logout / refresh rotation). Idempotent. */
export async function revokeToken(jti: string, expiresAt: Date): Promise<void> {
  if (!jti) return;
  await getUnscopedPrisma().revokedToken.upsert({
    where: { jti },
    update: {},
    create: { jti, expiresAt },
  });
}

/**
 * True when an error is the data store's quota wall (Firestore
 * RESOURCE_EXHAUSTED, gRPC code 8) — Q-SIGNIN (2026-10-23). This is the
 * ONE detection the sign-in routes share; the widget route's FIX-A..D
 * degradation used the same signature in production logs
 * (`8 RESOURCE_EXHAUSTED: Quota exceeded.`). A quota error is an
 * INFRASTRUCTURE failure: per the owner's LIMIT-UX doctrine it must
 * never be reported as a credential failure and never block ENTRY —
 * it may only gate a read that is truly indispensable (named in
 * docs: the admins-by-email identity resolution on the sign-in POSTs).
 */
export function isDatastoreQuotaError(err: unknown): boolean {
  const errCode =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  const errMessage = err instanceof Error ? err.message : String(err ?? "");
  return (
    errCode === "8" ||
    errCode === "resource-exhausted" ||
    /RESOURCE_EXHAUSTED|quota exceeded/i.test(errMessage)
  );
}

/**
 * Entry-only session verification (Q-SIGNIN, 2026-10-23).
 *
 * `verifySessionToken` is the strict check every API route keeps using:
 * signature + type + revocation, with data-layer errors propagating.
 * ENTRY surfaces (dashboard layout, root page, GET /api/auth) use this
 * variant instead: when — and only when — the revocation READ fails
 * (the data store is down / quota-exhausted), entry falls back to the
 * cryptographic check alone (signature + type + expiry, exactly what
 * middleware's edge verify already trusts to route the request) and
 * reports `degraded: true`. The caller must render a degraded,
 * notice-carrying shell in that case and must NOT treat the session as
 * fully proven: no privilege is granted by this fallback — role-gated
 * DATA still resolves through the strict per-route checks
 * (requireAuth), which keep failing closed while the store is down.
 * A token that is definitively revoked / invalid / expired returns
 * `payload: null, degraded: false` exactly as the strict check does.
 */
export async function verifySessionTokenForEntry(
  token: string
): Promise<{ payload: JwtPayload | null; degraded: boolean }> {
  try {
    const payload = await verifySessionToken(token);
    return { payload, degraded: false };
  } catch (err) {
    const payload = verifyToken(token);
    if (payload && payload.type === "access") {
      logger.warn(
        `[Auth] Entry session check degraded (revocation read failed: ${
          err instanceof Error ? err.message : "unknown"
        }) — signature-only entry, no privileges granted by the fallback`
      );
      return { payload, degraded: true };
    }
    return { payload: null, degraded: false };
  }
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(TOKEN_NAME)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const admin = await getUnscopedPrisma().admin.findUnique({
    where: { id: payload.userId },
    select: { id: true, username: true, name: true, role: true },
  });

  return admin;
}

/**
 * getCurrentUser for ENTRY surfaces (Q-SIGNIN, 2026-10-23): when the
 * data-layer reads behind getCurrentUser throw (quota wall), a
 * signature-valid access token still proves ENTRY — return the minimal
 * identity the token itself carries (id + role) with `degraded: true`
 * so the caller can label the state honestly. Profile fields the token
 * does not carry come back empty — never invented. Definitive outcomes
 * (no token, bad token, revoked, admin gone) are unchanged: user null,
 * degraded false.
 */
export async function getCurrentUserForEntry(): Promise<{
  user: {
    id: string;
    username: string;
    name: string;
    role: string;
  } | null;
  degraded: boolean;
}> {
  try {
    const user = await getCurrentUser();
    return { user, degraded: false };
  } catch (err) {
    const cookieStore = await cookies();
    const token = cookieStore.get(TOKEN_NAME)?.value;
    const payload = token ? verifyToken(token) : null;
    if (payload && payload.type === "access") {
      logger.warn(
        `[Auth] getCurrentUser degraded (data read failed: ${
          err instanceof Error ? err.message : "unknown"
        }) — token-carried identity only`
      );
      return {
        user: {
          id: payload.userId,
          username: "",
          name: "",
          role: payload.role,
        },
        degraded: true,
      };
    }
    return { user: null, degraded: false };
  }
}

// Setup-state cache (Q-SIGNIN read-burn fix, 2026-10-23): isSetupComplete
// used to run admin.count() — a FULL admins-collection scan — on every
// GET /api/auth (login-page check on every load, SessionKeeper every
// 5 minutes per open tab). Two changes: (1) the probe is now an
// existence findFirst (with the data layer's bounded fetch it costs a
// single read), and (2) the answer is cached in-process — a POSITIVE
// answer for the process lifetime (an existing admin cannot un-exist
// short of a database wipe, and the setup ENDPOINT re-checks with
// `fresh: true` before creating anything), a negative answer for 30s
// (fresh installs still see setup promptly). On a read error the last
// known answer is served when one exists; with no cached answer the
// error propagates and the ENTRY caller degrades (see GET /api/auth).
let setupCompleteCache: { value: boolean; at: number } | null = null;
const SETUP_NEGATIVE_TTL_MS = 30_000;

export async function isSetupComplete(
  opts?: { fresh?: boolean }
): Promise<boolean> {
  const now = Date.now();
  if (!opts?.fresh && setupCompleteCache) {
    if (setupCompleteCache.value) return true;
    if (now - setupCompleteCache.at < SETUP_NEGATIVE_TTL_MS) return false;
  }
  try {
    const first = await getUnscopedPrisma().admin.findFirst({
      select: { id: true },
    });
    const value = first !== null && first !== undefined;
    setupCompleteCache = { value, at: now };
    return value;
  } catch (err) {
    if (setupCompleteCache) return setupCompleteCache.value;
    throw err;
  }
}

/** Test seam (mirrors __resetCompanyIdentityCacheForTests). */
export function __resetSetupCompleteCacheForTests(): void {
  setupCompleteCache = null;
}

/**
 * Whether the self-service `/api/auth` setup endpoint may run at all.
 * M-53: setup is DISABLED unless the operator explicitly enables it at
 * deploy time (`ALLOW_SETUP=true`). The first admin must be created with
 * the deploy-time seed (`npm run db:seed`), so a wiped/empty DB in
 * production can no longer be taken over via public setup.
 */
export function isSetupAllowed(): boolean {
  return process.env.ALLOW_SETUP === "true";
}

/**
 * Verify an hCaptcha token with the hCaptcha API (M-53).
 *
 * Enforcement is active when `HCAPTCHA_SECRET_KEY` is set. When it is not
 * set, login still works but a security warning is logged on every login
 * attempt — failing closed without keys would lock every operator out, so
 * the operator MUST set the keys (user action) and add the hCaptcha widget
 * (HCAPTCHA_SITEKEY) to the login form to activate CAPTCHA. The
 * verification code path itself is complete and tested.
 */
export async function verifyCaptcha(
  captchaToken: string | undefined | null,
  remoteIp?: string
): Promise<{ ok: boolean; error?: string }> {
  const secret = process.env.HCAPTCHA_SECRET_KEY;
  if (!secret) {
    logger.warn(
      "[Auth] CAPTCHA is NOT configured (HCAPTCHA_SECRET_KEY unset) — login proceeding without CAPTCHA. " +
        "Set HCAPTCHA_SECRET_KEY / HCAPTCHA_SITEKEY and add the widget to the login form."
    );
    return { ok: true };
  }
  if (!captchaToken) {
    return { ok: false, error: "CAPTCHA verification is required" };
  }
  try {
    const params = new URLSearchParams({ secret, response: captchaToken });
    if (remoteIp) params.set("remoteip", remoteIp);
    const res = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = (await res.json()) as { success?: boolean };
    if (data.success) return { ok: true };
    return { ok: false, error: "CAPTCHA verification failed" };
  } catch (error) {
    logger.error("[Auth] CAPTCHA verification error:", error);
    return { ok: false, error: "CAPTCHA verification failed" };
  }
}

export function setAuthCookie(token: string) {
  return {
    name: TOKEN_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60, // 1 hour — matches TOKEN_EXPIRY
    path: "/",
  };
}

export function clearAuthCookie() {
  return {
    name: TOKEN_NAME,
    value: "",
    httpOnly: true,
    maxAge: 0,
    path: "/",
  };
}

/**
 * Refresh-token cookie.
 *
 * Path is "/" (not "/api/auth" as before): the silent-restore flow needs
 * the cookie's PRESENCE visible to middleware on ordinary page requests —
 * middleware bounces an expired-access page load to /api/auth/restore,
 * which performs the real (DB-checked, rotating) exchange. The token VALUE
 * is only ever honoured by the /api/auth handlers (refresh + restore);
 * the cookie stays HttpOnly (no script can read it), Secure in production
 * and SameSite=Lax.
 *
 * Migration: browsers may still hold the legacy Path=/api/auth cookie,
 * which would shadow this one on /api/auth requests (cookie identity is
 * name+path; Next's ResponseCookies can only carry ONE cookie per name
 * per response, so the legacy expiry cannot ride along here). Instead,
 * middleware expires the legacy identity on every /api/auth response —
 * see the auth branch in src/middleware.ts.
 */
export function setRefreshCookie(token: string) {
  return {
    name: REFRESH_TOKEN_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 30, // 30 days — matches REFRESH_TOKEN_EXPIRY
    path: "/",
  };
}

export function clearRefreshCookie() {
  return {
    name: REFRESH_TOKEN_NAME,
    value: "",
    httpOnly: true,
    maxAge: 0,
    path: "/",
  };
}

/**
 * Write the session cookie pair (access + refresh) on a response.
 * Single place for it so every sign-in path (Firebase, Google, signup,
 * setup, refresh, restore) issues the identical cookie set.
 */
export function setSessionCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string
): void {
  response.cookies.set(setAuthCookie(accessToken));
  response.cookies.set(setRefreshCookie(refreshToken));
}

export function getRefreshCookieName(): string {
  return REFRESH_TOKEN_NAME;
}
