"use client";

/**
 * SessionKeeper — proactive silent refresh for an open dashboard tab.
 *
 * The access cookie lives 1h; page NAVIGATIONS after it expires are
 * restored transparently by middleware + /api/auth/restore. But a tab
 * that simply STAYS OPEN would start seeing 401s from its own API calls
 * once the hour passes. This keeper closes that gap: while the tab is
 * visible it checks the session status every few minutes (and whenever
 * the tab regains focus); when the access token has lapsed it performs
 * the rotating refresh exchange (POST /api/auth {action:"refresh"})
 * without any user interaction. Only a definitive 401 from the refresh
 * exchange — refresh token expired/revoked, i.e. the 30-day session is
 * truly over — sends the user to /login. Transient failures (offline,
 * rate limit, 5xx) are ignored and retried on the next cycle: a network
 * hiccup must never log anyone out.
 */
import { useEffect, useRef } from "react";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function SessionKeeper() {
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (busyRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      busyRef.current = true;
      try {
        const statusRes = await fetch("/api/auth", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!statusRes.ok) return; // unknown state — never act on it
        const status = (await statusRes.json().catch(() => null)) as {
          authenticated?: boolean;
          setupRequired?: boolean;
        } | null;
        if (cancelled || !status) return;
        if (status.setupRequired || status.authenticated) return;

        // Access token lapsed — try the silent rotating exchange.
        const refreshRes = await fetch("/api/auth", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "refresh" }),
        });
        if (cancelled) return;
        if (refreshRes.status === 401) {
          // The 30-day session is genuinely over.
          window.location.assign("/login");
        }
        // Any other failure is transient: stay put, retry next cycle.
      } catch {
        // Offline / aborted — retry on the next cycle.
      } finally {
        busyRef.current = false;
      }
    };

    void check();
    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return null;
}
