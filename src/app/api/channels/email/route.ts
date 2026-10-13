import { NextRequest, NextResponse } from "next/server";
import {
  startEmailListener,
  stopEmailListener,
  getEmailStatus,
} from "@/lib/channels/email";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

// C-07: channel control endpoints previously had no auth — anyone could
// start/stop the email listener. Require channel permissions.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "channels:read");
  if (!isAuthenticated(auth)) return auth;

  const status = getEmailStatus();
  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "channels:update");
  if (!isAuthenticated(auth)) return auth;

  const body = await request.json();
  const { action } = body;

  if (action === "connect") {
    await startEmailListener();
    const status = getEmailStatus();
    return NextResponse.json(status);
  }

  if (action === "disconnect") {
    await stopEmailListener();
    return NextResponse.json({ status: "disconnected" });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
