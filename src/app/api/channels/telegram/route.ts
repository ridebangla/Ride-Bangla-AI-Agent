import { NextRequest, NextResponse } from "next/server";
import {
  handleTelegramUpdate,
  verifyTelegramSecretToken,
} from "@/lib/channels/telegram";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  // H-16: verify Telegram's secret_token header BEFORE processing the
  // update. Previously anyone could POST fake updates and trigger AI
  // replies/conversations. This is the provider-signature authentication
  // for this webhook (JWT requireAuth would break Telegram delivery, since
  // Telegram cannot present a JWT) — which is why middleware exempts this
  // path. Fail-closed: missing/mismatched secret, or no secret configured,
  // → 403 and the update is ignored.
  const secretToken = request.headers.get("x-telegram-bot-api-secret-token");
  const verified = await verifyTelegramSecretToken(secretToken);
  if (!verified) {
    logger.warn("[Telegram] Rejected update: invalid or missing secret_token");
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const update = await request.json();

    const businessSlug = request.nextUrl.searchParams.get("business");
    await handleTelegramUpdate(update, businessSlug);

    // Telegram expects 200 OK quickly
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[Telegram] Webhook error:", error);
    return NextResponse.json({ ok: true }); // Always 200 for Telegram
  }
}
