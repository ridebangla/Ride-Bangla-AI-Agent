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
 * Targeted offers (B5): an offer doc may carry targetAccountIds?: string[].
 * Absent/empty = global (the behaviour above, unchanged). Non-empty =
 * the offer applies ONLY to those businessIds, and for those accounts it
 * may be free (percentOff 100 or a fixed price of 0 → effective 0).
 * Per-business call sites thread their businessId through
 * bestOfferHit / getActiveOffer / getActiveOffersByPlan / getCatalogView /
 * resolveChargePrice; reads without a businessId see global offers only.
 *
 * SERVER-ONLY: uses firebase-admin via admin-db. Client components receive
 * serialized CatalogPlanView props — never import values from here.
 */

import { getAdminDb } from "./admin-db";
import {
  PLAN_META,
  PAID_PLANS,
  isPaidPlanId,
  FREE_PLAN_ID,
  FREE_MESSAGES_PER_MONTH,
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
  /** 1–90 when set (1–100 for targeted offers), else null. */
  percentOff: number | null;
  offerPriceMonthlyUsd: number | null;
  offerPriceYearlyUsd: number | null;
  /**
   * Targeted offers (B5): business ids this offer applies to.
   * Absent/empty = global (applies to everyone on the plan, exactly
   * the pre-B5 behaviour). Non-empty = ONLY those businessIds.
   */
  targetAccountIds?: string[];
  /** Required: an offer doc without a parseable startsAt is rejected
   *  (attack-test 2026-10-21 — a missing start must never mean "live
   *  since the beginning of time"; mirrors the Studio parser). */
  startsAt: Date;
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

/**
 * The permanent FREE tier as an EffectivePlan (owner rule 2026-10-22):
 * $0, FREE_MESSAGES_PER_MONTH messages per usage period. This is the
 * definition the tier resolution in subscription.ts / billing-usage.ts
 * points at. It is deliberately NOT part of getPlanCatalog() /
 * codeCatalog(): those feed the pricing page and every purchase path,
 * and the free tier is not for sale — resolveChargePrice("free") stays
 * null and no plan picker ever lists it.
 */
export const FREE_PLAN: EffectivePlan = {
  id: FREE_PLAN_ID,
  name: "Free",
  priceUsd: 0,
  yearlyPriceUsd: 0,
  tagline: "Free tier after the trial ends.",
  messagesPerMonth: FREE_MESSAGES_PER_MONTH,
  active: true,
  stripePriceId: null,
  stripeYearlyPriceId: null,
  source: "code",
};

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
 *  panel's boolean dialects deactivates. A malformed string "false" also
 *  deactivates (attack-test 2026-10-21: a deactivation stored in a
 *  malformed shape must never silently stay active). */
function flagOff(v: unknown): boolean {
  return (
    v === false ||
    (typeof v === "string" && v.trim().toLowerCase() === "false")
  );
}

function docActive(data: Record<string, unknown>): boolean {
  return !(flagOff(data.active) || flagOff(data.enabled) || flagOff(data.isActive));
}

/**
 * Merge one ai_plans doc over the code catalog.
 *
 * Code ids: tolerant per-field merge over PLAN_META — each invalid field
 * is ignored individually and the code value stands. Always returns a plan.
 * New ids: the doc must carry the full commercial field set (non-empty
 * name, priceUsd > 0, yearlyPriceUsd > 0, positive-integer
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
      yearlyPriceUsd: validPrice(d.yearlyPriceUsd, false) ?? base.yearlyPriceUsd,
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
  const yearlyPriceUsd = validPrice(d.yearlyPriceUsd, false);
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

function validOfferPrice(v: unknown, allowZero = false): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return allowZero ? (v >= 0 ? v : null) : v > 0 ? v : null;
}

function validPercentOff(v: unknown, max = 90): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= max
    ? v
    : null;
}

/** Parse the optional targetAccountIds list: strings only, trimmed,
 *  de-duplicated. Anything malformed degrades to an empty (global)
 *  list — never to a wider targeting than the doc carries. */
function parseTargetAccountIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim() && !out.includes(item.trim())) {
      out.push(item.trim());
    }
  }
  return out;
}

