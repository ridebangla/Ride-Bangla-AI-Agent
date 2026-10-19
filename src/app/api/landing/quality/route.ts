/**
 * GET /api/landing/quality?slug= — visual quality gate for a landing page.
 *
 * Public (no session): the slug is the fail-closed scoping mechanism, the
 * same as /p/[slug] itself, and every check is derived from public page
 * data (image URLs, copy, theme, SEO meta). Unknown slug => 404.
 *
 * Response shape: LandingQualityStatus (see src/lib/landing-quality.ts —
 * the Phase 6 Launch Readiness contract is documented there).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkLandingQuality } from "@/lib/landing-quality";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const slug = new URL(request.url).searchParams.get("slug")?.trim();
  if (!slug) {
    return NextResponse.json({ error: "Missing required query param: slug." }, { status: 400 });
  }
  // The check fans out to image fetches — rate-limit per IP so the public
  // endpoint can't be used to make the server fetch at will.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`landing-quality:${ip}`, { maxRequests: 20, windowMs: 60 * 1000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }
  try {
    const status = await checkLandingQuality(slug);
    if (!status) {
      return NextResponse.json({ error: "Landing page not found." }, { status: 404 });
    }
    return NextResponse.json(status);
  } catch (error) {
    logger.error("Landing quality check failed:", error);
    return NextResponse.json({ error: "Quality check failed." }, { status: 500 });
  }
}
