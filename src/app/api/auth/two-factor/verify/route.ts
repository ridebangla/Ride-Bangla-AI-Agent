/**
 * POST /api/auth/two-factor/verify — second-factor challenge at login.
 *
 * TEAM 2FA (2026-11-03). After the first factor (Firebase sign-in), a
 * 2FA-enabled account holds ONLY a short-lived pending token cookie
 * (rbai-twofa, type "twofa_pending") — no session cookies. This route
 * exchanges pending token + valid second-factor code (current TOTP code
 * or one single-use backup code) for the real session cookies.
 *
 * Fail-closed, exhaustively:
 * - No/invalid/expired pending token -> 401, pending cookie cleared,
 *   NO session issued. Skipping this step cannot help: dashboard and
 *   API auth require an access token, which this route alone mints
 *   after a verified code (and which verifySessionToken alone accepts).
 * - Account no longer 2FA-enabled -> 403, pending cookie cleared.
 * - Wrong/expired code -> 401, no session, attempt counted toward the
 *   per-account challenge gate (5 failures / 15 min -> 429). The gate
 *   never touches the password / Firebase first factor itself.
 * - Backup code success consumes that code (hash removed) — reuse fails.
 * - Success revokes nothing else and issues the standard cookie pair
 *   (access 1h + rotating refresh 30d) via setSessionCookies.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import {
  clearTwoFactorPendingCookie,
  generateRefreshToken,
  generateToken,
  getTwoFactorPendingCookieName,
  setSessionCookies,
  verifyTwoFactorPendingToken,
} from "@/lib/auth";
import {
  clearTwoFactorChallengeAttempts,
  getTwoFactorState,
  isTwoFactorChallengeBlocked,
  recordTwoFactorChallengeFailure,
  verifySecondFactor,
} from "@/lib/two-factor";

export async function POST(request: NextRequest) {
  const pendingToken = request.cookies.get(getTwoFactorPendingCookieName())?.value;
  if (!pendingToken) {
    return NextResponse.json(
      { error: "Sign-in session expired. Please sign in again." },
      { status: 401 }
    );
  }
  const payload = verifyTwoFactorPendingToken(pendingToken);
  if (!payload) {
    const response = NextResponse.json(
      { error: "Sign-in session expired. Please sign in again." },
      { status: 401 }
    );
    response.cookies.set(clearTwoFactorPendingCookie());
    return response;
  }

  let code: unknown;
  try {
    code = (await request.json()).code;
  } catch {
    return NextResponse.json({ error: "A code is required" }, { status: 400 });
  }

  const db = getUnscopedPrisma();
  const admin = await db.admin.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      name: true,
      role: true,
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: true,
      twoFactorBackupCodeHashes: true,
    } as Record<string, unknown>,
  });
  if (!admin) {
    const response = NextResponse.json(
      { error: "Sign-in session expired. Please sign in again." },
      { status: 401 }
    );
    response.cookies.set(clearTwoFactorPendingCookie());
    return response;
  }
  const state = getTwoFactorState(admin);
  if (!state.enabled) {
    // 2FA was disabled after the pending token was issued: the pending
    // token must not become a session on its own.
    const response = NextResponse.json(
      { error: "Two-factor authentication is not enabled for this account. Please sign in again." },
      { status: 403 }
    );
    response.cookies.set(clearTwoFactorPendingCookie());
    return response;
  }

  if (isTwoFactorChallengeBlocked(payload.userId)) {
    return NextResponse.json(
      { error: "Too many incorrect codes. Please wait a few minutes and try again." },
      { status: 429 }
    );
  }

  const result = verifySecondFactor(state, code);
  if (!result.ok) {
    recordTwoFactorChallengeFailure(payload.userId);
    return NextResponse.json(
      { error: "Invalid or expired code. Enter the current code from your authenticator app, or a backup code." },
      { status: 401 }
    );
  }

  clearTwoFactorChallengeAttempts(payload.userId);
  if (result.method === "backup" && result.consumedHash) {
    // Single use: the spent backup code is removed immediately.
    await db.admin.update({
      where: { id: payload.userId },
      data: {
        twoFactorBackupCodeHashes: state.backupCodeHashes.filter(
          (h) => h !== result.consumedHash
        ),
      } as Record<string, unknown>,
    });
  }

  const token = generateToken(payload.userId, payload.role);
  const refreshToken = generateRefreshToken(payload.userId, payload.role);
  const response = NextResponse.json({
    success: true,
    user: { id: admin.id, name: admin.name, role: admin.role },
  });
  setSessionCookies(response, token, refreshToken);
  response.cookies.set(clearTwoFactorPendingCookie());
  return response;
}
