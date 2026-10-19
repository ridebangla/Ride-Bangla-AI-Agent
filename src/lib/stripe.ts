/**
 * stripe.ts — Stripe billing integration (Phase 4, SaaS billing).
 *
 * Every function here is a SAFE NO-OP (or throws a typed, catchable error)
 * when Stripe is not configured — nothing here ever throws an unhandled
 * error, and no fake checkout is ever produced. When the user adds the real
 * keys, the same code paths go live with no further changes.
 *
 * ---------------------------------------------------------------------------
 * SETUP CHECKLIST FOR THE USER (Vercel env + Stripe dashboard):
 *
 * 1. Stripe dashboard → Developers → API keys → copy the SECRET key
 *    (starts with `sk_live_` for production, `sk_test_` for testing).
 *    Vercel → project → Settings → Environment Variables → add:
 *      STRIPE_SECRET_KEY=<the secret key>
 *
 * 2. Stripe dashboard → Product catalog → create 3 recurring products
 *    (monthly, USD):
 *      Starter $19/mo, Growth $49/mo, Pro $99/mo
 *    Copy each product's PRICE id (starts with `price_...`) and add:
 *      STRIPE_PRICE_STARTER=price_...
 *      STRIPE_PRICE_GROWTH=price_...
 *      STRIPE_PRICE_PRO=price_...
 *
 *    Then create 3 more recurring products (YEARLY, USD — 2 months free,
 *    i.e. 10x the monthly price):
 *      Starter $190/yr, Growth $490/yr, Pro $990/yr
 *    Copy each yearly PRICE id and add:
 *      STRIPE_PRICE_STARTER_YR=price_...
 *      STRIPE_PRICE_GROWTH_YR=price_...
 *      STRIPE_PRICE_PRO_YR=price_...
 *    (Until the _YR ids exist, /pricing still shows yearly prices, but
 *    yearly checkout answers honestly that yearly billing is coming soon.)
 *
 * 3. Stripe dashboard → Developers → Webhooks → Add endpoint:
 *      https://ai.ridebangla.bd/api/webhooks/stripe
 *    Subscribe to EXACTLY these events:
 *      checkout.session.completed
 *      invoice.payment_succeeded
 *      invoice.payment_failed
 *      customer.subscription.deleted
 *    Copy the endpoint's SIGNING secret (starts with `whsec_...`) and add:
 *      STRIPE_WEBHOOK_SECRET=whsec_...
 *
 * 4. Redeploy (env changes need a redeploy). Then:
 *    - /pricing shows the plans, /billing offers real Subscribe buttons.
 *    - A test purchase flows: Checkout → webhook → subscriptionStatus
 *      becomes 'active' → the 402 AI hard-stop lifts for that business.
 *    - Until ALL of the above exist, the UI says honestly that online
 *      payments are being connected and trials continue — no fake buttons.
 * ---------------------------------------------------------------------------
 */

import Stripe from "stripe";
import {
  PAID_PLANS,
  PLAN_META,
  isPaidPlanId,
  isBillingInterval,
  type PaidPlanId,
  type BillingInterval,
} from "./plans";

// Re-exported so server billing code can import everything from here.
export {
  PAID_PLANS,
  PLAN_META,
  isPaidPlanId,
  isBillingInterval,
  type PaidPlanId,
  type BillingInterval,
};

/**
 * True only when a real Stripe secret key is configured. Everything billing
 * gates on this: UI buttons, checkout creation, and portal sessions all
 * refuse honestly when false.
 */
export function isBillingConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

let cachedClient: Stripe | null = null;

/**
 * Lazily create the Stripe client from STRIPE_SECRET_KEY. Returns null when
 * billing is not configured — callers must handle the null and answer with
 * an honest "billing_not_configured" response instead of crashing.
 */
export function getStripe(): Stripe | null {
  if (!isBillingConfigured()) return null;
  if (!cachedClient) {
    cachedClient = new Stripe(process.env.STRIPE_SECRET_KEY as string);
  }
  return cachedClient;
}

/** For tests: drop the cached client so env changes take effect. */
export function __resetStripeClientForTests(): void {
  cachedClient = null;
}

