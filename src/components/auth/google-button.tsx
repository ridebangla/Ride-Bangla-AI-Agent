"use client";

/**
 * Google one-tap button: Firebase client sign-in with Google, then the
 * Firebase ID token is exchanged for our rbai session cookies server-side.
 *
 * endpoint:
 *  - "/api/auth/google"   (signup page — creates the account + trial if new)
 *  - "/api/auth/firebase" (login page — fail-closed, existing accounts only)
 *
 * A-to-Z audit 2026-10-20 (cross-site Google sign-in failure, owner-reported):
 *  - Error codes are no longer swallowed into a bare generic banner: the
 *    Firebase `error.code` is logged and the user message distinguishes
 *    "Google sign-in isn't available yet" (provider disabled in the
 *    Firebase console / domain not authorized / bad API key) from plain
 *    try-again failures.
 *  - Mobile: signInWithPopup is fragile on Android Chrome, so popup
 *    failures that indicate blocking/unsupported environments fall back
 *    to signInWithRedirect, and the redirect result is consumed on
 *    return (getRedirectResult below) and exchanged the same way.
 *
 * Round-2 follow-up 2026-10-21 (mirrors the proven Studio fix 349a6a2d —
 * the owner's Studio button hung on "Loading…" forever):
 *  - Every awaited step is now BOUNDED: signInWithPopup and the token
 *    exchange race a 30 s timeout, signInWithRedirect and
 *    getRedirectResult a 15 s one, so a Firebase promise that never
 *    settles (blocked popup channel, unreachable auth handler) lands on
 *    the honest timeout message instead of spinning "Opening Google…"
 *    without end.
 *  - The exchange resets the busy state in a finally block on every
 *    non-navigating path.
 *  - A redirect-result timeout on a plain page load (no redirect in
 *    flight) stays silent — log only; when the redirect flag is
 *    present (a genuine return the user is waiting on) it surfaces.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  GoogleAuthProvider,
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  type User,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";

function GoogleGlyph() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M6.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l4.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l4.98 3.09C7.22 6.86 9.87 4.75 12 4.75z"
      />
    </svg>
  );
}

/** Codes that mean Google sign-in cannot work at all until the Firebase
 *  project is configured — telling the user to "try again" would be a lie. */
const NOT_AVAILABLE_CODES = new Set([
  "auth/operation-not-allowed",
  "auth/unauthorized-domain",
  "auth/invalid-api-key",
  "auth/api-key-not-valid",
  "auth/configuration-not-found",
  "auth/admin-restricted-operation",
]);

const REDIRECT_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
]);

function errorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

const TIMEOUT_MESSAGE =
  "Google sign-in timed out. Check your connection and try again.";

/** Session-storage flag set just before signInWithRedirect fires, so
 *  the mount effect can tell a genuine redirect return (where a stuck
 *  getRedirectResult MUST surface) from a plain page load (where a
 *  redirect-result timeout stays silent — log only). */
const REDIRECT_FLAG = "rbai-google-redirect";

/** Worst case the user ever waits on the spinner before an honest error. */
const POPUP_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 30_000;
const REDIRECT_TIMEOUT_MS = 15_000;

type SignInTimeoutError = Error & { isSignInTimeout?: true };

function signInTimeoutError(): SignInTimeoutError {
  const err = new Error(TIMEOUT_MESSAGE) as SignInTimeoutError;
  err.isSignInTimeout = true;
  return err;
}

function isSignInTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isSignInTimeout?: unknown }).isSignInTimeout === true
  );
}

