"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { signInWithEmailAndPassword } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

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
          router.replace("/");
          return;
        }
      } catch {
        // Allow login page to render
      }
      setChecking(false);
    }
    checkAuth();
  }, [router]);

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

      router.replace("/");
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

  if (checking) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-rbai-primary border-t-transparent" />
      </div>
    );
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
          Sign in with your Admin Console email
        </p>
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
        </div>

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
    </div>
    </div>
  );
}
