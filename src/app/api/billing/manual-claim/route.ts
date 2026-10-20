import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  isPaidPlanId,
  isBillingInterval,
  PLAN_META,
  type PaidPlanId,
  type BillingInterval,
} from "@/lib/plans";
import {
  DuplicateTxnError,
  isManualMethodId,
  isMethodEnabled,
  createPaymentClaim,
  isClaimKind,
  type ManualMethodId,
  type ClaimKind,
} from "@/lib/manual-payments";
import {
  checkScreenshot,
  SCREENSHOT_ERROR_MESSAGES,
} from "@/lib/claim-input";
import { runFraudHeuristics } from "@/lib/fraud-monitor";
import { kickVisionPreRead } from "@/lib/auto-verify";
import { createDepositClaim, WalletError } from "@/lib/wallet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/billing/manual-claim — submit a manual payment claim.
 *
 * Two kinds (body.kind, default 'subscription'):
 *
 *  kind='subscription' — the customer paid for a PLAN via a user-configured
 *  manual method (bank transfer / crypto / WeChat Pay) and submits BOTH
 *  required proofs:
 *    1. txnId — transaction ID / hash ID (required text)
 *    2. screenshotDataUrl — payment screenshot, client-compressed to <=400KB
 *       JPEG (required; Firebase Storage is blocked until Blaze, so the
 *       compressed image is stored as base64 in the claim doc — stays under
 *       Firestore's 1MB doc limit. Migrate to Storage post-Blaze.)
 *  Body: { plan, interval?, method, reference?, txnId, screenshotDataUrl }
 *
 *  kind='wallet_deposit' — the customer tops up their SaaS wallet instead
 *  of buying a plan directly.
 *  Body: { method, amountUsd, txnId, screenshotDataUrl }
 *
 * Both kinds:
 *  - generate a unique server-side refCode (RB-XXXXXXXX); the customer is
 *    shown it with "include this reference in your payment note".
 *  - run the fraud heuristics at creation (async signals, never blocking).
 *  - kick the Tier-2 vision pre-read of the screenshot (async, never throws).
 *
 * Success: 200 { ok: true, claimId, refCode }. The claim lands in
 * `payment_claims` with status 'pending'; the team verifies it in the Admin
 * Console (crypto claims may auto-verify via POST /api/billing/auto-verify).
 *
 * Honest failures (never a silent drop):
 *  401/403  auth (requireAuth — tenant admins only, settings:update)
 *  400      bad kind / plan / method / reference / txnId / amount
 *  400      screenshot_too_large — the compressed image still exceeds the
 *           400KB cap; the customer is asked for a smaller/clearer screenshot
 *  400      invalid_screenshot — not a data-URL image
 *  409      method_disabled — the method was turned off after the page loaded
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

  // Money-moving endpoint: per-account + per-IP, honest 429.
  const claimIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const claimRl = checkRateLimit(
    `claim:${auth.businessId}:${claimIp}`,
    RATE_LIMITS.claim
  );
  if (!claimRl.allowed) {
    const claimRes = NextResponse.json(
      {
        error: "rate_limited",
        message:
          "Too many payment claims submitted. Please wait a while and try again.",
      },
      { status: 429 }
    );
    claimRes.headers.set(
      "Retry-After",
      String(Math.ceil((claimRl.resetAt - Date.now()) / 1000))
    );
    return claimRes;
  }

  let body: {
    kind?: unknown;
    plan?: unknown;
    interval?: unknown;
    method?: unknown;
    reference?: unknown;
    amountUsd?: unknown;
    txnId?: unknown;
    screenshotDataUrl?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be JSON." },
      { status: 400 }
    );
  }

  const kind: ClaimKind = isClaimKind(body.kind) ? body.kind : "subscription";

  const method: ManualMethodId | null = isManualMethodId(body.method)
    ? body.method
    : null;
  if (!method) {
    return NextResponse.json(
      {
        error: "invalid_method",
        message: "method must be a configured manual payment method.",
      },
      { status: 400 }
    );
  }
  // Re-check at claim time: the owner may have disabled the method after
  // the /billing page loaded. Never accept a claim for a disabled method.
  if (!(await isMethodEnabled(method))) {
    return NextResponse.json(
      {
        error: "method_disabled",
        message:
          "This payment method is no longer available. Please choose another method or contact us.",
      },
      { status: 409 }
    );
  }

  const txnId = typeof body.txnId === "string" ? body.txnId.trim() : "";
  if (!txnId || txnId.length > 200) {
    return NextResponse.json(
      {
        error: "txn_id_required",
        message: "The transaction ID / hash ID is required.",
      },
      { status: 400 }
    );
  }

  const screenshotDataUrl =
    typeof body.screenshotDataUrl === "string"
      ? body.screenshotDataUrl.trim()
      : "";
  const shotCheck = checkScreenshot(screenshotDataUrl);
  if (!shotCheck.ok) {
    return NextResponse.json(
      {
        error: shotCheck.error,
        message: SCREENSHOT_ERROR_MESSAGES[shotCheck.error],
      },
      { status: 400 }
    );
  }

  // ---- kind='wallet_deposit': top up the SaaS wallet instead of a plan ----
  if (kind === "wallet_deposit") {
    const amountUsd =
      typeof body.amountUsd === "number"
        ? body.amountUsd
        : Number(body.amountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1_000_000) {
      return NextResponse.json(
        {
          error: "invalid_amount",
          message: "amountUsd must be a positive USD amount.",
        },
        { status: 400 }
      );
    }
    try {
      const { claimId, refCode } = await createDepositClaim(auth.businessId, {
        method,
        amountCents: Math.round(amountUsd * 100),
        txnId,
        screenshotDataUrl,
      });
      return NextResponse.json({ ok: true, claimId, refCode });
    } catch (err) {
      if (err instanceof WalletError) {
        const status =
          err.code === "method_disabled" || err.code === "duplicate_txn"
            ? 409
            : 400;
        return NextResponse.json(
          { error: err.code, message: err.message },
          { status }
        );
      }
      logger.error("manual-claim (wallet_deposit) create failed", {
        businessId: auth.businessId,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          error: "claim_failed",
          message:
            "We could not record your claim right now. Please try again or contact us.",
        },
        { status: 500 }
      );
    }
  }

  // ---- kind='subscription': pay for a plan ----
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

  // The customer-supplied reference is kept for backwards compatibility
  // with older claims; the server-generated refCode is the field of
  // record going forward. Optional as of Billing Phase 2.
  const reference =
    typeof body.reference === "string" ? body.reference.trim() : "";
  if (reference.length > 120) {
    return NextResponse.json(
      {
        error: "invalid_reference",
        message: "The payment reference is too long.",
      },
      { status: 400 }
    );
  }

  // Amount is computed server-side from the plan catalog — never trusted
  // from the client.
  const amount =
    interval === "yearly"
      ? PLAN_META[plan].yearlyPriceUsd
      : PLAN_META[plan].priceUsd;

  try {
    const { claimId, refCode } = await createPaymentClaim({
      businessId: auth.businessId,
      kind: "subscription",
      plan,
      interval,
      method,
      amount,
      amountCents: Math.round(amount * 100),
      reference,
      txnId,
      screenshotDataUrl,
    });
    // Fraud heuristics + Tier-2 vision pre-read: async, never block the claim.
    const base = {
      businessId: auth.businessId,
      claimId,
      kind: "subscription" as ClaimKind,
      amountCents: Math.round(amount * 100),
      plan,
      interval,
      txnId,
    };
    await runFraudHeuristics(base);
    kickVisionPreRead(claimId);
    return NextResponse.json({ ok: true, claimId, refCode });
  } catch (err) {
    if (err instanceof DuplicateTxnError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: 409 }
      );
    }
    logger.error("manual-claim create failed", {
      businessId: auth.businessId,
      plan,
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: "claim_failed",
        message:
          "We could not record your claim right now. Please try again or contact us.",
      },
      { status: 500 }
    );
  }
}
