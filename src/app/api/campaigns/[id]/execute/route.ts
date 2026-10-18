import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { findTargetCustomers, type CampaignSegment } from "@/lib/campaigns";
import { logger } from "@/lib/logger";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const campaign = await prisma.campaign.findUnique({ where: { id } });
      if (!campaign) {
        return NextResponse.json(
          { error: "Campaign not found" },
          { status: 404 }
        );
      }

      const customers = await findTargetCustomers(
        campaign.segments as unknown as CampaignSegment[]
      );

      return NextResponse.json({
        campaignId: id,
        targetCount: customers.length,
      });
    } catch (error) {
      logger.error("Failed to execute campaign:", error);
      return NextResponse.json(
        { error: "Failed to execute campaign" },
        { status: 500 }
      );
    }

  });
}
