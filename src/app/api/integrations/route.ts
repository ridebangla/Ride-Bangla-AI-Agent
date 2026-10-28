import { NextRequest, NextResponse } from "next/server";
import {
  prisma,
  getUnscopedPrisma,
  runWithBusiness,
} from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { isWhatsAppCloudConfigured } from "@/lib/channels/whatsapp-cloud";
import { isXConfigured } from "@/lib/social/x";
import {
  deriveIntegrationStatuses,
  type HubEvidence,
} from "@/lib/integrations";

/**
 * GET /api/integrations — Integrations Hub status (STAGED, Leg F).
 *
 * DISPLAY ONLY: no connector is created, changed, or tested here.
 * Tenant-scoped exactly like /api/channels: the caller needs
 * "integrations:read" (supervisor + admin, same roles as
 * "channels:read"), and every tenant query runs inside
 * runWithBusiness(auth.businessId). A caller with no workspace
 * (Super Admin outside a workspace) gets a 400, mirroring the
 * per-channel route — the hub never falls back to another
 * tenant's data and never returns a platform-wide list.
 *
 * SECRET RULE — the response carries booleans and counts ONLY:
 * - social accounts: { platform, isActive } selected, then reduced
 *   to active platform names. Labels, account refs, token hints,
 *   and token material are never selected and never returned.
 * - channels: only { type, status, isActive } selected. The config
 *   object (which holds third-party credentials) is never selected
 *   and never returned.
 * - business: only presence booleans + website status counts are
 *   derived. siteKey, partnerId, and stripeCustomerId VALUES are
 *   never returned; website URLs/hosts are never returned.
 * - webhooks: a count of active rows only. URLs, headers, and
 *   delivery payloads are never returned.
 * - platform env checks return booleans only (see integrations.ts:
 *   platform-configured without a tenant record is "unknown",
 *   never "connected").
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "integrations:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business selected." },
      { status: 400 },
    );
  }
  const businessId = auth.businessId;

  try {
    const items = await runWithBusiness(businessId, async () => {
      const [channels, socialAccounts, activeWebhookCount] =
        await Promise.all([
          prisma.channel.findMany({
            select: { type: true, status: true, isActive: true },
          }),
          prisma.socialAccount.findMany({
            select: { platform: true, isActive: true },
          }),
          prisma.webhook.count({ where: { isActive: true } }),
        ]);

      // Business fields are read with the same explicit-where pattern
      // as /api/profile (unscoped client + where id), because the
      // business row itself is not tenant-scoped by the shim.
      const db = getUnscopedPrisma();
      const business = await db.business.findUnique({
        where: { id: businessId },
        select: {
          siteKey: true,
          websites: true,
          partnerId: true,
          courierDeliveryEnabled: true,
          stripeCustomerId: true,
        },
      });

      const channelMap: Record<
        string,
        { status: string; isActive: boolean }
      > = {};
      for (const ch of channels) {
        channelMap[ch.type] = {
          status: typeof ch.status === "string" ? ch.status : "",
          isActive: ch.isActive === true,
        };
      }

      const websites = Array.isArray(business?.websites)
        ? (business?.websites as { status?: unknown }[])
        : [];
      let websiteIndexedCount = 0;
      let websitePendingCount = 0;
      let websiteFailedCount = 0;
      for (const w of websites) {
        if (w.status === "indexed") websiteIndexedCount += 1;
        else if (w.status === "pending") websitePendingCount += 1;
        else if (w.status === "failed") websiteFailedCount += 1;
      }

      const evidence: HubEvidence = {
        channels: channelMap,
        activeSocialPlatforms: socialAccounts
          .filter((a) => a.isActive === true)
          .map((a) => a.platform),
        whatsappCloudConfigured: isWhatsAppCloudConfigured(),
        xConfigured: isXConfigured(),
        hasSiteKey:
          typeof business?.siteKey === "string" &&
          business.siteKey.length > 0,
        websiteIndexedCount,
        websitePendingCount,
        websiteFailedCount,
        partnerIdSet:
          typeof business?.partnerId === "string" &&
          business.partnerId.trim().length > 0,
        courierDeliveryEnabled: business?.courierDeliveryEnabled === true,
        activeWebhookCount,
        stripeCustomerIdSet:
          typeof business?.stripeCustomerId === "string" &&
          business.stripeCustomerId.length > 0,
      };

      return deriveIntegrationStatuses(evidence);
    });

    return NextResponse.json({ items });
  } catch (error) {
    logger.error("Failed to fetch integrations:", error);
    return NextResponse.json(
      { error: "Failed to fetch integrations" },
      { status: 500 },
    );
  }
}
