import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness } from "@/lib/prisma";
import {
  buildMetaOAuthUrl,
  isMetaConfigured,
} from "@/lib/channels/meta";
import { createMetaOAuthState } from "@/lib/meta-oauth-state";

/**
 * Phase 5: start the Meta (Facebook + Instagram) OAuth connect flow.
 *
 * GET /api/social/meta/connect
 *   -> 200 { configured: false, reason } when META_APP_ID/SECRET are absent
 *        (the dashboard renders the honest "not connected yet" state).
 *   -> 200 { configured: true, url } when the app is configured — the
 *        dashboard sends the owner to the Facebook OAuth dialog.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!isMetaConfigured()) {
      return NextResponse.json({
        configured: false,
        reason:
          "Meta app not connected yet. Set META_APP_ID and META_APP_SECRET, then connect.",
        setupGuide: [
          "Create an app at developers.facebook.com",
          "Add the Facebook Login product and the Webhooks product",
          "Set META_APP_ID and META_APP_SECRET in the server environment",
          "Set META_VERIFY_TOKEN to any long random string, and use the same value when configuring the webhook in the Meta dashboard",
          "Then click Connect again",
        ],
      });
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || "https://ai.ridebangla.bd"}/api/social/meta/callback`;
    // State binds the OAuth round-trip to this business — HMAC-signed
    // (see @/lib/meta-oauth-state); the callback verifies the signature
    // and fails closed on anything unsigned, forged or stale.
    if (!auth.businessId) {
      return NextResponse.json({
        configured: false,
        reason:
          "Meta connect runs inside a business workspace — platform administrators have no channels of their own.",
      });
    }
    const state = createMetaOAuthState(auth.businessId);
    if (!state) {
      return NextResponse.json(
        {
          configured: false,
          reason:
            "Meta connect is unavailable: no server signing secret (META_APP_SECRET / JWT_SECRET) is configured.",
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      configured: true,
      url: buildMetaOAuthUrl(redirectUri, state),
    });
  });
}
