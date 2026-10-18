import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
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
// M-53: short-lived access tokens (1h) + refresh tokens (7d), instead of a
// single 7-day token with no revocation.
const TOKEN_EXPIRY = "1h";
const REFRESH_TOKEN_EXPIRY = "7d";

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

/** Revoke a token by its `jti` (logout / refresh rotation). Idempotent. */
export async function revokeToken(jti: string, expiresAt: Date): Promise<void> {
  if (!jti) return;
  await getUnscopedPrisma().revokedToken.upsert({
    where: { jti },
    update: {},
    create: { jti, expiresAt },
  });
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

export async function isSetupComplete(): Promise<boolean> {
  const adminCount = await getUnscopedPrisma().admin.count();
  return adminCount > 0;
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
 * Refresh-token cookie. Scoped to /api/auth so the long-lived token is only
 * ever sent to the refresh endpoint, never to every request.
 */
export function setRefreshCookie(token: string) {
  return {
    name: REFRESH_TOKEN_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 7, // 7 days — matches REFRESH_TOKEN_EXPIRY
    path: "/api/auth",
  };
}

export function clearRefreshCookie() {
  return {
    name: REFRESH_TOKEN_NAME,
    value: "",
    httpOnly: true,
    maxAge: 0,
    path: "/api/auth",
  };
}

export function getRefreshCookieName(): string {
  return REFRESH_TOKEN_NAME;
}
