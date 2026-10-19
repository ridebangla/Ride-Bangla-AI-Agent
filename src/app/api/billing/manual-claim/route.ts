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
  isManualMethodId,
  isMethodEnabled,
  createPaymentClaim,
  type ManualMethodId,
} from "@/lib/manual-payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/billing/manual-claim — submit a manual payment claim.
 *
 * The customer paid via a user-configured manual method (bank transfer /
 * crypto / WeChat Pay) and now submits BOTH required proofs:
 *   1. txnId — transaction ID / hash ID (required text)
 *   2. screenshotDataUrl — payment screenshot, client-compressed to <=400KB
 *      JPEG (required; Firebase Storage is blocked until Blaze, so the
 *      compressed image is stored as base64 in the claim doc — stays under
 *      Firestore's 1MB doc limit. Migrate to Storage post-Blaze.)
 *
 * Body: { plan, interval?, method, reference, txnId, screenshotDataUrl }
 * Success: 200 { ok: true, claimId }. The claim lands in `payment_claims`
 * with status 'pending'; the team verifies it in the Admin Console.
 *
 * Honest failures (never a silent drop):
 *  401/403  auth (requireAuth — tenant admins only, settings:update)
 *  400      bad plan / method / reference / txnId
 *  400      screenshot_too_large — the compressed image still exceeds the
 *           400KB cap; the customer is asked for a smaller/clearer screenshot
 *  400      invalid_screenshot — not a data-URL image
 *  409      method_disabled — the method was turned off after the page loaded
 */

const MAX_SCREENSHOT_BYTES = 400 * 1024;

function screenshotBytes(dataUrl: string): number | null {
  const m = /^data:image\/[a-zA-Z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    // 4 base64 chars ≈ 3 bytes.
    const b64 = m[1];
    const padding = (b64.match(/=+$/) || [""])[0].length;
    return Math.floor((b64.length * 3) / 4) - padding;
  } catch {
    return null;
  }
}

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
    plan?: unknown;
    interval?: unknown;
    method?: unknown;
    reference?: unknown;
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

  const reference =
    typeof body.reference === "string" ? body.reference.trim() : "";
  if (!reference || reference.length > 120) {
    return NextResponse.json(
      {
        error: "invalid_reference",
        message: "A valid payment reference is required.",
      },
      { status: 400 }
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
  const shotBytes = screenshotDataUrl
    ? screenshotBytes(screenshotDataUrl)
    : null;
  if (shotBytes === null) {
    return NextResponse.json(
      {
        error: "invalid_screenshot",
        message: "A valid payment screenshot image is required.",
      },
      { status: 400 }
    );
  }
  if (shotBytes > MAX_SCREENSHOT_BYTES) {
    return NextResponse.json(
      {
        error: "screenshot_too_large",
        message:
          "That screenshot is still larger than 400 KB after compression. Please submit a smaller or clearer screenshot — a cropped image of just the payment confirmation works best.",
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
    const claimId = await createPaymentClaim({
      businessId: auth.businessId,
      plan,
      interval,
      method,
      amount,
      reference,
      txnId,
      screenshotDataUrl,
    });
    return NextResponse.json({ ok: true, claimId });
  } catch (err) {
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
