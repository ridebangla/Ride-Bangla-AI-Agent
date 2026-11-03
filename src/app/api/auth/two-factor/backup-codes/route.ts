/**
 * POST /api/auth/two-factor/backup-codes — regenerate backup codes.
 *
 * TEAM 2FA (2026-11-03). The holder re-authenticates with a valid current
 * code (TOTP or an existing backup code) in their own session; the old
 * backup-code hashes are then replaced wholesale, so every old code
 * stops working at once. The new codes are shown ONCE, in this response
 * only, and stored as hashes.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  clearTwoFactorChallengeAttempts,
  generateBackupCodes,
  getTwoFactorState,
  hashBackupCode,
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
  const backupCodes = generateBackupCodes();
  await db.admin.update({
    where: { id: auth.userId },
    data: {
      twoFactorBackupCodeHashes: backupCodes.map(hashBackupCode),
    } as Record<string, unknown>,
  });
  return NextResponse.json({
    backupCodes,
    warning:
      "Save these backup codes somewhere safe now. Each can be used once, your previous backup codes no longer work, and these will not be shown again.",
  });
}
