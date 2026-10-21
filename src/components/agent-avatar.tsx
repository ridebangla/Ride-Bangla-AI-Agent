"use client";

import { useEffect, useState } from "react";

const FALLBACK_SRC = "/agent-avatar.png";
const BRAND_TIMEOUT_MS = 2500;

interface AgentAvatarProps {
  width?: number;
  height?: number;
  className?: string;
}

/**
 * AgentAvatar — the platform's agent-character bust, brand-aware.
 *
 * Resolves the bust URL from the public agent-brand record
 * (GET /api/widget/brand) at mount with a short fail-soft timeout; a dead
 * endpoint, a timeout, or a partial record leaves the hardcoded platform
 * default in place, so this component can never break a render.
 *
 * Deliberately a plain <img> (not next/image): the brand URL can point at
 * any host the owner uploads to (e.g. Firebase Storage), and next/image
 * rejects non-allowlisted remote hosts at runtime. A 32px chrome icon
 * gains nothing from the Image optimizer.
 */
export function AgentAvatar({
  width = 32,
  height = 32,
  className = "rounded-lg flex-shrink-0",
}: AgentAvatarProps) {
  const [src, setSrc] = useState(FALLBACK_SRC);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      alive = false;
    }, BRAND_TIMEOUT_MS);
    fetch("/api/widget/brand", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((rec) => {
        clearTimeout(timer);
        if (!alive) return;
        const url =
          rec && typeof rec.logoUrl === "string" && rec.logoUrl
            ? rec.logoUrl
            : null;
        if (url) {
          const version = rec.version == null ? 0 : rec.version;
          const sep = url.indexOf("?") >= 0 ? "&" : "?";
          setSrc(url + sep + "v=" + encodeURIComponent(String(version)));
        }
      })
      .catch(() => {
        // Fail-soft: the fallback bust stays.
      });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Ride Bangla AI Agent"
      width={width}
      height={height}
      className={className}
    />
  );
}
