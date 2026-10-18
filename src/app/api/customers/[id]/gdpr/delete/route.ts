import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { deleteCustomerData } from "@/lib/gdpr";
import { logger } from "@/lib/logger";
import { runWithBusiness } from "@/lib/prisma";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "customers:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { hardDelete } = body;

      const result = await deleteCustomerData(id, hardDelete === true);

      return NextResponse.json(result);
    } catch (error) {
      logger.error("Failed to delete customer data:", error);
      return NextResponse.json(
        { error: "Failed to delete data" },
        { status: 500 }
      );
    }

  });
}
