/**
 * plan-catalog.ts — panel-driven plan catalog + offers (owner directive
 * 2026-10-21: plans and offers are addable from the Admin Panel and REALLY
 * consumed by the platform).
 *
 * The Admin Console (Super Admin) writes:
 *   ai_plans/{planId}  — overrides merged over the code catalog (PLAN_META)
 *                        for code ids; a doc with a NEW id must carry the
 *                        full commercial field set or it is skipped.
 *   ai_offers/{offerId} — { name, planId, percentOff? (1–90),
 *                        offerPriceMonthlyUsd?, offerPriceYearlyUsd?,
 *                        startsAt, endsAt, active? }.
 *
 * Reads happen server-side via the Admin SDK, exactly like
 * manual-payments.ts reads payment_methods_config. FAIL-CLOSED: any read
 * error or invalid doc falls back to the CODE catalog (src/lib/plans.ts
 * PLAN_META) — never to free/unlimited.
 *
 * Offer semantics (evaluated at read time, no cron): an offer is live iff
 * active !== false AND startsAt <= now < endsAt. The effective price per
 * interval is the fixed offer price for that interval when set, else the
 * percent discount applied to the plan's effective price; it counts only
 * when 0 < effective < regular. Multiple live offers on one plan: the
 * lowest effective price wins. Offers never apply to trial/internal.
 *
 * SERVER-ONLY: uses firebase-admin via admin-db. Client components receive
 * serialized CatalogPlanView props — never import values from here.
 */

import { getAdminDb } from "./admin-db";
import {
  PLAN_META,
  PAID_PLANS,
  isPaidPlanId,
  type BillingInterval,
} from "./plans";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EffectivePlan {
  id: string;
  name: string;
  priceUsd: number;
  yearlyPriceUsd: number;
  tagline: string;
  messagesPerMonth: number;
  active: boolean;
  stripePriceId: string | null;
  stripeYearlyPriceId: string | null;
  source: "code" | "config";
}

export interface ParsedOffer {
  id: string;
  name: string;
  planId: string;
  /** 1–90 when set, else null. */
  percentOff: number | null;
  offerPriceMonthlyUsd: number | null;
  offerPriceYearlyUsd: number | null;
  /** Null = no start bound in the doc (already started). */
  startsAt: Date | null;
  endsAt: Date;
  active: boolean;
}

export interface ActiveOfferHit {
  offerId: string;
  name: string;
  endsAt: Date;
  regularPriceUsd: number;
  effectivePriceUsd: number;
}

/** Serializable per-interval pricing for one plan (client view-model). */
export interface IntervalPriceView {
  regularPriceUsd: number;
  offer: {
    offerId: string;
    name: string;
    /** ISO string — serializable across the server/client boundary. */
    endsAt: string;
    effectivePriceUsd: number;
    regularPriceUsd: number;
  } | null;
}

/** Serializable plan view-model passed to client components. */
export interface CatalogPlanView {
  id: string;
  name: string;
  tagline: string;
  messagesPerMonth: number;
  active: boolean;
  source: "code" | "config";
  monthly: IntervalPriceView;
  yearly: IntervalPriceView;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no DB)
// ---------------------------------------------------------------------------

/** The code catalog: PLAN_META exactly as shipped, all active. */
export function codeCatalog(): EffectivePlan[] {
  return PAID_PLANS.map((id) => ({
    id,
    name: PLAN_META[id].name,
    priceUsd: PLAN_META[id].priceUsd,
    yearlyPriceUsd: PLAN_META[id].yearlyPriceUsd,
    tagline: PLAN_META[id].tagline,
    messagesPerMonth: PLAN_META[id].messagesPerMonth,
    active: true,
    stripePriceId: null,
    stripeYearlyPriceId: null,
    source: "code" as const,
  }));
}

function validName(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function validPrice(v: unknown, allowZero: boolean): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return allowZero ? (v >= 0 ? v : null) : v > 0 ? v : null;
}

