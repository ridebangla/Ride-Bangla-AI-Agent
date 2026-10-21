/**
 * Public Reviews API — shared by our public sites (AI site, Tools, Studio).
 * Same auth model as /api/public/ai/generate: the business's public `siteKey`
 * identifies the business and grants no admin powers.
 *
 * GET /api/public/reviews?site=tools|ai|studio&siteKey=<public site key>
 *   → { ok: true, average, count,
 *       reviews: [{ name, rating, text, createdAt, photoURL, verifiedGoogle }] }
 *   Published reviews only, newest first, max 20 shown. No seeded reviews —
 *   empty when nobody has reviewed yet. `photoURL` is the reviewer's Google
 *   profile photo captured from their verified ID token at submission (""
 *   when none). `verifiedGoogle` is true ONLY when the stored record proves
 *   the review was submitted with a Firebase token whose sign-in provider
 *   is Google — records created any other way (or before this field
 *   existed) read back as false, never assumed.
 *
 * POST /api/public/reviews
 *   { siteKey, site, idToken, rating (1-5), text (1-1000 chars), name? (1-80) }
 *   The reviewer's Firebase ID token (or their own rbai session token on the
 *   AI site) is verified with the Admin SDK. Stored in Firestore `site_reviews`
 *   with createdAt. Rate limit: max 1 review per uid per site per 24h, plus
 *   basic IP throttling. Honest errors, no internals leaked.
 */

