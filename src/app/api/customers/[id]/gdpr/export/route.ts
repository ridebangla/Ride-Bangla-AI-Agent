import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { exportCustomerData } from "@/lib/gdpr";
import { logger } from "@/lib/logger";
import { runWithBusiness } from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "customers:export");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const data = await exportCustomerData(id);

      if (!data) {
        return NextResponse.json(
          { error: "Customer not found" },
          { status: 404 }
        );
      }

      return NextResponse.json(data);
    } catch (error) {
      logger.error("Failed to export customer data:", error);
      return NextResponse.json(
        { error: "Failed to export data" },
        { status: 500 }
      );
    }

  });
}
