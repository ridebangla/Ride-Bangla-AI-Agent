import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { resolveTenantLogoUrl } from "@/lib/tenant-logo";
import { getCompanyIdentity } from "@/lib/company-identity";
import {
  PORTAL_ORIGIN_HOST,
  companyAiBusinessIds,
  requestOriginHost,
  resolvePortalSurface,
} from "@/lib/portal-surface";
import { getUnscopedPrisma } from "@/lib/prisma";

/**
 * GET /api/widget/identity?siteKey=... — public widget identity for the
 * canonical embed (owner 2026-10-29: setup completion must flip identity
 * automatically, trial and paid alike).
 *
 * PROBLEM IT SOLVES: the embed's header title and greeting come only
 * from the host page's data-title / data-greeting attributes. A tenant
 * whose name changed after setup (onboarding, Settings edit) keeps the
 * OLD title on every already-embedded widget, and a widget embedded
 * without a title shows the generic "AI Assistant" header — never the
 * business's own name. This route lets the embed resolve the CURRENT
 * server-side name at load time, with no host change and no re-copy.
 *
 * RESOLUTION (server-side only, never client-supplied): Settings
 * businessName wins, the "My Business" schema sentinel is stripped and
 * falls back to Business.name, and a business with no usable name gets
 * businessName: null (the embed keeps its generic header — generic is
 * honest; an invented name or the platform name never is).
 *
 * welcomeMessage is returned ONLY when the owner actually changed it:
 * the platform default "Hello! How can I help you today?" is treated as
 * unset (null), so the embed keeps its own localized generic greeting
 * instead of pretending a default is the owner's greeting. A titled
 * greeting template ("Hi! I'm {title}...") is NOT invented here — it
 * stays an owner-pending item in the widget batch.
 *
 * Tenant logo (Team Logo-Feature 2026-11-03): the payload also carries
 * the tenant's OWN Business.logoUrl, resolved server-side from the
 * siteKey's business and passed through resolveTenantLogoUrl — the
 * embed shows it as a header badge beside the business name (the
 * agent mascot avatar itself stays the platform brand record from
 * GET /api/widget/brand, which has no tenant dimension). A tenant with
 * no usable logo gets logoUrl: null, and the embed renders no logo
 * element at all — never the platform default, never another tenant's
 * mark, never a broken image. Portal turns report null for the same
 * reason portal turns report no welcome: the portal header is the
 * product name, not the company business's own mark.
 *
 * PAYLOAD SAFETY: only the business's public widget name, its public
 * welcome text, its public logo, and the portal flag. The siteKey is public by design
 * (printed in the dashboard embed snippet). No secrets, no PII, no
 * internal state. CORS is therefore open for GET (credentials: omit):
 * tenant widgets run on arbitrary tenant origins, so a company-origin
 * allowlist (cf. /api/widget/brand) would defeat the purpose.
 * Fail-soft by contract: unknown siteKey => 404, missing siteKey =>
 * 400, any data-layer error => 503 — never a guessed name.
 */

export const dynamic = "force-dynamic";

// Public-path entries bypass the middleware's general API limiter, so
// this handler rate-limits per IP like the other public GETs (reviews:
// 120/min). Pairing note (fix 2026-11-01): this route MUST stay in
// middleware publicPaths + PUBLIC_EMBED_PREFIXES — the embed fetches
// with credentials:omit, so any cookie gate 401s every visitor and the
// server-side identity (business name, owner welcome, portal product
// name) never resolves.
const GET_RATE_LIMIT = { maxRequests: 120, windowMs: 60 * 1000 };

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

const PLATFORM_DEFAULT_GREETING = "Hello! How can I help you today?";
const PLACEHOLDER_NAME = "My Business";

