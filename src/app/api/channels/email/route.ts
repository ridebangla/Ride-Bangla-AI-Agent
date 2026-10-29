import { NextRequest, NextResponse } from "next/server";
import {
  startEmailListener,
  stopEmailListener,
  getEmailStatus,
  testEmailConnection,
} from "@/lib/channels/email";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness, prisma } from "@/lib/prisma";

// C-07: channel control endpoints previously had no auth — anyone could
// start/stop the email listener. Require channel permissions.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "channels:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    const status = getEmailStatus();
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
      await startEmailListener();
      // Return the channel row when it exists so the dashboard badge can
      // merge the real status (IMAP readiness itself lands via the
      // listener's ready handler, which the card polls for).
      const channel = await prisma.channel.findUnique({
        where: { id: `${auth.businessId}:email` },
      });
      if (channel) return NextResponse.json(channel);
      return NextResponse.json(getEmailStatus());
    }

    if (action === "disconnect") {
      await stopEmailListener();
      const updated = await prisma.channel.upsert({
        where: { id: `${auth.businessId}:email` },
        update: { status: "disconnected" },
        create: {
          id: `${auth.businessId}:email`,
          businessId: auth.businessId,
          type: "email",
          config: {},
          isActive: false,
          status: "disconnected",
        },
      });
      return NextResponse.json(updated);
    }

    if (action === "test") {
      const result = await testEmailConnection(
        body.config && typeof body.config === "object" ? body.config : undefined
      );
      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  });
}
