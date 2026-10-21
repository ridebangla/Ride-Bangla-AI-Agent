import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { logger } from "@/lib/logger";
import { runInactiveNotifySweep } from "@/lib/inactive-notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/billing/notify-inactive — one automatic-notification sweep.
 *
 * Writes the tenant-visible `adminNotice` (dashboard banner + bell) for
 * businesses whose trial is ending (<= 3 days), whose trial has ended,
 * or whose subscription is otherwise gate-inactive — deduped per
 * episode, never overwriting a fresh team-written notice. See
 * src/lib/inactive-notify.ts for the full discipline.
 *
 * Auth mirrors /api/billing/auto-verify exactly: the platform Super
 * Admin (cookie session with businessId null) OR a scheduler holding
 * CRON_SECRET: <redacted>
 * Success: 200 { ok: true, checked, sent, results[] }.
 * 503 when the Admin SDK is not configured.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";
  let allowed = false;

  if (secret && header === `Bearer ${secret}`) {
    allowed = true;
  } else {
    const auth = await requireAuth(request);
    if (isAuthenticated(auth) && auth.businessId === null) {
      allowed = true; // Super Admin
    } else if (!isAuthenticated(auth)) {
      return auth; // 401/403 response
    }
  }

  if (!allowed) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "Only the platform Super Admin or the scheduler may run this.",
      },
      { status: 403 }
    );
  }

  try {
    const { checked, sent, results } = await runInactiveNotifySweep();
    return NextResponse.json({ ok: true, checked, sent, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not configured/i.test(message)) {
      return NextResponse.json(
        {
          error: "notify_sweep_unavailable",
          message:
            "The notification sweep is not configured on this server (Admin SDK credentials missing).",
        },
        { status: 503 }
      );
    }
    logger.error("inactive-notify sweep failed", { error: message });
    return NextResponse.json(
      {
        error: "notify_sweep_failed",
        message: "The notification sweep could not complete.",
      },
      { status: 500 }
    );
  }
}