function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v || v === PLACEHOLDER_NAME) return "";
  return v;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function GET(request: NextRequest) {
  const rl = checkRateLimit(
    `widget-identity:${clientIp(request)}`,
    GET_RATE_LIMIT
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests — please try again soon." },
      {
        status: 429,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  }
  const siteKey = request.nextUrl.searchParams.get("siteKey") ?? "";
  if (!siteKey) {
    return NextResponse.json(
      { error: "siteKey is required" },
      {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  }

  try {
    const business = await getBusinessBySiteKey(siteKey);
    if (!business) {
      return NextResponse.json(
        { error: "Unknown siteKey." },
        {
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    let settingsName = "";
    let welcomeMessage: string | null = null;
    try {
      const settings = await getUnscopedPrisma().settings.findUnique({
        where: { businessId: business.id },
      });
      settingsName = cleanName(
        (settings as { businessName?: unknown } | null)?.businessName
      );
      const rawWelcome = (
        settings as { welcomeMessage?: unknown } | null
      )?.welcomeMessage;
      if (typeof rawWelcome === "string") {
        const w = rawWelcome.trim();
        welcomeMessage = w && w !== PLATFORM_DEFAULT_GREETING ? w : null;
      }
    } catch {
      // Settings unreadable: fall back to Business.name below, never fail
      // the whole identity lookup over the greeting field.
      settingsName = "";
      welcomeMessage = null;
    }

    // PORTAL BRANCH (AI-site own-agent fix, 2026-10-30 — same
    // server-side rule as the widget chat route, see
    // src/lib/portal-surface.ts): the company business on the AI site
    // itself reports the product name, so the AI-site header shows
    // "Ride Bangla AI Agent" instead of the company business name.
    // Host data-title still always wins client-side (the embed is
    // untouched), and every other origin keeps today's behaviour
    // exactly. The company-identity read runs only for AI-origin
    // turns whose business is not already internal; a failed read
    // degrades to the isInternalAccount leg only, never to a
    // guessed name. The `portal` field below is deliberately
    // unchanged (still the raw isInternalAccount flag) — only
    // businessName gains the portal branch.
    const portalOriginHost = requestOriginHost((name) =>
      request.headers.get(name)
    );
    let portalAiBusinessIds: string[] = [];
    if (
      portalOriginHost === PORTAL_ORIGIN_HOST &&
      business.isInternalAccount !== true
    ) {
      try {
        portalAiBusinessIds = companyAiBusinessIds(
          await getCompanyIdentity()
        );
      } catch {
        portalAiBusinessIds = [];
      }
    }
    const isPortal = resolvePortalSurface({
      isInternalAccount: business.isInternalAccount === true,
      businessId: business.id,
      aiBusinessIds: portalAiBusinessIds,
      originHost: portalOriginHost,
    });

    const businessName = isPortal
      ? "Ride Bangla AI Agent"
      : settingsName || cleanName(business.name) || null;

    // Tenant logo: server-resolved from the siteKey's own business row
    // (never from a client-supplied value — a visitor must not be able
    // to make a widget display another tenant's logo by passing a URL).
    // A failed read degrades to null (no logo element), never to a
    // guessed mark, mirroring the settings-read fallback above.
    let logoUrl: string | null = null;
    if (!isPortal) {
      try {
        const row = await getUnscopedPrisma().business.findUnique({
          where: { id: business.id },
          select: { logoUrl: true },
        });
        logoUrl = resolveTenantLogoUrl(
          (row as { logoUrl?: unknown } | null)?.logoUrl
        );
      } catch {
        logoUrl = null;
      }
    }

    return NextResponse.json(
      {
        businessName,
        logoUrl,
        // VERIFIER FIX (2026-10-30): a portal turn must not inherit the
        // company business's custom welcome (Main-site copy) under the
        // portal product name — portal turns report no welcome, so the
        // embed falls back to its generic header. Tenant turns unchanged.
        welcomeMessage: isPortal ? null : welcomeMessage,
        portal: business.isInternalAccount === true,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch {
    return NextResponse.json(
      { error: "Identity lookup temporarily unavailable." },
      {
        status: 503,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  }
}
