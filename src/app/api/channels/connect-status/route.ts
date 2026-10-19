import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness, prisma } from "@/lib/prisma";
import { isMetaConfigured, isMetaWebhookConfigured } from "@/lib/channels/meta";
import {
  isWhatsAppCloudConfigured,
  isWhatsAppCloudWebhookConfigured,
} from "@/lib/channels/whatsapp-cloud";
import { isXConfigured, isXWriteConfigured, getXEnv } from "@/lib/social/x";

/**
 * Phase 5: connection status for the Channels page connect cards.
 *
 * GET /api/channels/connect-status
 *   -> per-channel { configured, details } derived from server env +
 *      stored accounts. No secrets are ever returned — only booleans and
 *      honest setup guidance. When env is missing the card renders the
 *      "not connected yet — see setup guide" state.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "channels:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || "https://ai.ridebangla.bd";

    // Connected Meta accounts (labels only — tokens stay encrypted).
    const metaAccounts = await prisma.socialAccount
      .findMany({
        where: {
          platform: { in: ["facebook", "instagram"] },
          isActive: true,
        },
        select: { id: true, platform: true, label: true, accountRef: true },
      })
      .catch(() => []);

    const xEnv = getXEnv();

    return NextResponse.json({
      meta: {
        configured: isMetaConfigured(),
        webhookConfigured: isMetaWebhookConfigured(),
        accounts: metaAccounts,
        webhookUrl: `${appUrl}/api/webhooks/meta`,
        setupGuide: [
          "Create an app at developers.facebook.com and add the Facebook Login + Webhooks products",
          "Set META_APP_ID and META_APP_SECRET in the server environment",
          "Set META_VERIFY_TOKEN to a long random string",
          "In the Meta dashboard, subscribe the webhook to the URL above with your verify token, then subscribe to page messaging + feed fields",
          "Click Connect and sign in with the Facebook account that owns your Page",
        ],
      },
      whatsappCloud: {
        configured: isWhatsAppCloudConfigured(),
        webhookConfigured: isWhatsAppCloudWebhookConfigured(),
        webhookUrl: `${appUrl}/api/webhooks/whatsapp`,
        setupGuide: [
          "In the Meta developer dashboard, add the WhatsApp product to your app",
          "Copy the Phone number ID and generate a permanent access token",
          "Set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_VERIFY_TOKEN in the server environment",
          "Configure the webhook with the URL above and your verify token, subscribed to messages",
        ],
      },
      x: {
        configured: isXConfigured(),
        writeConfigured: isXWriteConfigured(),
        hasBearer: Boolean(xEnv.bearerToken),
        hasUserContext: Boolean(
          xEnv.apiKey && xEnv.apiSecret && xEnv.accessToken && xEnv.accessSecret
        ),
        webhookUrl: `${appUrl}/api/webhooks/x`,
        setupGuide: [
          "Create a project + app at developer.x.com (paid tier for posting and DM webhooks)",
          "Set X_API_KEY, X_API_SECRET, X_BEARER_TOKEN, X_ACCESS_TOKEN and X_ACCESS_SECRET in the server environment",
          "For DM webhooks, register the webhook URL above in the Account Activity dashboard",
        ],
      },
    });
  });
}
