import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  getStripe,
  getAppUrl,
  getPriceIdForPlanInterval,
  isBillingConfigured,
  isPaidPlanId,
  isBillingInterval,
  PLAN_META,
  StripeNotConfiguredError,
  StripePriceMissingError,
  type PaidPlanId,
  type BillingInterval,
} from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/billing/checkout — create a Stripe Checkout Session for a paid
 * plan (subscription mode). Authenticated, tenant-scoped: the session's
 * client_reference_id is the caller's own businessId, so the webhook can
 * only ever activate the business that paid.
 *
 * Body: { plan: "starter" | "growth" | "pro", interval?: "monthly" | "yearly" }
 * Success: 200 { url } — the frontend redirects the browser there.
 *
 * Honest failures (never a fake checkout):
 *  401/403  auth (requireAuth)
 *  400      super admin has no billing / bad plan / no business
 *  409      business already has an active paid subscription (use the
 *           customer portal to change/cancel instead — avoids double billing)
 *  503      billing_not_configured — no Stripe keys yet
 *  503      yearly_not_configured — yearly price ids not set yet (yearly
 *           billing is coming soon; contact us)
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
  // Monthly is the default — existing callers send no interval and keep
  // working exactly as before.
  const interval: BillingInterval = isBillingInterval(body.interval)
    ? body.interval
    : "monthly";

  try {
    if (!isBillingConfigured()) throw new StripeNotConfiguredError();
    const priceId = getPriceIdForPlanInterval(plan, interval);
    if (!priceId) throw new StripePriceMissingError(plan, interval);
    const stripe = getStripe();
    if (!stripe) throw new StripeNotConfiguredError();

    const db = getUnscopedPrisma();
    const business = (await db.business.findUnique({
      where: { id: auth.businessId },
      select: {
        id: true,
        name: true,
        isActive: true,
        plan: true,
        subscriptionStatus: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    })) as unknown as {
      id: string;
      name: string;
      isActive: boolean;
      plan?: string;
      subscriptionStatus?: string;
      stripeCustomerId?: string;
      stripeSubscriptionId?: string;
    } | null;

    if (!business || !business.isActive) {
      return NextResponse.json(
        { error: "unknown_business", message: "Business not found." },
        { status: 404 }
      );
    }

    // Never stack a second subscription on an already-paying business —
    // plan changes and cancellations go through the customer portal.
    if (
      business.subscriptionStatus === "active" &&
      business.stripeSubscriptionId &&
      isPaidPlanId(business.plan)
    ) {
      return NextResponse.json(
        {
          error: "already_subscribed",
          message: `You already have an active ${business.plan} subscription. Use "Manage subscription" to change or cancel your plan.`,
        },
        { status: 409 }
      );
    }

    // Create or reuse the Stripe customer; persist the id on the business so
    // webhooks and the portal can resolve tenancy by customer id too.
    const adminRow = (await db.admin.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    })) as unknown as { email?: unknown } | null;
    const adminEmail =
      typeof adminRow?.email === "string" && adminRow.email.includes("@")
        ? adminRow.email
        : undefined;

    let customerId = business.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: business.name,
        email: adminEmail,
        metadata: { businessId: business.id },
      });
      customerId = customer.id;
      await db.business.update({
        where: { id: business.id },
        data: { stripeCustomerId: customerId },
      });
      logger.info(
        `[billing] created Stripe customer ${customerId} for business ${business.id}`
      );
    }

    const appUrl = getAppUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: business.id,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { businessId: business.id, plan, interval },
      subscription_data: {
        metadata: { businessId: business.id, plan, interval },
      },
      success_url: `${appUrl}/billing?checkout=success`,
      cancel_url: `${appUrl}/billing?checkout=cancelled`,
    });

    if (!session.url) {
      logger.error("[billing] Stripe checkout session has no url");
      return NextResponse.json(
        { error: "checkout_failed", message: "Could not start checkout. Please try again." },
        { status: 500 }
      );
    }

    logger.info(
      `[billing] checkout session ${session.id} created for business ${business.id} (plan ${plan} / ${interval} / ${interval === "yearly" ? PLAN_META[plan].yearlyPriceUsd : PLAN_META[plan].priceUsd}$)`
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
    if (err instanceof StripePriceMissingError) {
      logger.error(`[billing] ${err.message}`);
      // Yearly price ids are optional until the user creates the yearly
      // products — answer honestly instead of faking a checkout.
      if (err.interval === "yearly") {
        return NextResponse.json(
          {
            error: "yearly_not_configured",
            message:
              "Yearly billing is coming soon — contact us and we'll set up your annual plan (2 months free) manually.",
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        {
          error: "billing_not_configured",
          message:
            "Online payments are being connected — your trial continues uninterrupted. Please try again later.",
        },
        { status: 503 }
      );
    }
    logger.error("[billing] checkout failed:", err);
    return NextResponse.json(
      { error: "checkout_failed", message: "Could not start checkout. Please try again." },
      { status: 500 }
    );
  }
}
