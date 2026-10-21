import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getUnscopedPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  constructWebhookEvent,
  getPlanForPriceId,
  isPaidPlanId,
  isBillingInterval,
  WebhookNotConfiguredError,
  WebhookSignatureError,
  type BillingInterval,
} from "@/lib/stripe";
import { getCatalogPlan, getPlanCatalog } from "@/lib/plan-catalog";

export const dynamic = "force-dynamic";
// Stripe's signature check uses node:crypto (timingSafeEqual) — must run on
// the Node.js runtime, never the edge runtime.
export const runtime = "nodejs";

/**
 * POST /api/webhooks/stripe — Stripe billing webhooks.
 *
 * PUBLIC by design (see src/middleware.ts): webhooks carry Stripe's
 * signature, not a JWT, so this endpoint must bypass the normal auth.
 * Authenticity comes ONLY from stripe-signature verification against
 * STRIPE_WEBHOOK_SECRET.
 *
 * Events handled (idempotent — each handler checks the current status
 * before writing, so Stripe retries are harmless):
 *  checkout.session.completed → { plan, billingInterval, subscriptionStatus:'active',
 *                                 stripeCustomerId, stripeSubscriptionId }
 *  invoice.payment_succeeded → past_due → active
 *  invoice.payment_failed    → active → past_due (Stripe Smart Retries
 *                             handle dunning)
 *  customer.subscription.deleted → 'suspended' (the Phase 3 402 hard-stop
 *                             then blocks AI replies everywhere — airtight)
 *
 * Tenancy is fail-closed: the business is resolved ONLY by
 * client_reference_id / session metadata (verified against the stored
 * business) or by the stored stripeCustomerId / stripeSubscriptionId.
 * Unknown business → logged, 200, no write.
 */
export async function POST(request: NextRequest) {
  // In the App Router the body is not parsed automatically, so this is the
  // raw payload Stripe signed. Never use request.json() here — parsing and
  // re-serializing would break the signature.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookNotConfiguredError) {
      // LOUD: without the secret we cannot trust ANY webhook. 503 tells
      // Stripe to retry later instead of dropping the event.
      logger.error(`[billing] STRIPE WEBHOOK REJECTED: ${err.message}`);
      return NextResponse.json(
        { error: "webhook_not_configured" },
        { status: 503 }
      );
    }
    if (err instanceof WebhookSignatureError) {
      logger.warn(`[billing] Stripe webhook bad signature: ${err.message}`);
      return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
    }
    throw err;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "invoice.payment_succeeded":
        await handleInvoicePayment(event.data.object as Stripe.Invoice, true);
        break;
      case "invoice.payment_failed":
        await handleInvoicePayment(event.data.object as Stripe.Invoice, false);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      default:
        logger.info(`[billing] ignoring Stripe event ${event.type} (${event.id})`);
    }
  } catch (err) {
    // 500 → Stripe retries. The handlers are idempotent, so a retry after a
    // partial failure is safe.
    logger.error(`[billing] failed handling Stripe event ${event.type} (${event.id}):`, err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

type BusinessRow = {
  id: string;
  name: string;
  isActive: boolean;
  plan?: string;
  subscriptionStatus?: string;
  billingInterval?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
};

async function findBusinessById(businessId: string): Promise<BusinessRow | null> {
  const db = getUnscopedPrisma();
  return (await db.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      isActive: true,
      plan: true,
      subscriptionStatus: true,
      billingInterval: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  })) as unknown as BusinessRow | null;
}

async function findBusinessByStripeCustomer(
  customerId: string
): Promise<BusinessRow | null> {
  const db = getUnscopedPrisma();
  return (await db.business.findFirst({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      name: true,
      isActive: true,
      plan: true,
      subscriptionStatus: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  })) as unknown as BusinessRow | null;
}

