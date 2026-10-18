import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const profiles = await prisma.audienceProfile.findMany({
        orderBy: { updatedAt: "desc" },
      });
      return NextResponse.json(profiles);
    } catch (error) {
      logger.error("Failed to list audience profiles:", error);
      return NextResponse.json(
        { error: "Failed to list audience profiles" },
        { status: 500 }
      );
    }

  });
}
