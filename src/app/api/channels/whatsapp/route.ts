import { NextRequest, NextResponse } from "next/server";
import {
  getWhatsAppStatus,
  initWhatsApp,
  disconnectWhatsApp,
} from "@/lib/channels/whatsapp";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness } from "@/lib/prisma";

// C-07: channel control endpoints previously had no auth — anyone could
// connect/disconnect WhatsApp. Require channel permissions.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "channels:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    const status = getWhatsAppStatus();
    return NextResponse.json(status);

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "channels:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    const body = await request.json();
    const { action } = body;

    if (action === "connect") {
      await initWhatsApp();
      // Wait a moment for QR to generate
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = getWhatsAppStatus();
      return NextResponse.json(status);
    }

    if (action === "disconnect") {
      await disconnectWhatsApp();
      return NextResponse.json({ status: "disconnected" });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  });
}
