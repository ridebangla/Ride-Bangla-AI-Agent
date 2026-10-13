/**
 * SSRF protection for outbound fetches (C-08 / M-54).
 *
 * `validateOutboundUrl()` must be called before ANY server-side fetch of a
 * caller/admin-configured URL (webhook test, webhook delivery, webhook
 * create/update). It enforces:
 *  - http/https scheme only
 *  - no credentials in the URL
 *  - blocked metadata / internal hostnames (169.254.169.254, localhost,
 *    metadata.google.internal, *.localhost, *.local, *.internal, ...)
 *  - every DNS-resolved address must be a public IP: private, loopback,
 *    link-local, CGNAT, multicast, reserved, documentation, and
 *    IPv4-mapped IPv6 addresses are rejected
 *  - non-standard numeric IP spellings (decimal / hex / octal) are rejected,
 *    so `http://2130706433/` cannot smuggle 127.0.0.1 past the check
 *
 * Residual risk (documented, not silently ignored): DNS rebinding / TOCTOU —
 * the address fetched may differ from the address validated if the hostname's
 * DNS changes between validation and fetch. Fully closing that requires
 * fetching by pinned IP with Host/SNI handling, which is out of scope here;
 * validation still blocks the direct private-URL cases (the reported hole).
 */
import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".metadata.google.internal",
];

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Reject non-standard numeric IP spellings (decimal, hex, octal, short forms). */
function isSuspiciousNumericHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // Pure decimal integer (e.g. 2130706433 == 127.0.0.1)
  if (/^\d+$/.test(host)) return true;
  // Hex (0x7f000001) or octal-looking parts
  if (/^0x[0-9a-f]+$/.test(host)) return true;
  const parts = host.split(".");
  if (
    parts.length > 0 &&
    parts.length <= 4 &&
    parts.every((p) => /^[0-9a-fx]+$/.test(p) && p.length > 0) &&
    parts.some((p) => /^0x/.test(p) || (/^0\d+$/.test(p) && p !== "0"))
  ) {
    return true;
  }
  // Fewer than 4 numeric parts (e.g. 127.1) is an alternate localhost spelling.
  if (
    parts.length > 0 &&
    parts.length < 4 &&
    parts.every((p) => /^\d+$/.test(p))
  ) {
    return true;
  }
  return false;
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part) || part.length > 3) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    // Leading zeros are an alternate-spelling trick (0177 == 127).
    if (part.length > 1 && part.startsWith("0")) return null;
    octets.push(n);
  }
  return octets;
}

function isPublicIPv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o;
  // 0.0.0.0/8 (this network)
  if (a === 0) return false;
  // 10.0.0.0/8 private
  if (a === 10) return false;
  // 100.64.0.0/10 CGNAT — not globally routable
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 127.0.0.0/8 loopback
  if (a === 127) return false;
  // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24 (IETF protocol assignments) + 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0) return false;
  // 192.88.99.0/24 (6to4 relay, deprecated)
  if (a === 192 && b === 88) return false;
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51) return false;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 113) return false;
  // 224.0.0.0/4 multicast
  if (a >= 224 && a <= 239) return false;
  // 240.0.0.0/4 reserved
  if (a >= 240) return false;
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped / compatible: ::ffff:127.0.0.1 — check the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIPv4(mapped[1]);
  const compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (compat) return isPublicIPv4(compat[1]);
  // Unspecified :: / loopback ::1
  if (lower === "::" || lower === "::1") return false;
  // fe80::/10 link-local, fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]*:/.test(lower)) return false;
  if (/^f[c-d][0-9a-f]*:/.test(lower)) return false;
  // 2001:db8::/32 documentation
  if (lower.startsWith("2001:db8:")) return false;
  // ff00::/8 multicast
  if (lower.startsWith("ff")) return false;
  // 2001::/32 Teredo (embeds IPv4) — treat as non-public to be safe.
  if (lower.startsWith("2001:0:") || lower.startsWith("2001:0000:")) return false;
  // 2002::/16 6to4 (embeds IPv4)
  if (lower.startsWith("2002:")) return false;
  return true;
}

function isPublicIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPublicIPv4(ip);
  if (version === 6) return isPublicIPv6(ip);
  return false;
}

export interface OutboundUrlCheck {
  ok: boolean;
  error?: string;
}

/**
 * Validate a URL before the server fetches it. Fail-closed: any parse
 * error, DNS failure, or non-public resolved address returns `{ ok: false }`.
 */
export async function validateOutboundUrl(rawUrl: string): Promise<OutboundUrlCheck> {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, error: "URL is required" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "URLs with embedded credentials are not allowed" };
  }

  // WHATWG URL keeps IPv6 literals bracketed in `hostname` ("[::1]");
  // strip them so IP checks see the real address.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { ok: false, error: "URL must have a host" };
  }
  if (isBlockedHostname(hostname)) {
    return { ok: false, error: "URL host is blocked" };
  }
  if (isSuspiciousNumericHost(hostname)) {
    return { ok: false, error: "URL host uses a non-standard IP spelling" };
  }

  // Literal IP: check it directly without DNS.
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      return { ok: false, error: "URL resolves to a non-public IP address" };
    }
    return { ok: true };
  }

  // Hostname: every resolved address must be public. DNS failure = reject.
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: "Could not resolve URL host" };
  }
  if (!addresses || addresses.length === 0) {
    return { ok: false, error: "Could not resolve URL host" };
  }
  for (const entry of addresses) {
    if (!isPublicIp(entry.address)) {
      return { ok: false, error: "URL resolves to a non-public IP address" };
    }
  }
  return { ok: true };
}