/**
 * Stripe Price id for a plan's MONTHLY price, from STRIPE_PRICE_STARTER /
 * _GROWTH / _PRO. Null when the env var is missing — the checkout route
 * treats that as "billing not fully connected" (honest 503, never a fake
 * session).
 */
export function getPriceIdForPlan(plan: PaidPlanId): string | null {
  const raw =
    plan === "starter"
      ? process.env.STRIPE_PRICE_STARTER
      : plan === "growth"
        ? process.env.STRIPE_PRICE_GROWTH
        : process.env.STRIPE_PRICE_PRO;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Stripe Price id for a plan's YEARLY price, from STRIPE_PRICE_STARTER_YR /
 * _GROWTH_YR / _PRO_YR. Null when missing — yearly checkout then answers
 * honestly ("yearly billing coming soon"), never a fake session.
 */
export function getYearlyPriceIdForPlan(plan: PaidPlanId): string | null {
  const raw =
    plan === "starter"
      ? process.env.STRIPE_PRICE_STARTER_YR
      : plan === "growth"
        ? process.env.STRIPE_PRICE_GROWTH_YR
        : process.env.STRIPE_PRICE_PRO_YR;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Price id for a plan + billing interval. Null when the matching env var
 * is missing.
 */
export function getPriceIdForPlanInterval(
  plan: PaidPlanId,
  interval: BillingInterval
): string | null {
  return interval === "yearly"
    ? getYearlyPriceIdForPlan(plan)
    : getPriceIdForPlan(plan);
}

/** Reverse map: a Stripe Price id back to our plan id (used by webhooks). */
export function getPlanForPriceId(priceId: string): PaidPlanId | null {
  for (const plan of PAID_PLANS) {
    if (getPriceIdForPlan(plan) === priceId) return plan;
    if (getYearlyPriceIdForPlan(plan) === priceId) return plan;
  }
  return null;
}

/** Public base URL used for Stripe success / cancel / return redirects. */
export function getAppUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (typeof raw === "string" && /^https?:\/\//.test(raw)) {
    return raw.replace(/\/+$/, "");
  }
  return "https://ai.ridebangla.bd";
}

/** Thrown when a billing action is attempted without Stripe keys. */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      "Online payments are not connected yet (STRIPE_SECRET_KEY is missing). " +
        "The business keeps its trial; no charge was attempted."
    );
    this.name = "StripeNotConfiguredError";
  }
}

/** Thrown when a plan has no Stripe Price id configured. */
export class StripePriceMissingError extends Error {
  /** 'monthly' | 'yearly' — which price id is missing (for honest messaging). */
  readonly interval: BillingInterval;
  constructor(plan: PaidPlanId, interval: BillingInterval = "monthly") {
    super(
      `No Stripe Price configured for the ${plan} plan (${interval}) ` +
        `(missing ${interval === "yearly" ? `STRIPE_PRICE_${plan.toUpperCase()}_YR` : `STRIPE_PRICE_${plan.toUpperCase()}`}).`
    );
    this.name = "StripePriceMissingError";
    this.interval = interval;
  }
}

/** Thrown by constructWebhookEvent when STRIPE_WEBHOOK_SECRET is missing. */
export class WebhookNotConfiguredError extends Error {
  constructor() {
    super(
      "STRIPE_WEBHOOK_SECRET is not configured — cannot verify webhook signatures."
    );
    this.name = "WebhookNotConfiguredError";
  }
}

/** Thrown by constructWebhookEvent when the signature is absent/invalid. */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/**
 * Verify a Stripe webhook payload with the endpoint's signing secret.
 * Throws WebhookNotConfiguredError (missing secret → route answers 503 and
 * logs loudly) or WebhookSignatureError (bad signature → route answers 400).
 * Uses the STATIC Stripe.webhooks namespace, so verification works even when
 * STRIPE_SECRET_KEY itself is absent.
 */
export function constructWebhookEvent(
  rawBody: string,
  signature: string | null
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new WebhookNotConfiguredError();
  }
  if (!signature) {
    throw new WebhookSignatureError("Missing stripe-signature header.");
  }
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret.trim());
  } catch (err) {
    throw new WebhookSignatureError(
      err instanceof Error ? err.message : "Invalid webhook signature."
    );
  }
}