import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { verifySessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

const SITES = ["tools", "ai", "studio"] as const;
type Site = (typeof SITES)[number];

const GET_RATE_LIMIT = { maxRequests: 120, windowMs: 60 * 1000 };
const POST_IP_RATE_LIMIT = { maxRequests: 10, windowMs: 60 * 60 * 1000 };
const LIST_LIMIT = 20;
const MAX_TEXT = 1000;
const MAX_NAME = 80;

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

async function requireValidSiteKey(siteKey: string | null) {
  if (!siteKey || typeof siteKey !== "string") return null;
  return getBusinessBySiteKey(siteKey);
}

/** Verify the caller's identity: a Firebase ID token, or their own rbai
 * session token (AI site / Studio customers use their existing session). */
async function verifyCaller(
  idToken: unknown
): Promise<{ uid: string; name: string; photoURL: string; verifiedGoogle: boolean } | null> {
  if (!idToken || typeof idToken !== "string") return null;
  // 1) Firebase ID token (Google sign-in / email sign-in anywhere).
  try {
    const decoded = await getFirebaseAdminAuth().verifyIdToken(idToken, true);
    const uid = decoded.uid;
    if (!uid) return null;
    const name =
      typeof decoded.name === "string" && decoded.name.trim()
        ? decoded.name.trim().slice(0, MAX_NAME)
        : (decoded.email || "").split("@")[0] || "Reviewer";
    return {
      uid,
      name,
      photoURL:
        typeof decoded.picture === "string" ? decoded.picture : "",
      // Proof of Google authentication lives in the token's firebase
      // claims — only a google.com sign-in provider earns the badge.
      verifiedGoogle: decoded.firebase?.sign_in_provider === "google.com",
    };
  } catch {
    // fall through to the session-token path
  }
  // 2) Our own rbai session token (customers already signed into the AI site).
  try {
    const payload = await verifySessionToken(idToken);
    if (!payload?.userId) return null;
    const adminDoc = await getUnscopedPrisma().admin.findUnique({
      where: { id: payload.userId },
      select: { id: true, name: true, firebaseUid: true },
    });
    if (!adminDoc) return null;
    const fbUid =
      typeof adminDoc.firebaseUid === "string" && adminDoc.firebaseUid
        ? adminDoc.firebaseUid
        : adminDoc.id;
    return {
      uid: fbUid,
      name: adminDoc.name || "Reviewer",
      photoURL: "",
      // Our own session token proves a platform sign-in, not Google
      // authentication — no Google badge for this path.
      verifiedGoogle: false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- GET ----
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const site = url.searchParams.get("site");
    const siteKey = url.searchParams.get("siteKey");

    if (!site || !SITES.includes(site as Site)) {
      return NextResponse.json(
        { ok: false, error: "Unknown site." },
        { status: 400 }
      );
    }
    const business = await requireValidSiteKey(siteKey);
    if (!business) {
      return NextResponse.json(
        { ok: false, error: "Invalid site key." },
        { status: 401 }
      );
    }

    const ip = clientIp(request);
    const rl = checkRateLimit(`public-reviews-get:${ip}`, GET_RATE_LIMIT);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many requests — please try again soon." },
        { status: 429 }
      );
    }

    const all = await getUnscopedPrisma().siteReview.findMany({
      where: { site, status: "published" },
      orderBy: { createdAt: "desc" },
    });
    const count = all.length;
    const average =
      count === 0
        ? 0
        : Math.round((all.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10;
    const reviews = all.slice(0, LIST_LIMIT).map((r) => ({
      name: r.name,
      rating: r.rating,
      text: r.text,
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      photoURL: r.photoURL || "",
      verifiedGoogle: r.verifiedGoogle === true,
    }));

    return NextResponse.json({ ok: true, average, count, reviews });
  } catch (e) {
    logger.error("GET /api/public/reviews failed", { error: (e as Error).message });
    return NextResponse.json(
      { ok: false, error: "Could not load reviews right now." },
      { status: 500 }
    );
  }
}

// --------------------------------------------------------------- POST ----
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      siteKey?: unknown;
      site?: unknown;
      idToken?: unknown;
      rating?: unknown;
      text?: unknown;
      name?: unknown;
    } | null;
    if (!body) {
      return NextResponse.json(
        { ok: false, error: "Invalid request." },
        { status: 400 }
      );
    }

    const { siteKey, site, idToken, rating, text, name } = body;

    if (!site || !SITES.includes(site as Site)) {
      return NextResponse.json(
        { ok: false, error: "Unknown site." },
        { status: 400 }
      );
    }
    const business = await requireValidSiteKey(
      typeof siteKey === "string" ? siteKey : null
    );
    if (!business) {
      return NextResponse.json(
        { ok: false, error: "Invalid site key." },
        { status: 401 }
      );
    }

    const caller = await verifyCaller(idToken);
    if (!caller) {
      return NextResponse.json(
        { ok: false, error: "Please sign in to write a review." },
        { status: 401 }
      );
    }

    const stars =
      typeof rating === "string" ? Number.parseInt(rating, 10) : rating;
    if (
      typeof stars !== "number" ||
      !Number.isInteger(stars) ||
      stars < 1 ||
      stars > 5
    ) {
      return NextResponse.json(
        { ok: false, error: "Please choose a rating from 1 to 5 stars." },
        { status: 400 }
      );
    }
    const cleanText =
      typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
    if (cleanText.length < 1 || cleanText.length > MAX_TEXT) {
      return NextResponse.json(
        {
          ok: false,
          error: "Please write your review (up to 1000 characters).",
        },
        { status: 400 }
      );
    }
    const displayName =
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, MAX_NAME)
        : caller.name;

    const ip = clientIp(request);
    const rl = checkRateLimit(`public-reviews-post:${ip}`, POST_IP_RATE_LIMIT);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many reviews from this network — please try again later." },
        { status: 429 }
      );
    }

    // One review per uid per site per 24h.
    const latest = await getUnscopedPrisma().siteReview.findFirst({
      where: { site: site as string, uid: caller.uid },
      orderBy: { createdAt: "desc" },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < 24 * 60 * 60 * 1000) {
      return NextResponse.json(
        {
          ok: false,
          error: "You've already posted a review for this site in the last 24 hours. Please come back tomorrow.",
        },
        { status: 429 }
      );
    }

    await getUnscopedPrisma().siteReview.create({
      data: {
        site: site as string,
        uid: caller.uid,
        name: displayName,
        photoURL: caller.photoURL,
        verifiedGoogle: caller.verifiedGoogle,
        rating: stars,
        text: cleanText,
        status: "published",
        createdAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    logger.error("POST /api/public/reviews failed", {
      error: (e as Error).message,
    });
    return NextResponse.json(
      { ok: false, error: "Could not save your review right now." },
      { status: 500 }
    );
  }
}
