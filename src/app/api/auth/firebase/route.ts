import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { getUnscopedPrisma } from "@/lib/prisma";
import {
  generateRefreshToken,
  generateToken,
  setSessionCookies,
} from "@/lib/auth";
import {
  findAdminsByEmail,
  pickSignInAdmin,
} from "@/lib/admin-resolution";
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

// POST /api/auth/firebase — sign in with a Firebase ID token.
//
// The AI Agent shares the Admin Console's Firebase project: the same
// email + password signs into both, and passwords are managed entirely in
// the Firebase console (this app never sees them). The login page's
// Google button exchanges here too. There is deliberately NO
// email-verification wall on this route: the password path proves
// control of the account's own credential, and account resolution
// (pickSignInAdmin — uid binding → INTERNAL owner business → earliest)
// lands a verified token on the ONE right record even when several
// admin records share the email, as the holder account's do.
//
// Bootstrap: the first-ever Firebase sign-in becomes Super Admin.
// Afterwards the email must match an existing agent admin (fail-closed).
export async function POST(request: NextRequest) {
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
        { error: "Invalid or expired sign-in. Please sign in again." },
        { status: 401 }
      );
    }

    const email = (decoded.email || "").toLowerCase().trim();
    if (!email) {
      return NextResponse.json(
        { error: "This sign-in has no email address." },
        { status: 403 }
      );
    }

    const db = getUnscopedPrisma();
    const emailAdmins = await findAdminsByEmail(db, email);
    let agentAdmin =
      emailAdmins.length > 0
        ? await pickSignInAdmin(db, emailAdmins, decoded.uid)
        : null;

    if (!agentAdmin) {
      // Bootstrap: no agent admin carries an email yet (e.g. fresh install
      // or migration from the old username/password seed) -> the first
      // Firebase sign-in becomes Super Admin.
      const allAdmins = await db.admin.findMany({});
      const hasEmailAdmin = allAdmins.some(
        (a) => typeof a.email === "string" && a.email
      );
      if (hasEmailAdmin) {
        logger.warn(`[Auth] Firebase sign-in denied (unknown email=${email})`);
        return NextResponse.json(
          { error: "This email is not authorized for the AI Agent." },
          { status: 403 }
        );
      }
      const displayName =
        (decoded.name as string | undefined) || email.split("@")[0];
      agentAdmin = await db.admin.create({
        data: {
          username: email,
          email,
          // Password login is retired; this marker is not a valid bcrypt hash.
          password: "FIREBASE_AUTH",
          name: displayName,
          role: "super_admin",
          businessId: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        } as Record<string, unknown>,
      });
      logger.warn(
        `[Auth] Firebase bootstrap: ${email} became Super Admin of the AI Agent`
      );
    }

    const token = generateToken(agentAdmin.id, agentAdmin.role);
    const refreshToken = generateRefreshToken(agentAdmin.id, agentAdmin.role);

    const response = NextResponse.json({
      success: true,
      user: {
        id: agentAdmin.id,
        email,
        name: agentAdmin.name,
        role: agentAdmin.role,
      },
    });
    setSessionCookies(response, token, refreshToken);
    return response;
  } catch (err) {
    logger.warn(
      `[Auth] Firebase sign-in failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    // A quota-exhausted account store (Firestore RESOURCE_EXHAUSTED) is
    // not a credential failure, and retrying immediately cannot succeed
    // while it lasts - answer honestly instead of implying the visitor's
    // sign-in itself was wrong.
    const errCode =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    const errMessage = err instanceof Error ? err.message : "";
    if (
      errCode === "8" ||
      errCode === "resource-exhausted" ||
      /RESOURCE_EXHAUSTED|quota exceeded/i.test(errMessage)
    ) {
      return NextResponse.json(
        {
          error:
            "Sign-in is temporarily unavailable. Please try again later.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Sign-in failed. Please try again." },
      { status: 500 }
    );
  }
}
