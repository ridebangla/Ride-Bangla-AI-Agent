/**
 * GET /api/admin/launch-readiness — launch-gate dependency status (Phase 6).
 *
 * Dual auth, fail-closed. Either:
 *  1. `rbai-token` cookie — session JWT whose role is `super_admin`, and the
 *     admin record still exists with role `super_admin`; OR
 *  2. `Authorization: Bearer <Firebase ID token>` — verified with the Admin
 *     SDK (this service shares the Admin Console's Firebase project
 *     `ride-bangla-app`); the token's email must match an `admins` record
 *     with role `super_admin` in THIS service's database.
 *
 * Anything else -> 401 (no credentials) or 403 (not a Super Admin).
 *
 * The response reports PRESENCE only (env var exists and is non-empty).
 * Key validity is deliberately NOT probed — the response is honest about
 * that. Firebase Blaze / Cloud Functions cannot be detected from the app,
 * so they return "manual-check" with Firebase console links. Never guess.
 *
 * NOTE: /api/admin/* is not in the middleware's public path list, so the
 * middleware blocks requests carrying neither rbai-token nor x-api-key.
 * src/middleware.ts special-cases this endpoint to let Bearer requests
 * reach this handler (preflight included); the actual verification happens
 * here. CORS is scoped to the Admin Console origin only.
 */

import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { verifySessionToken } from "@/lib/auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const CONSOLE_ORIGIN =
  process.env.ADMIN_CONSOLE_ORIGIN || "https://admin.ridebangla.bd";

// Same Firebase Admin bootstrap as /api/auth/firebase (shares the Admin
// Console's Firebase project). Local copy so this route stays
// self-contained.
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

function present(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function withCors(response: NextResponse): NextResponse {
  response.headers.set("Access-Control-Allow-Origin", CONSOLE_ORIGIN);
  return response;
}

function errorResponse(message: string, status: number): NextResponse {
  return withCors(NextResponse.json({ error: message }, { status }));
}

/**
 * Dual-auth gate. Returns null when authorized, otherwise the 401/403
 * response to send back.
 */
async function authorize(
  request: NextRequest
): Promise<NextResponse | null> {
  // 1) Session cookie — the AI Agent dashboard's own super_admin session.
  const cookieToken = request.cookies.get("rbai-token")?.value;
  if (cookieToken) {
    const payload = await verifySessionToken(cookieToken);
    if (!payload || payload.role !== "super_admin") {
      return errorResponse("Super Admin access required.", 403);
    }
    const db = getUnscopedPrisma();
    const sessionAdmin = await db.admin.findUnique({
      where: { id: payload.userId },
      select: { role: true },
    });
    if (!sessionAdmin || sessionAdmin.role !== "super_admin") {
      return errorResponse("Super Admin access required.", 403);
    }
    return null;
  }

  // 2) Firebase ID token from the Admin Console (no cookie available
  // cross-origin). Verified via the Admin SDK against the shared project.
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (bearer) {
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await getFirebaseAdminAuth().verifyIdToken(bearer[1], true);
    } catch {
      return errorResponse("Invalid or expired sign-in token.", 401);
    }
    const email = (decoded.email || "").toLowerCase().trim();
    if (!email) {
      return errorResponse("This sign-in has no email address.", 403);
    }
    const db = getUnscopedPrisma();
    const emailAdmins = await db.admin.findMany({
      where: { email } as Record<string, unknown>,
    });
    const superAdmin = emailAdmins.find((a) => a.role === "super_admin");
    if (!superAdmin) {
      return errorResponse(
        "This email is not registered as a Super Admin in the AI Agent. Sign in to the AI Agent dashboard once with this email to register it.",
        403
      );
    }
    return null;
  }

  return errorResponse("Authentication required.", 401);
}

export async function OPTIONS(): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  response.headers.set("Access-Control-Allow-Origin", CONSOLE_ORIGIN);
  response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Rate-limit: the endpoint is cheap but auth-adjacent — 10/min per IP.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`launch-readiness:${ip}`, {
    maxRequests: 10,
    windowMs: 60 * 1000,
  });
  if (!rl.allowed) {
    return errorResponse("Too many requests. Try again shortly.", 429);
  }

  const denied = await authorize(request);
  if (denied) return denied;

  try {
    const projectId = process.env.FIREBASE_PROJECT_ID || "ride-bangla-app";
    return withCors(
      NextResponse.json({
        openai: { present: present("OPENAI_API_KEY") },
        groq: { present: present("GROQ_API_KEY") },
        gemini: { present: present("GEMINI_API_KEY") },
        aiPriority: process.env.AI_PROVIDER_PRIORITY || "groq,gemini,openai (default)",
        stripe: {
          secretPresent: present("STRIPE_SECRET_KEY"),
          webhookSecretPresent: present("STRIPE_WEBHOOK_SECRET"),
          pricesConfigured:
            present("STRIPE_PRICE_STARTER") &&
            present("STRIPE_PRICE_GROWTH") &&
            present("STRIPE_PRICE_PRO"),
          yearlyPricesConfigured:
            present("STRIPE_PRICE_STARTER_YR") &&
            present("STRIPE_PRICE_GROWTH_YR") &&
            present("STRIPE_PRICE_PRO_YR"),
        },
        meta: {
          present: present("META_APP_ID") && present("META_APP_SECRET"),
        },
        x: { present: present("X_API_KEY") },
        whatsapp: { present: present("WHATSAPP_TOKEN") },
        firebase: {
          blaze: "manual-check",
          functions: "manual-check",
          consoleUrl: `https://console.firebase.google.com/project/${projectId}`,
        },
        checkedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    logger.error("Launch readiness check failed:", error);
    return errorResponse("Readiness check failed.", 500);
  }
}
