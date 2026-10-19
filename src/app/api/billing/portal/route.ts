import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  getStripe,
  getAppUrl,
  isBillingConfigured,
  StripeNotConfiguredError,
} from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/billing/portal — create a Stripe Billing Portal session so the
 * tenant can update their card, change plan, view invoices, or cancel.
 * Authenticated, tenant-scoped (settings:update = ["admin"] only).
 *
 * Success: 200 { url } — the frontend redirects the browser there.
 *
 * Honest failures (never a fake portal):
 *  401/403  auth
 *  400      super admin has no billing / no Stripe customer yet
 *  503      billing_not_configured — no Stripe keys yet
 */
export async function POST(request: NextRequest) {
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

  try {
    if (!isBillingConfigured()) throw new StripeNotConfiguredError();
    const stripe = getStripe();
    if (!stripe) throw new StripeNotConfiguredError();

    const business = (await getUnscopedPrisma().business.findUnique({
      where: { id: auth.businessId },
      select: { id: true, name: true, isActive: true, stripeCustomerId: true },
    })) as unknown as {
      id: string;
      name: string;
      isActive: boolean;
      stripeCustomerId?: string;
    } | null;

    if (!business || !business.isActive) {
      return NextResponse.json(
        { error: "unknown_business", message: "Business not found." },
        { status: 404 }
      );
    }

    if (!business.stripeCustomerId) {
      return NextResponse.json(
        {
          error: "no_stripe_customer",
          message:
            "No payment record yet — subscribe to a plan first, then you can manage it here.",
        },
        { status: 400 }
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: business.stripeCustomerId,
      return_url: `${getAppUrl()}/billing`,
    });

    if (!session.url) {
      logger.error("[billing] Stripe portal session has no url");
      return NextResponse.json(
        { error: "portal_failed", message: "Could not open the billing portal. Please try again." },
        { status: 500 }
      );
    }

    logger.info(
      `[billing] portal session created for business ${business.id} (customer ${business.stripeCustomerId})`
    );
    return NextResponse.json({ url: session.url });
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return NextResponse.json(
        {
          error: "billing_not_configured",
          message:
            "Online payments are being connected — your trial continues uninterrupted. Please try again later.",
        },
        { status: 503 }
      );
    }
    logger.error("[billing] portal failed:", err);
    return NextResponse.json(
      { error: "portal_failed", message: "Could not open the billing portal. Please try again." },
      { status: 500 }
    );
  }
}
