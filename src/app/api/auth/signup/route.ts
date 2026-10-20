import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { getUnscopedPrisma } from "@/lib/prisma";
import {
  generateRefreshToken,
  generateToken,
  setAuthCookie,
  setRefreshCookie,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business"
  );
}

// POST /api/auth/signup — self-service SaaS signup.
//
// Creates, in order:
//   1. a Firebase Auth user (Admin SDK; password lives ONLY in Firebase Auth,
//      this app never stores it — same shared project as the Admin Console),
//   2. a `businesses` doc on a 30-day free trial (first month free; TRIAL_DAYS)
//      { plan:'trial', subscriptionStatus:'trialing', trialEndsAt: now+TRIAL_MS },
//   3. an `admins` doc { role:'admin', businessId } — NEVER super_admin here.
// On any failure after step 1, the Firebase user + business doc are rolled
// back so no orphaned accounts or trial businesses are left behind.
export async function POST(request: NextRequest) {
  // Stricter abuse guard for the public signup endpoint.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`signup:${ip}`, { maxRequests: 10, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    // Done-for-you model: signup takes email + password only. The business
    // name is optional here — the customer can set it from the dashboard
    // (Done-for-You Setup application). Never required at signup.
    let businessName = String(body.businessName || "").trim();
    const email = String(body.email || "").toLowerCase().trim();
    const password = String(body.password || "");
    if (!businessName) {
      // Friendly default from the email address (editable later).
      businessName = email
        .split("@")[0]
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .slice(0, 100);
      if (businessName.length < 2) businessName = "My Business";
    }
    const websiteUrl = String(body.websiteUrl || "").trim();

    if (businessName.length < 2 || businessName.length > 100) {
      return NextResponse.json(
        { error: "Business name must be 2–100 characters." },
        { status: 400 }
      );
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }
    if (password.length < 8 || password.length > 128) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }
    if (websiteUrl) {
      try {
        const u = new URL(
          /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`
        );
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      } catch {
        return NextResponse.json(
          { error: "Website URL doesn't look valid." },
          { status: 400 }
        );
      }
    }

    const db = getUnscopedPrisma();

    // Fail-closed: an email already in use (as any agent admin) cannot sign
    // up again — they should log in instead.
    const existing = await db.admin.findMany({
      where: { email } as Record<string, unknown>,
    });
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please log in." },
        { status: 400 }
      );
    }

    let firebaseUid: string | null = null;
    let businessId: string | null = null;

    try {
      // 1. Firebase Auth user (password only ever lives in Firebase Auth).
      try {
        const user = await getFirebaseAdminAuth().createUser({
          email,
          password,
          displayName: businessName,
          emailVerified: false,
        });
        firebaseUid = user.uid;
      } catch (err: unknown) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code: unknown }).code)
            : "";
        if (code === "auth/email-already-exists") {
          return NextResponse.json(
            { error: "An account with this email already exists. Please log in." },
            { status: 400 }
          );
        }
        throw err;
      }

      // 2. Business on a TRIAL_DAYS-day free trial.
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
          ...(websiteUrl ? { websiteUrl } : {}),
        } as Record<string, unknown>,
      });
      businessId = business.id;

      // 3. Tenant admin. NEVER super_admin from this endpoint — the SaaS
      // signup path cannot mint platform-wide accounts (fail-closed).
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

      // Baseline rows every tenant needs (mirrors first-run setup).
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
        `[Auth] SaaS signup: business="${businessName}" (${business.id}) admin=${email} — ${TRIAL_DAYS}-day trial started`
      );

      const response = NextResponse.json({
        success: true,
        businessId: business.id,
        trialEndsAt: new Date(Date.now() + TRIAL_MS).toISOString(),
      });
      response.cookies.set(setAuthCookie(token));
      response.cookies.set(setRefreshCookie(refreshToken));
      return response;
    } catch (err) {
      // Roll back partial signup: delete the Firebase user and the business
      // doc so nothing orphaned survives a failed signup.
      if (firebaseUid) {
        try {
          await getFirebaseAdminAuth().deleteUser(firebaseUid);
        } catch {
          /* best effort */
        }
      }
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
      `[Auth] Signup failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    return NextResponse.json(
      { error: "Signup failed. Please try again." },
      { status: 500 }
    );
  }
}
