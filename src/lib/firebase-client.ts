/**
 * firebase-client.ts — Firebase client SDK (browser) for sign-in.
 *
 * The AI Agent shares the Admin Console's Firebase project (ride-bangla-app):
 * the same email + password signs into both. Passwords are managed in the
 * Firebase console; this app never sees or stores them.
 */
"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  };
  if (!config.apiKey || !config.authDomain || !config.projectId) {
    throw new Error(
      "Firebase sign-in is not configured (missing NEXT_PUBLIC_FIREBASE_* env vars)."
    );
  }
  app = getApps().length ? getApps()[0] : initializeApp(config);
  auth = getAuth(app);
  return auth;
}
