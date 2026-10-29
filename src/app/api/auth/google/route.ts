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
 * WHICH existing admin (owner rule 2026-10-21): resolution is delegated
 * to pickSignInAdmin (src/lib/admin-resolution.ts) — firebaseUid match,
 * then the INTERNAL owner business, then earliest-created. The holder
 * account therefore always lands on the SAME business record: never a
 * duplicate business, never a fresh trial, never onboarding. An email
 * that any admin already carries can never reach the create path below.
 *
 * EMAIL VERIFICATION: a new account is only ever created on a VERIFIED
 * Google email, and an existing CUSTOMER account still requires one.
 * The single narrow exception is the holder account itself: a
 * Google-issued token (sign_in_provider "google.com") whose email
 * resolves to the INTERNAL business signs in even when the token's
 * email_verified claim is not true — the owner must never be walled out
 * of his own platform by a verification interstitial. The exception is
 * bound to the internal flag on the business doc, never to the email
 * string alone, and it is logged on every use.
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
  isDatastoreQuotaError,
  setSessionCookies,
} from "@/lib/auth";
import {
  isInternalAdmin,
  resolveSignInAdmin,
} from "@/lib/admin-resolution";
import { TRIAL_MS, TRIAL_DAYS } from "@/lib/subscription";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  RESERVED_NAME_ERROR,
  isReservedBusinessName,
} from "@/lib/reserved-names";

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
    const emailVerified = decoded.email_verified === true;
    const signInProvider =
      (decoded.firebase?.sign_in_provider as string | undefined) || "";

    const db = getUnscopedPrisma();

    // Q-SIGNIN (2026-10-23): same contract as /api/auth/firebase — the
    // admins-by-email resolution is the one indispensable read for a
    // RETURNING account; on a quota failure it falls back to the proven
    // remembered resolution for this (email, uid) when one exists, and
    // otherwise propagates to the honest 503 in the outer catch.
    const resolved = await resolveSignInAdmin(db, email, decoded.uid);
    const existingAdmin = resolved.admin;

    if (existingAdmin) {
      // Returning account — resolved to WHICH record this sign-in
      // belongs to (uid binding → internal owner business → earliest),
      // never just the first row the datastore happens to return.
      const agentAdmin = existingAdmin;
      if (!emailVerified) {
        // Google sign-in should present a verified email. The ONLY
        // exception is the holder account (owner rule 2026-10-21): a
        // Google-issued token resolving to the INTERNAL business signs
        // straight in — no verification wall for the owner. Every other
        // account keeps the verified-email requirement exactly as before.
        const isOwnerEntry =
          signInProvider === "google.com" &&
          (await isInternalAdmin(db, agentAdmin));
        if (!isOwnerEntry) {
          return NextResponse.json(
            { error: "Please verify your Google email first, then try again." },
            { status: 403 }
          );
        }
        logger.warn(
          `[Auth] Owner direct entry: Google sign-in for ${email} resolved to internal business ${agentAdmin.businessId} without an email_verified claim`
        );
      }
      const token = generateToken(agentAdmin.id, agentAdmin.role);
      const refreshToken = generateRefreshToken(agentAdmin.id, agentAdmin.role);
      const response = NextResponse.json({
        success: true,
        isNew: false,
        // Present only on a quota-degraded sign-in (proven resolution
        // reused while the data store is quota-exhausted).
        ...(resolved.degraded ? { degraded: true } : {}),
        email,
        name: agentAdmin.name,
      });
      setSessionCookies(response, token, refreshToken);
      return response;
    }

    // No admin carries this email. A NEW account is created only on a
    // verified Google email — an unverified claim mints nothing.
    if (!emailVerified) {
      return NextResponse.json(
        { error: "Please verify your Google email first, then try again." },
        { status: 403 }
      );
    }

    // New customer — create account + trial business immediately, sign in.
    const businessName = defaultBusinessName(
      decoded.name as string | undefined,
      email
    );
    // Platform-name reservation (owner 2026-10-29 ~23:53): the Google
    // profile name (or email-derived fallback) may not be "Ride
    // Bangla" for a NEW business. Checked BEFORE any business/admin/
    // settings row is created, so a blocked attempt mints nothing.
    // The Firebase identity itself is untouched — the person can
    // still sign in later to a legitimate business; they simply
    // cannot mint a squat business here. Returning accounts never
    // reach this point (they returned above), so the company's own
    // sign-in is unaffected.
    if (isReservedBusinessName(businessName)) {
      return NextResponse.json(
        { error: RESERVED_NAME_ERROR },
        { status: 400 }
      );
    }
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
    // Q-SIGNIN (2026-10-23): a quota-exhausted data store is not a
    // sign-in failure — answer with the same honest 503 copy as
    // /api/auth/firebase. This fires when the indispensable resolution
    // read failed with nothing remembered, or when a NEW account's
    // creation writes (business + admin + settings + channels — named
    // indispensable for a first sign-up: an account cannot be
    // half-created and entered later) could not land.
    if (isDatastoreQuotaError(err)) {
      return NextResponse.json(
        {
          error:
            "Sign-in is temporarily unavailable. Please try again later.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Google sign-in failed. Please try again." },
      { status: 500 }
    );
  }
}
