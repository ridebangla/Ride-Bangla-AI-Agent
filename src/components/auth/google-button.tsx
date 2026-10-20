"use client";

/**
 * Google one-tap button: Firebase client sign-in with Google, then the
 * Firebase ID token is exchanged for our rbai session cookies server-side.
 *
 * endpoint:
 *  - "/api/auth/google"   (signup page — creates the account + trial if new)
 *  - "/api/auth/firebase" (login page — fail-closed, existing accounts only)
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
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

  async function handleClick() {
    setLoading(true);
    onError("");
    try {
      const auth = getFirebaseAuth();
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      const idToken = await cred.user.getIdToken();

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        onError(data.error || "Google sign-in failed. Please try again.");
        setLoading(false);
        return;
      }
      router.replace("/dashboard");
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // Customer closed the popup — not an error, just let them retry.
      } else if (code === "auth/popup-blocked") {
        onError("Your browser blocked the Google popup. Please allow popups for this site and try again.");
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
