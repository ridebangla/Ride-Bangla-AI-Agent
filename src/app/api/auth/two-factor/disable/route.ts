/**
 * POST /api/auth/two-factor/disable — turn 2FA off for the CALLER's account.
 *
 * TEAM 2FA (2026-11-03). Disabling requires the caller's own authenticated
 * session PLUS a valid current second-factor code (TOTP or a backup
 * code) — a stolen session alone cannot strip the second factor, and
 * nobody can disable another account's 2FA through here (requireAuth
 * authenticates the caller; only the caller's record is touched).
 * Disabling wipes the active secret, pending secret, backup-code hashes
 * and activation timestamp, so nothing 2FA-related survives to be reused.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  clearTwoFactorChallengeAttempts,
  getTwoFactorState,
  isTwoFactorChallengeBlocked,
  recordTwoFactorChallengeFailure,
  verifySecondFactor,
} from "@/lib/two-factor";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;

  let code: unknown;
  try {
    code = (await request.json()).code;
  } catch {
    return NextResponse.json({ error: "A code is required" }, { status: 400 });
  }

  const db = getUnscopedPrisma();
  const admin = await db.admin.findUnique({
    where: { id: auth.userId },
    select: {
      id: true,
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: true,
      twoFactorBackupCodeHashes: true,
    } as Record<string, unknown>,
  });
  if (!admin) {
    return NextResponse.json({ error: "User not found" }, { status: 401 });
  }
  const state = getTwoFactorState(admin);
  if (!state.enabled) {
    return NextResponse.json(
      { error: "Two-factor authentication is not enabled." },
      { status: 400 }
    );
  }

  if (isTwoFactorChallengeBlocked(auth.userId)) {
    return NextResponse.json(
      { error: "Too many incorrect codes. Please wait a few minutes and try again." },
      { status: 429 }
    );
  }

  if (!verifySecondFactor(state, code).ok) {
    recordTwoFactorChallengeFailure(auth.userId);
    return NextResponse.json(
      { error: "Invalid or expired code. Enter the current code from your authenticator app, or a backup code." },
      { status: 401 }
    );
  }

  clearTwoFactorChallengeAttempts(auth.userId);
  await db.admin.update({
    where: { id: auth.userId },
    data: {
      twoFactorEnabled: false,
      twoFactorSecretEncrypted: null,
      twoFactorPendingSecretEncrypted: null,
      twoFactorPendingExpiresAt: null,
      twoFactorBackupCodeHashes: [],
      twoFactorActivatedAt: null,
    } as Record<string, unknown>,
  });
  return NextResponse.json({ enabled: false });
}
