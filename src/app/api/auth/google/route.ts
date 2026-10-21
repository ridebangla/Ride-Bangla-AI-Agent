/**
 * POST /api/auth/google — Google one-tap signup / sign-in.
 *
 * The customer signs in with Google on the client (Firebase client SDK),
 * then posts the Firebase ID token here. This route:
 *   - verifies the ID token with firebase-admin (shared ride-bangla-app project),
 *   - if an agent admin already carries this email -> signs them in
 *     (issue rbai JWT + refresh cookies, like /api/auth/firebase),
 *   - otherwise -> creates the account + a 30-day trial business immediately
 *     and signs the customer straight into their dashboard.
 *
 * Fail-closed: the SaaS path can NEVER mint a platform super_admin.
 * (First-platform bootstrap stays on /api/auth/firebase + /setup.)
 * The business name comes from the Google profile or the email address and
 * can be changed later in Settings or the Done-for-You Setup application.
 */
import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { getUnscopedPrisma } from "@/lib/prisma";
import {
  generateRefreshToken,
  generateToken,
  setSessionCookies,
} from "@/lib/auth";
import { TRIAL_MS, TRIAL_DAYS } from "@/lib/subscription";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

function getFirebaseAdminAuth(): admin.auth.Auth {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Firebase Admin is not configured");
    }
    privateKey = privateKey.replace(/\\n/g, "\n");
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      projectId,
    });
  }
  return admin.auth();
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business"
  );
}

function defaultBusinessName(nameFromProfile: string | undefined, email: string): string {
  const raw = (nameFromProfile || "").trim();
  if (raw.length >= 2) return raw.slice(0, 100);
  const prefix = email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = prefix.replace(/\b\w/g, (c) => c.toUpperCase());
  return (title.length >= 2 ? title : "My Business").slice(0, 100);
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`google-auth:${ip}`, { maxRequests: 10, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const { idToken } = body;
    if (!idToken || typeof idToken !== "string") {
      return NextResponse.json(
        { error: "Sign-in token is required" },
        { status: 400 }
      );
    }

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await getFirebaseAdminAuth().verifyIdToken(idToken, true);
    } catch {
      return NextResponse.json(
        { error: "Invalid or expired sign-in. Please try again." },
        { status: 401 }
      );
    }

    const email = (decoded.email || "").toLowerCase().trim();
    if (!email) {
      return NextResponse.json(
        { error: "Your Google account has no email address." },
        { status: 403 }
      );
    }
    // Google sign-in should present a verified email. Treat an unverified
    // email as unusable rather than minting an account on it.
    if (decoded.email_verified === false) {
      return NextResponse.json(
        { error: "Please verify your Google email first, then try again." },
        { status: 403 }
      );
    }

    const db = getUnscopedPrisma();

    const existing = await db.admin.findMany({
      where: { email } as Record<string, unknown>,
    });

    if (existing.length > 0) {
      // Returning customer — sign them straight in.
      const agentAdmin = existing[0];
      const token = generateToken(agentAdmin.id, agentAdmin.role);
      const refreshToken = generateRefreshToken(agentAdmin.id, agentAdmin.role);
      const response = NextResponse.json({
        success: true,
        isNew: false,
        email,
        name: agentAdmin.name,
      });
      setSessionCookies(response, token, refreshToken);
      return response;
    }

    // New customer — create account + trial business immediately, sign in.
    const businessName = defaultBusinessName(
      decoded.name as string | undefined,
      email
    );
    const firebaseUid = decoded.uid;
    let businessId: string | null = null;

    try {
      const baseSlug = slugify(businessName);
      let slug = baseSlug;
      for (let attempt = 0; attempt < 5; attempt++) {
        slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
        const clash = await db.business.findMany({
          where: { slug } as Record<string, unknown>,
        });
        if (clash.length === 0) break;
      }
      const business = await db.business.create({
        data: {
          name: businessName,
          slug,
          siteKey: "rbsite-" + randomUUID().replace(/-/g, ""),
          plan: "trial",
          subscriptionStatus: "trialing",
          trialEndsAt: new Date(Date.now() + TRIAL_MS),
          isActive: true,
        } as Record<string, unknown>,
      });
      businessId = business.id;

      const tenantAdmin = await db.admin.create({
        data: {
          username: email,
          email,
          // Password login is retired; this marker is not a valid bcrypt hash.
          // The real credential lives in Firebase Auth only.
          password: "FIREBASE_AUTH",
          firebaseUid,
          name: businessName,
          role: "admin",
          businessId,
          failedLoginAttempts: 0,
          lockedUntil: null,
        } as Record<string, unknown>,
      });

      await db.settings.upsert({
        where: { businessId },
        update: {},
        create: {
          businessId,
          businessName,
        } as Record<string, unknown>,
      });
      for (const type of ["whatsapp", "email", "phone"]) {
        await db.channel.upsert({
          where: { businessId_type: { businessId, type } },
          update: {},
          create: { businessId, type, isActive: false, status: "disconnected" },
        });
      }

      const token = generateToken(tenantAdmin.id, tenantAdmin.role);
      const refreshToken = generateRefreshToken(tenantAdmin.id, tenantAdmin.role);

      logger.warn(
        `[Auth] Google signup: business="${businessName}" (${business.id}) admin=${email} — ${TRIAL_DAYS}-day trial started`
      );

      const response = NextResponse.json({
        success: true,
        isNew: true,
        businessId: business.id,
        trialEndsAt: new Date(Date.now() + TRIAL_MS).toISOString(),
      });
      setSessionCookies(response, token, refreshToken);
      return response;
    } catch (err) {
      // Roll back the partial tenant so nothing orphaned survives.
      if (businessId) {
        try {
          await db.business.delete({ where: { id: businessId } });
        } catch {
          /* best effort */
        }
      }
      throw err;
    }
  } catch (err) {
    logger.warn(
      `[Auth] Google sign-in failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    return NextResponse.json(
      { error: "Google sign-in failed. Please try again." },
      { status: 500 }
    );
  }
}