function validMessages(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function validStripeId(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** active semantics: absent = true; only an explicit false on any of the
 *  panel's boolean dialects deactivates. */
function docActive(data: Record<string, unknown>): boolean {
  return !(
    data.active === false ||
    data.enabled === false ||
    data.isActive === false
  );
}

/**
 * Merge one ai_plans doc over the code catalog.
 *
 * Code ids: tolerant per-field merge over PLAN_META — each invalid field
 * is ignored individually and the code value stands. Always returns a plan.
 * New ids: the doc must carry the full commercial field set (non-empty
 * name, priceUsd > 0, yearlyPriceUsd >= 0, positive-integer
 * messagesPerMonth) or the plan is skipped (null) — fail-closed.
 */
export function mergePlanDoc(
  id: string,
  data: unknown
): EffectivePlan | null {
  const d: Record<string, unknown> =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};

  if (isPaidPlanId(id)) {
    const base = PLAN_META[id];
    return {
      id,
      name: validName(d.name) ?? base.name,
      priceUsd: validPrice(d.priceUsd, false) ?? base.priceUsd,
      yearlyPriceUsd: validPrice(d.yearlyPriceUsd, true) ?? base.yearlyPriceUsd,
      tagline:
        typeof d.tagline === "string" && d.tagline.trim()
          ? d.tagline.trim()
          : base.tagline,
      messagesPerMonth: validMessages(d.messagesPerMonth) ?? base.messagesPerMonth,
      active: docActive(d),
      stripePriceId: validStripeId(d.stripePriceId),
      stripeYearlyPriceId: validStripeId(d.stripeYearlyPriceId),
      source: "config",
    };
  }

  // New (panel-created) plan id: full commercial field set required.
  const name = validName(d.name);
  const priceUsd = validPrice(d.priceUsd, false);
  const yearlyPriceUsd = validPrice(d.yearlyPriceUsd, true);
  const messagesPerMonth = validMessages(d.messagesPerMonth);
  if (
    name === null ||
    priceUsd === null ||
    yearlyPriceUsd === null ||
    messagesPerMonth === null
  ) {
    return null;
  }
  return {
    id,
    name,
    priceUsd,
    yearlyPriceUsd,
    tagline: typeof d.tagline === "string" ? d.tagline.trim() : "",
    messagesPerMonth,
    active: docActive(d),
    stripePriceId: validStripeId(d.stripePriceId),
    stripeYearlyPriceId: validStripeId(d.stripeYearlyPriceId),
    source: "config",
  };
}

/** Parse a Firestore-ish timestamp value (Timestamp / Date / ms / ISO). */
function toDateValue(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof (v as { toDate?: unknown }).toDate === "function") {
    try {
      const d = (v as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function validOfferPrice(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function validPercentOff(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 90
    ? v
    : null;
}

/**
 * Normalize one ai_offers doc. Returns null when the doc cannot be
 * understood well enough to ever discount safely: endsAt is required and
 * must parse; a present-but-unparseable startsAt invalidates the doc
 * (fail-closed — a malformed offer must never discount early). Individual
 * pricing fields are tolerated per-field: an invalid percentOff or fixed
 * price is ignored on its own, and an offer with no usable pricing simply
 * never yields an effective price.
 */
export function parseOfferDoc(id: string, data: unknown): ParsedOffer | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  const planId = typeof d.planId === "string" && d.planId.trim() ? d.planId.trim() : null;
  if (!planId) return null;

  const endsAt = toDateValue(d.endsAt);
  if (!endsAt) return null;

  let startsAt: Date | null = null;
  if (d.startsAt !== undefined && d.startsAt !== null) {
    startsAt = toDateValue(d.startsAt);
    if (!startsAt) return null;
  }

  return {
    id,
    name: typeof d.name === "string" ? d.name.trim() : "",
    planId,
    percentOff:
      d.percentOff === undefined || d.percentOff === null
        ? null
        : validPercentOff(d.percentOff),
    offerPriceMonthlyUsd: validOfferPrice(d.offerPriceMonthlyUsd),
    offerPriceYearlyUsd: validOfferPrice(d.offerPriceYearlyUsd),
    startsAt,
    endsAt,
    active: docActive(d),
  };
}

/** Live iff active AND startsAt <= now < endsAt. */
export function isOfferLive(offer: ParsedOffer, now: Date): boolean {
  if (!offer.active) return false;
  if (offer.startsAt && offer.startsAt.getTime() > now.getTime()) return false;
  return now.getTime() < offer.endsAt.getTime();
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The price this offer yields for (plan, interval), or null when it does
 * not make the plan cheaper. Fixed price for the interval wins when set;
 * otherwise the percent discount applies to the plan's regular price.
 * The result counts only when 0 < effective < regular.
 */
export function offerEffectivePrice(
  plan: EffectivePlan,
  offer: ParsedOffer,
  interval: BillingInterval
): number | null {
  const regular = interval === "yearly" ? plan.yearlyPriceUsd : plan.priceUsd;
  const fixed =
    interval === "yearly"
      ? offer.offerPriceYearlyUsd
      : offer.offerPriceMonthlyUsd;
  let eff: number | null = null;
  if (fixed !== null) {
    eff = roundCents(fixed);
  } else if (offer.percentOff !== null) {
    eff = roundCents(regular * (1 - offer.percentOff / 100));
  }
  if (eff === null) return null;
  return eff > 0 && eff < regular ? eff : null;
}

/** Lowest effective price wins among live offers. Pure. */
export function bestOfferHit(
  plan: EffectivePlan,
  offers: ParsedOffer[],
  interval: BillingInterval,
  now: Date
): ActiveOfferHit | null {
  const regular = interval === "yearly" ? plan.yearlyPriceUsd : plan.priceUsd;
  let best: ActiveOfferHit | null = null;
  for (const offer of offers) {
    if (offer.planId !== plan.id) continue;
    if (!isOfferLive(offer, now)) continue;
    const eff = offerEffectivePrice(plan, offer, interval);
    if (eff === null) continue;
    if (best === null || eff < best.effectivePriceUsd) {
      best = {
        offerId: offer.id,
        name: offer.name,
        endsAt: offer.endsAt,
        regularPriceUsd: regular,
        effectivePriceUsd: eff,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Server reads (Admin SDK) — every failure falls back to the code catalog
// ---------------------------------------------------------------------------

/**
 * The effective plan catalog: code order first (PLAN_META order), then
 * panel-created ids sorted. ANY error → the code catalog.
 */
export async function getPlanCatalog(): Promise<EffectivePlan[]> {
  try {
    const snap = await getAdminDb().collection("ai_plans").get();
    const docs = new Map<string, unknown>();
    snap.forEach((doc) => docs.set(doc.id, doc.data()));

    const out: EffectivePlan[] = [];
    for (const id of PAID_PLANS) {
      // mergePlanDoc always returns a plan for code ids.
      out.push(mergePlanDoc(id, docs.get(id)) as EffectivePlan);
    }
    const extraIds = [...docs.keys()]
      .filter((id) => !isPaidPlanId(id))
      .sort();
    for (const id of extraIds) {
      const merged = mergePlanDoc(id, docs.get(id));
      if (merged) out.push(merged);
    }
    return out;
  } catch (err) {
    logger.warn("[plan-catalog] ai_plans read failed — using code catalog", {
      error: err instanceof Error ? err.message : String(err),
    });
    return codeCatalog();
  }
}

/** One effective plan by id (active or not), or null when unknown. */
export async function getCatalogPlan(
  planId: string
): Promise<EffectivePlan | null> {
  const catalog = await getPlanCatalog();
  return catalog.find((p) => p.id === planId) ?? null;
}

async function fetchOffersForPlan(planId: string): Promise<ParsedOffer[]> {
  try {
    const snap = await getAdminDb()
      .collection("ai_offers")
      .where("planId", "==", planId)
      .get();
    const out: ParsedOffer[] = [];
    snap.forEach((doc) => {
      const parsed = parseOfferDoc(doc.id, doc.data());
      if (parsed) out.push(parsed);
    });
    return out;
  } catch (err) {
    logger.warn("[plan-catalog] ai_offers read failed — no offers applied", {
      planId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function fetchAllOffers(): Promise<ParsedOffer[]> {
  try {
    const snap = await getAdminDb().collection("ai_offers").get();
    const out: ParsedOffer[] = [];
    snap.forEach((doc) => {
      const parsed = parseOfferDoc(doc.id, doc.data());
      if (parsed) out.push(parsed);
    });
    return out;
  } catch (err) {
    logger.warn("[plan-catalog] ai_offers read failed — no offers applied", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** One offer doc by id (parsed), or null. Used by the fraud monitor to
 *  price a claim that carries an offerId. */
export async function getOfferById(offerId: string): Promise<ParsedOffer | null> {
  try {
    const snap = await getAdminDb().collection("ai_offers").doc(offerId).get();
    if (!snap.exists) return null;
    return parseOfferDoc(snap.id, snap.data());
  } catch {
    return null;
  }
}

/**
 * The winning live offer for (planId, interval) right now, or null.
 * Errors → null (no discount is ever invented).
 */
export async function getActiveOffer(
  planId: string,
  interval: BillingInterval,
  now: Date = new Date()
): Promise<ActiveOfferHit | null> {
  const plan = await getCatalogPlan(planId);
  if (!plan) return null;
  const offers = await fetchOffersForPlan(planId);
  return bestOfferHit(plan, offers, interval, now);
}

/** Per-plan live offers for both intervals — the rendering read. */
export async function getActiveOffersByPlan(
  now: Date = new Date()
): Promise<Map<string, { monthly: ActiveOfferHit | null; yearly: ActiveOfferHit | null }>> {
  const catalog = await getPlanCatalog();
  const offers = await fetchAllOffers();
  const out = new Map<
    string,
    { monthly: ActiveOfferHit | null; yearly: ActiveOfferHit | null }
  >();
  for (const plan of catalog) {
    out.set(plan.id, {
      monthly: bestOfferHit(plan, offers, "monthly", now),
      yearly: bestOfferHit(plan, offers, "yearly", now),
    });
  }
  return out;
}

function toIntervalView(
  regularPriceUsd: number,
  hit: ActiveOfferHit | null
): IntervalPriceView {
  return {
    regularPriceUsd,
    offer: hit
      ? {
          offerId: hit.offerId,
          name: hit.name,
          endsAt: hit.endsAt.toISOString(),
          effectivePriceUsd: hit.effectivePriceUsd,
          regularPriceUsd: hit.regularPriceUsd,
        }
      : null,
  };
}

/** Serializable catalog + offers view-model for pages/client components. */
export async function getCatalogView(
  now: Date = new Date()
): Promise<CatalogPlanView[]> {
  const catalog = await getPlanCatalog();
  const offers = await fetchAllOffers();
  return catalog.map((plan) => ({
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    messagesPerMonth: plan.messagesPerMonth,
    active: plan.active,
    source: plan.source,
    monthly: toIntervalView(
      plan.priceUsd,
      bestOfferHit(plan, offers, "monthly", now)
    ),
    yearly: toIntervalView(
      plan.yearlyPriceUsd,
      bestOfferHit(plan, offers, "yearly", now)
    ),
  }));
}

/**
 * The price a purchase path must charge for (planId, interval): the live
 * offer's effective price when one applies, else the catalog price.
 * Null when the plan is unknown. (Active-ness is the caller's gate.)
 */
export async function resolveChargePrice(
  planId: string,
  interval: BillingInterval,
  now: Date = new Date()
): Promise<{
  plan: EffectivePlan;
  regularPriceUsd: number;
  effectivePriceUsd: number;
  offer: ActiveOfferHit | null;
} | null> {
  const plan = await getCatalogPlan(planId);
  if (!plan) return null;
  const regularPriceUsd =
    interval === "yearly" ? plan.yearlyPriceUsd : plan.priceUsd;
  const offers = await fetchOffersForPlan(planId);
  const offer = bestOfferHit(plan, offers, interval, now);
  return {
    plan,
    regularPriceUsd,
    effectivePriceUsd: offer ? offer.effectivePriceUsd : regularPriceUsd,
    offer,
  };
}
