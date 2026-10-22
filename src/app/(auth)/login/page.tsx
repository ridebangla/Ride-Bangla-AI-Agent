"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";
import { GoogleButton } from "@/components/auth/google-button";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetSending, setResetSending] = useState(false);
  const [resetMsg, setResetMsg] = useState("");

  // The sign-in form renders IMMEDIATELY. The already-signed-in check runs
  // in the background and only redirects when it positively confirms a
  // session — a slow or unavailable /api/auth must never leave the user
  // staring at a spinner on the login page (measured 13.5s blank spinner
  // on a phone viewport while the datastore was degraded, 2026-10-22).
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth");
        const data = await res.json();
        if (data.setupRequired) {
          router.replace("/setup");
          return;
        }
        if (data.authenticated) {
          router.replace("/dashboard");
          return;
        }
      } catch {
        // Stay on the login page — the form is already usable.
      }
    }
    checkAuth();
  }, [router]);

  async function handleForgotPassword() {
    setResetMsg("");
    if (!email.trim()) {
      setResetMsg("Enter your email above first, then tap Forgot password.");
      return;
    }
    setResetSending(true);
    try {
      // Passwords live in Firebase Auth only (this app never stores them),
      // so the reset email is sent by Firebase for the shared project.
      const auth = getFirebaseAuth();
      await sendPasswordResetEmail(auth, email.trim());
      setResetMsg("Password reset email sent. Check your inbox.");
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (code === "auth/invalid-email") {
        setResetMsg("Enter a valid email address first.");
      } else if (code === "auth/too-many-requests") {
        setResetMsg("Too many attempts. Please try again later.");
      } else {
        setResetMsg("Could not send the reset email. Please try again.");
      }
    }
    setResetSending(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Same Firebase project as the Admin Console: one email + password
      // signs into both. Passwords are managed in the Firebase console.
      const auth = getFirebaseAuth();
      const cred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );
      const idToken = await cred.user.getIdToken();

      const res = await fetch("/api/auth/firebase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Sign-in failed. Please try again.");
        setLoading(false);
        return;
      }

      router.replace("/dashboard");
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (
        code === "auth/invalid-credential" ||
        code === "auth/wrong-password" ||
        code === "auth/user-not-found" ||
        code === "auth/invalid-email"
      ) {
        setError("Wrong email or password. Please try again.");
      } else if (code === "auth/too-many-requests") {
        setError("Too many attempts. Please try again later.");
      } else if (code === "auth/network-request-failed") {
        setError("Network error. Check your connection and try again.");
      } else if (err instanceof Error && err.message.includes("NEXT_PUBLIC_FIREBASE")) {
        setError("Sign-in is not configured. Please contact support.");
      } else {
        setError("An unexpected error occurred. Please try again.");
      }
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <video
        src="/login-hero.mp4"
        className="mb-6 rounded-2xl shadow-lg"
        style={{ width: 300, height: 400, objectFit: "cover" }}
        muted
        loop
        playsInline
        autoPlay
        preload="auto"
      />
      <div className="bg-rbai-surface rounded-2xl shadow-lg border border-rbai-border p-8 w-full">
      <div className="flex flex-col items-center mb-8">
        <Image
          src="/agent-avatar.png"
          alt="Ride Bangla AI Agent"
          width={56}
          height={56}
          className="mb-4"
        />
        <h1 className="text-2xl font-bold text-rbai-text">
          Welcome to Ride Bangla AI Agent
        </h1>
        <p className="text-rbai-text-light text-sm mt-1">
          Sign in to your dashboard
        </p>
      </div>

      <GoogleButton
        endpoint="/api/auth/firebase"
        label="Continue with Google"
        onError={setError}
      />

      <div className="flex items-center gap-3 my-6">
        <span className="h-px flex-1 bg-rbai-border" />
        <span className="text-xs text-rbai-text-light">
          or sign in with email
        </span>
        <span className="h-px flex-1 bg-rbai-border" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-rbai-text mb-1.5"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-rbai-text mb-1.5"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow"
            placeholder="Enter your password"
          />
          <div className="text-right mt-1.5">
            <button
              type="button"
              onClick={handleForgotPassword}
              disabled={resetSending}
              className="text-xs text-rbai-primary hover:underline disabled:opacity-60"
            >
              {resetSending ? "Sending..." : "Forgot password?"}
            </button>
          </div>
        </div>

        {resetMsg && (
          <div className="rounded-lg bg-rbai-bg border border-rbai-border px-3.5 py-2.5 text-sm text-rbai-text">
            {resetMsg}
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-rbai-primary text-white font-medium py-2.5 text-sm hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Signing in...
            </span>
          ) : (
            "Sign In"
          )}
        </button>
      </form>
      <p className="text-rbai-text-light text-xs mt-5 text-center">
        The same email and password you use for the Admin Console.
      </p>
      <p className="text-rbai-text-light text-xs mt-3 text-center">
        By signing in, you agree to our{" "}
        <Link href="/terms" className="text-rbai-primary hover:underline">
          Terms &amp; Conditions
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="text-rbai-primary hover:underline">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
    </div>
  );
}