/**
 * Race a promise against a bounded wait. Handlers are attached to the
 * underlying promise either way, so a late settlement after the
 * timeout never surfaces as an unhandled rejection.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  makeError: () => Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function GoogleButton({
  endpoint,
  label,
  onError,
}: {
  endpoint: "/api/auth/google" | "/api/auth/firebase";
  label: string;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const exchangingRef = useRef(false);

  async function exchange(user: User) {
    if (exchangingRef.current) return;
    exchangingRef.current = true;
    setLoading(true);
    // Stays false unless the session was created and we are navigating
    // to /dashboard; the finally below guarantees the busy state ALWAYS
    // resets otherwise.
    let navigating = false;
    try {
      const idToken = await withTimeout(
        user.getIdToken(),
        SESSION_TIMEOUT_MS,
        () => signInTimeoutError()
      );
      const res = await withTimeout(
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        }),
        SESSION_TIMEOUT_MS,
        () => signInTimeoutError()
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(data.error || "Google sign-in failed. Please try again.");
        return;
      }
      navigating = true;
      router.replace("/dashboard");
    } catch (err) {
      if (isSignInTimeout(err)) {
        onError(TIMEOUT_MESSAGE);
      } else {
        onError(
          "Google sign-in failed. Please check your connection and try again."
        );
      }
    } finally {
      if (!navigating) {
        setLoading(false);
        exchangingRef.current = false;
      }
    }
  }

  // Redirect-return path: if the user just came back from
  // signInWithRedirect, finish the same token exchange.
  useEffect(() => {
    let cancelled = false;
    // Read + clear the redirect flag first: it distinguishes a genuine
    // redirect return from a plain page load. Storage may be
    // unavailable — the result is still consumed either way (never gate
    // consumption on the flag); the flag only controls whether a
    // redirect-result TIMEOUT is surfaced or stays silent.
    let hadRedirectFlag = false;
    try {
      hadRedirectFlag = window.sessionStorage.getItem(REDIRECT_FLAG) === "1";
      window.sessionStorage.removeItem(REDIRECT_FLAG);
    } catch {
      /* storage unavailable */
    }
    (async () => {
      try {
        const auth = getFirebaseAuth();
        const result = await withTimeout(
          getRedirectResult(auth),
          REDIRECT_TIMEOUT_MS,
          () => signInTimeoutError()
        );
        if (!cancelled && result?.user) {
          onError("");
          exchange(result.user);
        }
      } catch (err) {
        if (cancelled) return;
        if (isSignInTimeout(err)) {
          // A timeout with no redirect in flight is not a user-facing
          // failure — stay silent, log only. On a genuine redirect
          // return the user is waiting on us: surface it honestly.
          console.error("[google-signin] redirect result timed out:", err);
          if (hadRedirectFlag) onError(TIMEOUT_MESSAGE);
          return;
        }
        const code = errorCode(err);
        console.error("[google-signin] redirect result failed:", code || err);
        if (NOT_AVAILABLE_CODES.has(code)) {
          onError(
            "Google sign-in isn't available yet. Please use email sign-in for now, or contact support."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reportFailure(err: unknown) {
    if (isSignInTimeout(err)) {
      console.error("[google-signin] timed out:", err);
      onError(TIMEOUT_MESSAGE);
      setLoading(false);
      return;
    }
    const code = errorCode(err);
    console.error("[google-signin] failed:", code || err);
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      // Customer closed the popup — not an error, just let them retry.
    } else if (NOT_AVAILABLE_CODES.has(code)) {
      onError(
        "Google sign-in isn't available yet. Please use email sign-in for now, or contact support."
      );
    } else if (
      err instanceof Error &&
      err.message.includes("NEXT_PUBLIC_FIREBASE")
    ) {
      onError("Sign-in is not configured. Please contact support.");
    } else {
      onError("Google sign-in failed. Please try again.");
    }
    setLoading(false);
  }

  async function handleClick() {
    setLoading(true);
    onError("");
    let auth;
    try {
      auth = getFirebaseAuth();
    } catch (err) {
      reportFailure(err);
      return;
    }
    const provider = new GoogleAuthProvider();
    try {
      const cred = await withTimeout(
        signInWithPopup(auth, provider),
        POPUP_TIMEOUT_MS,
        () => signInTimeoutError()
      );
      await exchange(cred.user);
    } catch (err) {
      const code = errorCode(err);
      if (REDIRECT_FALLBACK_CODES.has(code)) {
        // Popup path is unusable in this browser (common on Android
        // Chrome) — full-page redirect instead; the result is consumed
        // by the getRedirectResult effect above when the user returns.
        // Flag the navigation first so the effect can tell a genuine
        // redirect return from a plain page load.
        try {
          window.sessionStorage.setItem(REDIRECT_FLAG, "1");
        } catch {
          /* storage unavailable — redirect result is still attempted */
        }
        try {
          await withTimeout(
            signInWithRedirect(auth, provider),
            REDIRECT_TIMEOUT_MS,
            () => signInTimeoutError()
          );
          return; // page is navigating away
        } catch (redirectErr) {
          reportFailure(redirectErr);
          return;
        }
      }
      reportFailure(err);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="w-full rounded-lg bg-white border border-rbai-border text-rbai-text font-medium py-2.5 px-4 text-sm hover:bg-rbai-bg disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3"
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-rbai-primary border-t-transparent" />
      ) : (
        <GoogleGlyph />
      )}
      {loading ? "Opening Google…" : label}
    </button>
  );
}
