import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  isPaidPlanId,
  isBillingInterval,
  type PaidPlanId,
  type BillingInterval,
} from "@/lib/plans";
import {
  purchaseFromWallet,
  planPriceCents,
  WalletError,
} from "@/lib/wallet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/wallet/purchase — buy/renew a plan from the wallet balance.
 *
 * Body: { plan, interval? } (price is computed server-side from PLAN_META —
 * never trusted from the client).
 * Success: 200 { ok: true, plan, interval, priceCents, balanceCents,
 *                 subscriptionEndsAt } — the subscription is active from
 *                 this call (single atomic transaction).
 *
 * Honest failures:
 *  401/403  auth (requireAuth — tenant admins only, settings:update)
 *  400      invalid plan/interval
 *  402      insufficient_balance — { priceCents, balanceCents } so the UI
 *           can say exactly how much more is needed
 *  429      rate_limited
 */
export async function POST(request: NextRequest) {
  // Money moves only for tenant admins (settings:update = ["admin"]).
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;

  if (!auth.businessId) {
    return NextResponse.json(
      {
        error: "no_billing_account",
        message: "Platform administrators are never billed.",
      },
      { status: 400 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(
    `purchase:${auth.businessId}:${ip}`,
    RATE_LIMITS.claim
  );
  if (!rl.allowed) {
    const res = NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many purchase attempts. Please wait a while and try again.",
      },
      { status: 429 }
    );
    res.headers.set(
      "Retry-After",
      String(Math.ceil((rl.resetAt - Date.now()) / 1000))
    );
    return res;
  }

  let body: { plan?: unknown; interval?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be JSON." },
      { status: 400 }
    );
  }

  const plan: PaidPlanId | null = isPaidPlanId(body.plan) ? body.plan : null;
  if (!plan) {
    return NextResponse.json(
      {
        error: "invalid_plan",
        message: "plan must be one of: starter, growth, pro.",
      },
      { status: 400 }
    );
  }
  const interval: BillingInterval = isBillingInterval(body.interval)
    ? body.interval
    : "monthly";

  try {
    const result = await purchaseFromWallet(auth.businessId, {
      plan,
      interval,
    });
    return NextResponse.json({
      ok: true,
      plan,
      interval,
      priceCents: planPriceCents(plan, interval),
      balanceCents: result.balanceCents,
      subscriptionEndsAt: result.subscriptionEndsAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof WalletError && err.code === "insufficient_balance") {
      return NextResponse.json(
        {
          error: "insufficient_balance",
          message: err.message,
          priceCents: planPriceCents(plan, interval),
        },
        { status: 402 }
      );
    }
    if (err instanceof WalletError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: 400 }
      );
    }
    logger.error("wallet purchase failed", {
      businessId: auth.businessId,
      plan,
      interval,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: "purchase_failed",
        message:
          "We could not complete your purchase right now. Please try again or contact us.",
      },
      { status: 500 }
    );
  }
}