/** True when an offer is targeted at specific accounts (B5). */
export function isTargetedOffer(offer: ParsedOffer): boolean {
  return Array.isArray(offer.targetAccountIds) && offer.targetAccountIds.length > 0;
}

/** True when an offer may apply to `businessId` (B5): global offers
 *  apply to everyone; targeted offers only to a listed businessId
 *  (a missing businessId never matches a targeted offer). */
export function offerAppliesToAccount(
  offer: ParsedOffer,
  businessId?: string | null
): boolean {
  if (!isTargetedOffer(offer)) return true;
  if (!businessId) return false;
  return offer.targetAccountIds!.includes(businessId);
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

  // startsAt is required (attack-test 2026-10-21): a missing or
  // unparseable start invalidates the doc, exactly like endsAt.
  if (d.startsAt === undefined || d.startsAt === null) return null;
  const startsAt = toDateValue(d.startsAt);
  if (!startsAt) return null;

  // Targeted offers (B5): a non-empty targetAccountIds list scopes the
  // offer to those accounts AND unlocks a free price (percentOff 100
  // or a fixed price of 0) for those accounts only. Global offers keep
  // the exact pre-B5 validation (percentOff 1–90, prices > 0) — that
  // validation lives in Admin for writes; this parser mirrors it so a
  // malformed global doc can never discount to free.
  const targetAccountIds = parseTargetAccountIds(d.targetAccountIds);
  const targeted = targetAccountIds.length > 0;

  return {
    id,
    name: typeof d.name === "string" ? d.name.trim() : "",
    planId,
    percentOff:
      d.percentOff === undefined || d.percentOff === null
        ? null
        : validPercentOff(d.percentOff, targeted ? 100 : 90),
    offerPriceMonthlyUsd: validOfferPrice(d.offerPriceMonthlyUsd, targeted),
    offerPriceYearlyUsd: validOfferPrice(d.offerPriceYearlyUsd, targeted),
    targetAccountIds,
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
 * The result counts only when 0 < effective < regular — EXCEPT a
 * targeted offer (B5), which may yield exactly 0 (free) for its listed
 * accounts: 0 <= effective < regular. Global offers can never yield 0
 * here (their parser already rejects percentOff 100 / price 0, and this
 * check is the second lock).
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
  if (isTargetedOffer(offer)) {
    return eff >= 0 && eff < regular ? eff : null;
  }
  return eff > 0 && eff < regular ? eff : null;
}

/**
 * Lowest effective price wins among live offers. Pure.
 * Account-aware (B5): when `businessId` is given, targeted offers for
 * that business compete alongside global offers; targeted offers for
 * OTHER businesses are skipped. When it is omitted, only global
 * offers apply — exactly the pre-B5 behaviour.
 */
export function bestOfferHit(
  plan: EffectivePlan,
  offers: ParsedOffer[],
  interval: BillingInterval,
  now: Date,
  businessId?: string | null
): ActiveOfferHit | null {
  const regular = interval === "yearly" ? plan.yearlyPriceUsd : plan.priceUsd;
  let best: ActiveOfferHit | null = null;
  for (const offer of offers) {
    if (offer.planId !== plan.id) continue;
    if (!offerAppliesToAccount(offer, businessId)) continue;
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
 * In-process TTL cache for the two whole-collection reads below
 * (60s + inflight dedupe, mirroring company-identity.ts). These reads
 * run on every chat/voice/channel turn (via the message-limit check),
 * yet plans and offers change only when a Super Admin edits them in
 * the panel; 60s bounds panel-edit propagation to a minute per
 * instance at one read per minute per instance. ONLY successful reads
 * are cached: a failed read falls back exactly as before (code catalog
 * / no offers) and is retried on the next call, never poisoned in.
 */
const PLAN_CATALOG_TTL_MS = 60_000;

let planCatalogCache: { at: number; value: EffectivePlan[] } | null = null;
let planCatalogInflight: Promise<EffectivePlan[]> | null = null;
let allOffersCache: { at: number; value: ParsedOffer[] } | null = null;
let allOffersInflight: Promise<ParsedOffer[]> | null = null;

/** Test seam (mirrors __resetCompanyIdentityCacheForTests). */
export function __resetPlanCatalogCacheForTests(): void {
  planCatalogCache = null;
  planCatalogInflight = null;
  allOffersCache = null;
  allOffersInflight = null;
}

/** Uncached catalog read. Returns null on ANY error (the caller then
 *  applies the historical fallback) so failures are never cached. */
async function loadPlanCatalog(): Promise<EffectivePlan[] | null> {
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
    return null;
  }
}

/**
 * The effective plan catalog: code order first (PLAN_META order), then
 * panel-created ids sorted. ANY error → the code catalog.
 */
export async function getPlanCatalog(): Promise<EffectivePlan[]> {
  if (
    planCatalogCache &&
    Date.now() - planCatalogCache.at < PLAN_CATALOG_TTL_MS
  ) {
    return planCatalogCache.value;
  }
  if (planCatalogInflight) return planCatalogInflight;
  planCatalogInflight = (async () => {
    try {
      const value = await loadPlanCatalog();
      if (value === null) return codeCatalog();
      planCatalogCache = { at: Date.now(), value };
      return value;
    } finally {
      planCatalogInflight = null;
    }
  })();
  return planCatalogInflight;
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

/** Uncached all-offers read. Returns null on ANY error (the caller
 *  then applies the historical [] fallback) so failures are never cached. */
async function loadAllOffers(): Promise<ParsedOffer[] | null> {
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
    return null;
  }
}

async function fetchAllOffers(): Promise<ParsedOffer[]> {
  if (
    allOffersCache &&
    Date.now() - allOffersCache.at < PLAN_CATALOG_TTL_MS
  ) {
    return allOffersCache.value;
  }
  if (allOffersInflight) return allOffersInflight;
  allOffersInflight = (async () => {
    try {
      const value = await loadAllOffers();
      if (value === null) return [];
      allOffersCache = { at: Date.now(), value };
      return value;
    } finally {
      allOffersInflight = null;
    }
  })();
  return allOffersInflight;
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
  now: Date = new Date(),
  businessId?: string | null
): Promise<ActiveOfferHit | null> {
  const plan = await getCatalogPlan(planId);
  if (!plan) return null;
  const offers = await fetchOffersForPlan(planId);
  return bestOfferHit(plan, offers, interval, now, businessId);
}

/**
 * Per-plan live offers for both intervals — the rendering read.
 * Pass `businessId` for a per-business read (targeted offers for that
 * business included); omit it for the public/global view.
 */
export async function getActiveOffersByPlan(
  now: Date = new Date(),
  businessId?: string | null
): Promise<Map<string, { monthly: ActiveOfferHit | null; yearly: ActiveOfferHit | null }>> {
  const catalog = await getPlanCatalog();
  const offers = await fetchAllOffers();
  const out = new Map<
    string,
    { monthly: ActiveOfferHit | null; yearly: ActiveOfferHit | null }
  >();
  for (const plan of catalog) {
    out.set(plan.id, {
      monthly: bestOfferHit(plan, offers, "monthly", now, businessId),
      yearly: bestOfferHit(plan, offers, "yearly", now, businessId),
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

/**
 * Serializable catalog + offers view-model for pages/client components.
 * Pass `businessId` for a per-business view (the billing page does):
 * targeted offers for that business are included; omit it for the
 * public view, where only global offers appear.
 */
export async function getCatalogView(
  now: Date = new Date(),
  businessId?: string | null
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
      bestOfferHit(plan, offers, "monthly", now, businessId)
    ),
    yearly: toIntervalView(
      plan.yearlyPriceUsd,
      bestOfferHit(plan, offers, "yearly", now, businessId)
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
  now: Date = new Date(),
  businessId?: string | null
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
  const offer = bestOfferHit(plan, offers, interval, now, businessId);
  return {
    plan,
    regularPriceUsd,
    effectivePriceUsd: offer ? offer.effectivePriceUsd : regularPriceUsd,
    offer,
  };
}
