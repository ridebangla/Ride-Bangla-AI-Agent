/**
 * POST /api/auth/two-factor/activate — THE ONLY activation path.
 *
 * TEAM 2FA (2026-11-03). The holder enters a current code from their
 * authenticator app; the code must verify against their own PENDING
 * secret (from ../setup). ONLY THEN is 2FA marked active, the pending
 * secret promoted to the active secret, and single-use backup codes
 * issued (plaintext in this ONE response, hashes stored). Every other
 * outcome — no pending secret, expired pending secret, wrong/expired
 * code, challenge rate-limit — leaves the account EXACTLY as it was:
 * not enabled, no session change, no backup codes issued.
 *
 * No request body field, admin flag, or other route can activate 2FA.
 * In particular, no admin can activate another account's 2FA: the caller
 * authenticates via requireAuth and only their own record is touched,
 * and activation still demands THEIR OWN app's code.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  clearTwoFactorChallengeAttempts,
  decryptTotpSecret,
  generateBackupCodes,
  getTwoFactorState,
  hashBackupCode,
  isPendingSecretLive,
  isTwoFactorChallengeBlocked,
  recordTwoFactorChallengeFailure,
  verifyTotpCode,
} from "@/lib/two-factor";
import { logger } from "@/lib/logger";

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
      twoFactorPendingSecretEncrypted: true,
      twoFactorPendingExpiresAt: true,
    } as Record<string, unknown>,
  });
  if (!admin) {
    return NextResponse.json({ error: "User not found" }, { status: 401 });
  }
  const state = getTwoFactorState(admin);
  if (state.enabled) {
    return NextResponse.json(
      { error: "Two-factor authentication is already enabled." },
      { status: 400 }
    );
  }
  if (!isPendingSecretLive(state)) {
    // Stale pending secret is cleared so a later attempt cannot reuse it.
    if (state.pendingSecretEncrypted) {
      await db.admin.update({
        where: { id: auth.userId },
        data: {
          twoFactorPendingSecretEncrypted: null,
          twoFactorPendingExpiresAt: null,
        } as Record<string, unknown>,
      });
    }
    return NextResponse.json(
      { error: "Setup has expired or was not started. Start setup again, then enter the code from your authenticator app." },
      { status: 400 }
    );
  }

  if (isTwoFactorChallengeBlocked(auth.userId)) {
    return NextResponse.json(
      { error: "Too many incorrect codes. Please wait a few minutes and try again." },
      { status: 429 }
    );
  }

  let pendingSecret: string;
  try {
    pendingSecret = decryptTotpSecret(state.pendingSecretEncrypted!);
  } catch (err) {
    logger.warn(
      `[2FA] Activation refused (pending secret undecryptable): ${err instanceof Error ? err.message : "unknown"}`
    );
    return NextResponse.json(
      { error: "Two-factor setup could not be completed. Start setup again." },
      { status: 503 }
    );
  }

  if (!verifyTotpCode(pendingSecret, code)) {
    recordTwoFactorChallengeFailure(auth.userId);
    return NextResponse.json(
      { error: "Invalid or expired code. Enter the current code from your authenticator app." },
      { status: 401 }
    );
  }

  // Code verified against the holder's OWN pending secret — activation
  // happens here, and only here.
  clearTwoFactorChallengeAttempts(auth.userId);
  const backupCodes = generateBackupCodes();
  const now = new Date();
  await db.admin.update({
    where: { id: auth.userId },
    data: {
      twoFactorEnabled: true,
      twoFactorSecretEncrypted: state.pendingSecretEncrypted,
      twoFactorPendingSecretEncrypted: null,
      twoFactorPendingExpiresAt: null,
      twoFactorBackupCodeHashes: backupCodes.map(hashBackupCode),
      twoFactorActivatedAt: now,
    } as Record<string, unknown>,
  });

  // Backup codes are shown ONCE, in this response only. They are stored
  // as hashes; the plaintext values exist nowhere after this response.
  return NextResponse.json({
    enabled: true,
    backupCodes,
    warning:
      "Save these backup codes somewhere safe now. Each can be used once if you lose access to your authenticator app, and they will not be shown again.",
  });
}
