import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import {
  LOGIN_LOCKOUT_MS,
  MAX_LOGIN_ATTEMPTS,
  clearAuthCookie,
  clearRefreshCookie,
  decodeRefreshPayload,
  generateRefreshToken,
  generateToken,
  getCurrentUser,
  getRefreshCookieName,
  isSetupAllowed,
  isSetupComplete,
  revokeToken,
  setSessionCookies,
  verifyCaptcha,
  verifyPassword,
  verifyRefreshToken,
  verifyToken,
  wasRevokedWithinGrace,
  hashPassword,
} from "@/lib/auth";
import { logger } from "@/lib/logger";

// POST /api/auth - Login, Setup, Logout, Refresh
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action, username, password, name, captchaToken } = body;

  if (action === "setup") {
    // M-53: self-service setup is DISABLED unless the operator explicitly
    // enables it at deploy time (ALLOW_SETUP=true). The first admin must be
    // created with the deploy-time seed (`npm run db:seed`) — otherwise a
    // wiped/empty production DB could be taken over via public setup.
    if (!isSetupAllowed()) {
      return NextResponse.json(
        {
          error:
            "Setup is disabled. Create the first admin with the deploy-time seed (npm run db:seed).",
        },
        { status: 403 }
      );
    }

    const setupDone = await isSetupComplete();
    if (setupDone) {
      return NextResponse.json(
        { error: "Setup already completed" },
        { status: 400 }
      );
    }

    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required" },
        { status: 400 }
      );
    }

    const hashed = await hashPassword(password);

    // First-run setup: create the business, its settings/channels, and the
    // Super Admin account (businessId null => manages every business).
    // Setup-time code: uses the unscoped client (no tenant context exists yet).
    const setupDb = getUnscopedPrisma();
    const { randomUUID } = await import("crypto");
    const baseSlug = (body.businessName || "my-business")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business";
    const slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
    const business = await setupDb.business.create({
      data: {
        name: body.businessName || "My Business",
        slug,
        siteKey: "rbsite-" + randomUUID().replace(/-/g, ""),
        isActive: true,
      },
    });

    const admin = await setupDb.admin.create({
      data: {
        username,
        password: hashed,
        name: name || "Admin",
        role: "super_admin",
        businessId: null,
      },
    });

    // Ensure default settings exist
    await setupDb.settings.upsert({
      where: { businessId: business.id },
      update: {},
      create: { businessId: business.id },
    });

    // Ensure channels exist
    for (const type of ["whatsapp", "email", "phone"]) {
      await setupDb.channel.upsert({
        where: { businessId_type: { businessId: business.id, type } },
        update: {},
        create: { businessId: business.id, type, isActive: false, status: "disconnected" },
      });
    }

    const token = generateToken(admin.id, admin.role);
    const refreshToken = generateRefreshToken(admin.id, admin.role);

    const response = NextResponse.json({
      success: true,
      user: { id: admin.id, username: admin.username, name: admin.name },
    });
    setSessionCookies(response, token, refreshToken);
    return response;
  }

  if (action === "login") {
    // Password login retired 2026-10-18: sign in with Firebase (Admin Console account).
    return NextResponse.json(
      {
        error:
          "Password sign-in is retired. Please sign in with your Admin Console email.",
      },
      { status: 410 }
    );
  }
  if (action === "logout") {
    // M-53: revoke both tokens so a stolen token stops working at once.
    const accessToken = request.cookies.get("rbai-token")?.value;
    const refreshTokenValue = request.cookies
      .get(getRefreshCookieName())
      ?.value;
    for (const raw of [accessToken, refreshTokenValue]) {
      if (!raw) continue;
      const payload = verifyToken(raw);
      if (payload?.jti) {
        await revokeToken(
          payload.jti,
          new Date((payload.exp ?? 0) * 1000 || Date.now() + 7 * 24 * 3600 * 1000)
        );
      }
    }

    const response = NextResponse.json({ success: true });
    response.cookies.set(clearAuthCookie());
    response.cookies.set(clearRefreshCookie());
    // The legacy Path=/api/auth refresh identity is expired by
    // middleware on this very response (see src/middleware.ts).
    return response;
  }

  if (action === "refresh") {
    // M-53: exchange a valid refresh token for a fresh access token.
    // The old refresh token is revoked (rotation) and a new one issued.
    const refreshTokenValue = request.cookies
      .get(getRefreshCookieName())
      ?.value;
    if (!refreshTokenValue) {
      return NextResponse.json(
        { error: "Refresh token required" },
        { status: 401 }
      );
    }

    const payload = await verifyRefreshToken(refreshTokenValue);
    if (!payload) {
      // Rotation race (session-persistence fix, 2026-10-22): another
      // tab rotated this exact token moments ago. Answer 409, NOT
      // 401 — the SessionKeeper treats only a definitive 401 as
      // "session over" (→ /login); a 409 is retried next cycle, by
      // which time this tab sends the fresh cookie pair. The old
      // token is never honoured.
      const raced = decodeRefreshPayload(refreshTokenValue);
      if (raced?.jti && (await wasRevokedWithinGrace(raced.jti))) {
        return NextResponse.json(
          { error: "session_rotated" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: "Invalid or expired refresh token" },
        { status: 401 }
      );
    }

    // TenantContextError fix: the refresh flow runs outside any tenant
    // context, so the admin lookup must use the unscoped client.
    const admin = await getUnscopedPrisma().admin.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, name: true, role: true },
    });
    if (!admin) {
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    await revokeToken(
      payload.jti,
      new Date((payload.exp ?? 0) * 1000 || Date.now() + 7 * 24 * 3600 * 1000)
    );

    const token = generateToken(admin.id, admin.role);
    const newRefreshToken = generateRefreshToken(admin.id, admin.role);

    const response = NextResponse.json({
      success: true,
      user: { id: admin.id, username: admin.username, name: admin.name },
    });
    setSessionCookies(response, token, newRefreshToken);
    return response;
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// GET /api/auth - Check auth status
export async function GET() {
  const setupDone = await isSetupComplete();
  if (!setupDone) {
    return NextResponse.json({ authenticated: false, setupRequired: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ authenticated: false, setupRequired: false });
  }

  return NextResponse.json({
    authenticated: true,
    setupRequired: false,
    user,
  });
}
