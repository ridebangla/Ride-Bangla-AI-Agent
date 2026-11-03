/**
 * POST /api/auth/two-factor/setup — start authenticator-app 2FA setup.
 * GET  /api/auth/two-factor/setup — 2FA status for the signed-in account.
 *
 * TEAM 2FA (2026-11-03). HARD RULE: starting setup does NOT activate
 * anything. This route stores only a PENDING secret (encrypted) and
 * returns the QR + manual secret ONCE, in this account's own authenticated
 * session. Activation happens exclusively in ../activate, and only after
 * the holder enters a current code from their app that verifies against
 * this pending secret. No admin — including Super Admin — can activate
 * 2FA on another account through here: requireAuth authenticates the
 * CALLER, and the pending secret is written to the CALLER's own record.
 *
 * Responses never include a stored secret after setup: GET returns only
 * booleans (enabled / pending). The manual secret + QR leave this route
 * exactly once, in the POST response.
 */
import { NextRequest, NextResponse } from "next/server";
import * as qrcode from "qrcode";
import { getUnscopedPrisma } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  buildOtpauthUri,
  encryptTotpSecret,
  generateTotpSecret,
  getTwoFactorState,
  isPendingSecretLive,
  PENDING_SECRET_TTL_MS,
  TOTP_ISSUER,
} from "@/lib/two-factor";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;
  const admin = await getUnscopedPrisma().admin.findUnique({
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
  return NextResponse.json({
    enabled: state.enabled,
    pending: isPendingSecretLive(state),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;

  const db = getUnscopedPrisma();
  const admin = await db.admin.findUnique({
    where: { id: auth.userId },
    select: {
      id: true,
      username: true,
      twoFactorEnabled: true,
    } as Record<string, unknown>,
  });
  if (!admin) {
    return NextResponse.json({ error: "User not found" }, { status: 401 });
  }
  const state = getTwoFactorState(admin);
  if (state.enabled) {
    return NextResponse.json(
      { error: "Two-factor authentication is already enabled. Disable it first to set up a new authenticator." },
      { status: 400 }
    );
  }

  // Fail closed when no encryption key is configured: a setup that
  // stored the secret in plaintext would be worse than no setup.
  let encrypted: string;
  const secret = generateTotpSecret();
  try {
    encrypted = encryptTotpSecret(secret);
  } catch (err) {
    logger.warn(
      `[2FA] Setup refused (encryption unavailable): ${err instanceof Error ? err.message : "unknown"}`
    );
    return NextResponse.json(
      { error: "Two-factor setup is not configured on this server yet. Please try again later." },
      { status: 503 }
    );
  }

  await db.admin.update({
    where: { id: auth.userId },
    data: {
      twoFactorPendingSecretEncrypted: encrypted,
      twoFactorPendingExpiresAt: new Date(Date.now() + PENDING_SECRET_TTL_MS),
    } as Record<string, unknown>,
  });

  const label = typeof admin.username === "string" && admin.username
    ? admin.username
    : auth.userId;
  const otpauthUri = buildOtpauthUri(secret, label, TOTP_ISSUER);
  const qrDataUrl = await qrcode.toDataURL(otpauthUri);

  // One-time display: the secret + QR leave the server exactly here, in
  // the setting-up account's own session. They are never logged and
  // never returned again (GET returns booleans only).
  return NextResponse.json({
    setupStarted: true,
    qrDataUrl,
    manualSecret: secret,
    expiresAt: new Date(Date.now() + PENDING_SECRET_TTL_MS).toISOString(),
  });
}
