/**
 * admin-db.ts — shared firebase-admin bootstrap for server-only modules.
 *
 * Billing Phase 2 modules (wallet, auto-verify, fraud-monitor) need raw
 * Firestore access (transactions on `wallets`, `payment_claims`, etc.),
 * which the emulated Prisma layer does not expose. This module initializes
 * firebase-admin ONCE and hands out the Firestore instance.
 *
 * Credential precedence (first one found wins):
 *   1. An already-initialized firebase-admin app (e.g. firestore.ts got
 *      there first) — reused, never re-initialized.
 *   2. FIREBASE_SERVICE_ACCOUNT_KEY (JSON service-account, the
 *      manual-payments.ts pattern).
 *   3. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *      (the firestore.ts pattern).
 *
 * SERVER-ONLY: importing this module never connects — the Admin SDK is
 * initialized lazily on the first getAdminDb() call. Never import from
 * client components.
 */

import admin from "firebase-admin";

let adminDb: admin.firestore.Firestore | null = null;

/** Server-only: the Admin-SDK Firestore instance. Throws an honest error. */
export function getAdminDb(): admin.firestore.Firestore {
  if (adminDb) return adminDb;

  if (admin.apps.length === 0) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccountJson) {
      const projectId =
        process.env.FIREBASE_PROJECT_ID ||
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
        "ride-bangla-app";
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(serviceAccountJson) as admin.ServiceAccount
        ),
        projectId,
      });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      let privateKey = process.env.FIREBASE_PRIVATE_KEY;
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error(
          "Firestore Admin SDK is not configured: set " +
            "FIREBASE_SERVICE_ACCOUNT_KEY or " +
            "FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY."
        );
      }
      privateKey = privateKey.replace(/\\n/g, "\n");
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
        projectId,
      });
    }
  }

  adminDb = admin.firestore(admin.apps[0]!);
  return adminDb;
}

/** Test seam: reset the cached instance (tests only). */
export function __resetAdminDbForTests(): void {
  adminDb = null;
}
