import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { snoozeConversation } from "@/lib/conversation-engine";
import { logger } from "@/lib/logger";
import { runWithBusiness } from "@/lib/prisma";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { snoozeUntil, reason } = body;

      if (!snoozeUntil) {
        return NextResponse.json(
          { error: "snoozeUntil is required" },
          { status: 400 }
        );
      }

      const success = await snoozeConversation(
        id,
        new Date(snoozeUntil),
        reason || "",
        auth.name
      );

      return NextResponse.json({ success });
    } catch (error) {
      logger.error("Failed to snooze conversation:", error);
      return NextResponse.json(
        { error: "Failed to snooze" },
        { status: 500 }
      );
    }

  });
}
