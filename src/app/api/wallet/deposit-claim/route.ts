import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { isManualMethodId, type ManualMethodId } from "@/lib/manual-payments";
import {
  checkScreenshot,
  SCREENSHOT_ERROR_MESSAGES,
} from "@/lib/claim-input";
import { createDepositClaim, WalletError } from "@/lib/wallet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/wallet/deposit-claim — file a wallet top-up claim.
 *
 * The customer deposited money via a user-configured manual method and now
 * submits BOTH required proofs: the transaction ID and a payment
 * screenshot (client-compressed to <=400KB JPEG).
 *
 * Body: { method, amountUsd, txnId, screenshotDataUrl }
 *   - amountUsd: the deposited amount in USD (converted to integer cents
 *     server-side; the route never trusts a client-computed cent value).
 * Success: 200 { ok: true, claimId, refCode }.
 *
 * The customer is shown the refCode with: "include this reference in your
 * payment note". Fraud heuristics run at creation and a Tier-2 vision
 * pre-read of the screenshot is kicked off — neither blocks the claim.
 *
 * Honest failures (never a silent drop):
 *  401/403  auth (requireAuth — tenant admins only, settings:update)
 *  400      no_billing_account / bad method / amount / txnId / screenshot
 *  409      method_disabled — turned off after the page loaded
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
    method?: unknown;
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

  const amountUsd =
    typeof body.amountUsd === "number" ? body.amountUsd : Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1_000_000) {
    return NextResponse.json(
      {
        error: "invalid_amount",
        message: "amountUsd must be a positive USD amount.",
      },
      { status: 400 }
    );
  }
  // Integer cents — the only money unit downstream (no float math).
  const amountCents = Math.round(amountUsd * 100);
  if (amountCents <= 0) {
    return NextResponse.json(
      {
        error: "invalid_amount",
        message: "amountUsd must be a positive USD amount.",
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
  const shotCheck = checkScreenshot(screenshotDataUrl);
  if (!shotCheck.ok) {
    return NextResponse.json(
      { error: shotCheck.error, message: SCREENSHOT_ERROR_MESSAGES[shotCheck.error] },
      { status: 400 }
    );
  }

  try {
    const { claimId, refCode } = await createDepositClaim(auth.businessId, {
      method,
      amountCents,
      txnId,
      screenshotDataUrl,
    });
    return NextResponse.json({ ok: true, claimId, refCode });
  } catch (err) {
    if (err instanceof WalletError) {
      const status = err.code === "method_disabled" ? 409 : 400;
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status }
      );
    }
    logger.error("wallet deposit-claim create failed", {
      businessId: auth.businessId,
      method,
      amountCents,
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
