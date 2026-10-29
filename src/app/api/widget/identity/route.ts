import { NextRequest, NextResponse } from "next/server";
import { getBusinessBySiteKey } from "@/lib/tenant";
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
 * PAYLOAD SAFETY: only the business's public widget name, its public
 * welcome text, and the portal flag. The siteKey is public by design
 * (printed in the dashboard embed snippet). No secrets, no PII, no
 * internal state. CORS is therefore open for GET (credentials: omit):
 * tenant widgets run on arbitrary tenant origins, so a company-origin
 * allowlist (cf. /api/widget/brand) would defeat the purpose.
 * Fail-soft by contract: unknown siteKey => 404, missing siteKey =>
 * 400, any data-layer error => 503 — never a guessed name.
 */

export const dynamic = "force-dynamic";

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

    const businessName = settingsName || cleanName(business.name) || null;

    return NextResponse.json(
      {
        businessName,
        welcomeMessage,
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
