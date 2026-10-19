import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { connectMetaAccount } from "@/lib/channels/meta";

export const runtime = "nodejs";

/**
 * Phase 5: Meta OAuth callback. Exchanges the code for a long-lived user
 * token, lists the user's Pages (+ linked Instagram business accounts),
 * and stores each as an AES-encrypted socialAccount row.
 *
 * The state parameter binds this round-trip to the business that started
 * it — a mismatched/absent state fails closed. Requires a valid admin
 * session cookie (the owner just came back from facebook.com in the same
 * browser).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://ai.ridebangla.bd";
  const redirectUri = `${appUrl}/api/social/meta/callback`;

  if (error) {
    logger.warn("[Meta OAuth] user denied or error", { error });
    return NextResponse.redirect(
      `${appUrl}/channels?meta=denied`,
      { status: 302 }
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/channels?meta=error`, {
      status: 302,
    });
  }

  let businessId: string | null = null;
  try {
    const parsed = JSON.parse(
      Buffer.from(state, "base64url").toString("utf8")
    ) as { businessId?: string };
    businessId = parsed.businessId || null;
  } catch {
    businessId = null;
  }
  if (!businessId) {
    logger.warn("[Meta OAuth] bad state — failing closed");
    return NextResponse.redirect(`${appUrl}/channels?meta=error`, {
      status: 302,
    });
  }

  try {
    const stored = await runWithBusiness(businessId, () =>
      connectMetaAccount(code, redirectUri)
    );
    logger.info("[Meta OAuth] accounts connected", {
      businessId,
      count: stored.length,
    });
    return NextResponse.redirect(`${appUrl}/channels?meta=connected`, {
      status: 302,
    });
  } catch (err) {
    logger.error("[Meta OAuth] connect failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.redirect(`${appUrl}/channels?meta=error`, {
      status: 302,
    });
  }
}
