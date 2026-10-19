import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  scrapeBusinessWebsite,
  structureFreeText,
  structureGuidedAnswers,
} from "@/lib/scrape";
import { logger } from "@/lib/logger";

// POST /api/onboarding/analyze — turn raw business info into reviewable
// Q&A pairs + product drafts (rule-based, no AI key required).
//
// Body (exactly one of):
//   { url: string }                                    — scrape the website
//   { text: string, sourceName?: string }               — pasted/uploaded text
//   { fields: { businessName, category, whatYouSell, hours, location, contact, policies } }
//                                                       — guided Q&A answers
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;

  // Onboarding belongs to a tenant admin. The Super Admin has no business to
  // onboard (fail-closed).
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "Onboarding requires a business account." },
      { status: 400 }
    );
  }

  // Per-account + per-IP rate limit, honest 429.
  const _rlIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const _rl = checkRateLimit(
    `onboarding:${auth.businessId}:${_rlIp}`,
    RATE_LIMITS.onboarding
  );
  if (!_rl.allowed) {
    const _res = NextResponse.json(
      { error: "rate_limited", message: "Too many analysis requests. Please wait a while and try again." },
      { status: 429 }
    );
    _res.headers.set(
      "Retry-After",
      String(Math.ceil((_rl.resetAt - Date.now()) / 1000))
    );
    return _res;
  }

  try {
    const body = await request.json();

    if (typeof body.url === "string" && body.url.trim()) {
      const structured = await scrapeBusinessWebsite(body.url.trim());
      return NextResponse.json({ success: true, mode: "url", ...structured });
    }

    if (typeof body.text === "string" && body.text.trim()) {
      if (body.text.length > 200_000) {
        return NextResponse.json(
          { error: "Text is too long (max 200,000 characters)." },
          { status: 400 }
        );
      }
      const structured = structureFreeText(
        body.text,
        typeof body.sourceName === "string" && body.sourceName.trim()
          ? body.sourceName.trim().slice(0, 80)
          : "Pasted text"
      );
      return NextResponse.json({ success: true, mode: "text", ...structured });
    }

    if (body.fields && typeof body.fields === "object") {
      const f = body.fields as Record<string, unknown>;
      const str = (v: unknown) =>
        typeof v === "string" ? v.slice(0, 5000) : "";
      const structured = structureGuidedAnswers({
        businessName: str(f.businessName),
        category: str(f.category),
        whatYouSell: str(f.whatYouSell),
        hours: str(f.hours),
        location: str(f.location),
        contact: str(f.contact),
        policies: str(f.policies),
      });
      if (structured.qa.length === 0) {
        return NextResponse.json(
          { error: "Please answer at least one question." },
          { status: 400 }
        );
      }
      return NextResponse.json({ success: true, mode: "guided", ...structured });
    }

    return NextResponse.json(
      { error: "Provide a website URL, text, or guided answers." },
      { status: 400 }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Analysis failed. Please try again.";
    logger.warn(`[Onboarding] analyze failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
