import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { logger } from "@/lib/logger";
import { runAutoVerify } from "@/lib/auto-verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/billing/auto-verify — one crypto auto-verify sweep.
 *
 * Scans pending subscription claims on crypto methods (binance/bybit/okx),
 * matches exchange deposits against the claim refCode + amount, approves
 * and activates on match, leaves everything else pending (never
 * auto-rejects).
 *
 * Auth: Super Admin (cookie session with businessId null) OR a scheduler
 * holding CRON_SECRET: `Authorization: Bearer <CRON_SECRET>`.
 * (cronAuth() is not used here — unlike the social schedulers this sweep is
 *  platform-wide, not per-business, so there is no ?business=<slug>.)
 *
 * Success: 200 { ok: true, checked, matched, results[] }.
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
    const results = await runAutoVerify();
    return NextResponse.json({
      ok: true,
      checked: results.length,
      matched: results.filter((r) => r.action === "matched_approved").length,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not configured/i.test(message)) {
      return NextResponse.json(
        {
          error: "auto_verify_unavailable",
          message:
            "Auto-verify is not configured on this server (Admin SDK credentials missing).",
        },
        { status: 503 }
      );
    }
    logger.error("auto-verify sweep failed", { error: message });
    return NextResponse.json(
      {
        error: "auto_verify_failed",
        message: "The auto-verify sweep could not complete.",
      },
      { status: 500 }
    );
  }
}