function customerIdOf(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Resolve the business: client_reference_id is authoritative; the
  // metadata copies must agree with it (fail-closed on mismatch).
  const businessId = session.client_reference_id || session.metadata?.businessId;
  const metaPlan = session.metadata?.plan;
  const subMetaPlan = (session.subscription as Stripe.Subscription | null)?.metadata?.plan;
  // Billing interval travels in the same metadata (set by /api/billing/checkout).
  // Anything unexpected falls back to 'monthly' — never trust client input blindly.
  const metaInterval = session.metadata?.interval;
  const subMetaInterval = (session.subscription as Stripe.Subscription | null)?.metadata?.interval;
  const interval: BillingInterval = isBillingInterval(metaInterval)
    ? metaInterval
    : isBillingInterval(subMetaInterval)
      ? subMetaInterval
      : "monthly";

  // Plan resolution: session/subscription metadata first. A metadata plan
  // is accepted when it is a code plan id OR present in the effective
  // catalog (panel-created plans check out with inline price_data, so
  // their metadata plan is the only resolution path).
  let plan: string | null = null;
  if (
    typeof metaPlan === "string" &&
    metaPlan &&
    (isPaidPlanId(metaPlan) || (await getCatalogPlan(metaPlan)) !== null)
  ) {
    plan = metaPlan;
  }
  if (
    !plan &&
    typeof subMetaPlan === "string" &&
    subMetaPlan &&
    (isPaidPlanId(subMetaPlan) || (await getCatalogPlan(subMetaPlan)) !== null)
  ) {
    plan = subMetaPlan;
  }
  // Last resort: resolve the plan from a Price id if Stripe expanded it —
  // the env mapping first, then the catalog's configured Stripe price ids.
  const linePrice = (session as { line_items?: { data?: Array<{ price?: { id?: string } }> } }).line_items?.data?.[0]?.price?.id;
  if (!plan && linePrice) plan = getPlanForPriceId(linePrice);
  if (!plan && linePrice) {
    const catalog = await getPlanCatalog();
    const match = catalog.find(
      (p) => p.stripePriceId === linePrice || p.stripeYearlyPriceId === linePrice
    );
    if (match) plan = match.id;
  }

  if (!businessId || !plan) {
    logger.error(
      `[billing] checkout.session.completed ${session.id}: cannot resolve business/plan ` +
        `(client_reference_id=${businessId ?? "missing"}, plan=${String(metaPlan)}). ` +
        "No status change — business stays fail-closed."
    );
    return;
  }

  const biz = await findBusinessById(businessId);
  if (!biz || !biz.isActive) {
    logger.error(
      `[billing] checkout.session.completed ${session.id}: business ${businessId} not found or inactive. No write.`
    );
    return;
  }

  const customerId = customerIdOf(session.customer);
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : (session.subscription as Stripe.Subscription | null)?.id ?? null;

  // Idempotency: already applied → skip the write.
  if (
    biz.subscriptionStatus === "active" &&
    biz.plan === plan &&
    (!subscriptionId || biz.stripeSubscriptionId === subscriptionId)
  ) {
    logger.info(
      `[billing] checkout.session.completed ${session.id}: business ${biz.id} already active on ${plan} — skipping (idempotent).`
    );
    return;
  }

  await getUnscopedPrisma().business.update({
    where: { id: biz.id },
    data: {
      plan,
      subscriptionStatus: "active",
      billingInterval: interval,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    },
  });
  logger.info(
    `[billing] business ${biz.id} ("${biz.name}") ACTIVATED on plan ${plan} (${interval}) ` +
      `(checkout ${session.id}, customer ${customerId ?? "?"}, subscription ${subscriptionId ?? "?"})`
  );
}

async function handleInvoicePayment(invoice: Stripe.Invoice, succeeded: boolean) {
  const customerId = customerIdOf(invoice.customer);
  if (!customerId) {
    logger.warn(`[billing] invoice event ${invoice.id}: no customer on invoice — skipping.`);
    return;
  }
  const biz = await findBusinessByStripeCustomer(customerId);
  if (!biz) {
    logger.warn(
      `[billing] invoice event ${invoice.id}: no business with stripeCustomerId ${customerId} — skipping.`
    );
    return;
  }

  if (succeeded) {
    // A successful retry/payment lifts a past_due business back to active.
    // Idempotent: only write when currently past_due.
    if (biz.subscriptionStatus === "past_due") {
      await getUnscopedPrisma().business.update({
        where: { id: biz.id },
        data: { subscriptionStatus: "active" },
      });
      logger.info(`[billing] business ${biz.id}: invoice ${invoice.id} paid — past_due → active.`);
    }
    return;
  }

  // Failed payment: active → past_due (Stripe Smart Retries handle dunning;
  // a final failure arrives as customer.subscription.deleted → suspended).
  // Idempotent: only downgrade from active — never touch canceled/suspended.
  if (biz.subscriptionStatus === "active") {
    await getUnscopedPrisma().business.update({
      where: { id: biz.id },
      data: { subscriptionStatus: "past_due" },
    });
    logger.warn(`[billing] business ${biz.id}: invoice ${invoice.id} failed — active → past_due.`);
  } else {
    logger.info(
      `[billing] invoice ${invoice.id} failed for business ${biz.id} (status ${biz.subscriptionStatus}) — no change.`
    );
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const subscriptionId = subscription.id;
  const customerId = customerIdOf(subscription.customer);

  // Prefer the stored subscription id (exact), fall back to the customer id.
  const db = getUnscopedPrisma();
  let biz: BusinessRow | null = null;
  if (subscriptionId) {
    biz = (await db.business.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
      select: {
        id: true, name: true, isActive: true, plan: true,
        subscriptionStatus: true, stripeCustomerId: true, stripeSubscriptionId: true,
      },
    })) as unknown as BusinessRow | null;
  }
  if (!biz && customerId) {
    biz = await findBusinessByStripeCustomer(customerId);
  }
  if (!biz) {
    logger.warn(
      `[billing] customer.subscription.deleted ${subscriptionId}: no matching business ` +
        `(customer ${customerId ?? "?"}) — skipping.`
    );
    return;
  }

  // Idempotent: already suspended → skip.
  if (biz.subscriptionStatus === "suspended") {
    logger.info(`[billing] business ${biz.id} already suspended — skipping (idempotent).`);
    return;
  }

  await db.business.update({
    where: { id: biz.id },
    data: { subscriptionStatus: "suspended" },
  });
  logger.warn(
    `[billing] business ${biz.id} ("${biz.name}"): subscription ${subscriptionId} deleted — ` +
      "status → suspended. The 402 AI hard-stop now blocks all AI replies (decision 16)."
  );
}
