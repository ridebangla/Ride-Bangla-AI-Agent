import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getPlugins } from "@/lib/plugins";
import { logger } from "@/lib/logger";
import { runWithBusiness } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const plugins = getPlugins();
      return NextResponse.json(plugins);
    } catch (error) {
      logger.error("Failed to fetch plugins:", error);
      return NextResponse.json(
        { error: "Failed to fetch plugins" },
        { status: 500 }
      );
    }

  });
}
