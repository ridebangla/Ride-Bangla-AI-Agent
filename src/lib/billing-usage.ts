/**
 * billing-usage.ts — AI message metering + billing countdown (Billing Phase 2).
 *
 * Metering: every finalized AI reply increments `aiMessagesUsed` on the
 * Firestore `businesses/{id}` doc. The usage period is 30 days — when
 * `usagePeriodStart` is older than 30 days a new period begins (used=1).
 * Metering failures never break a reply (logged, swallowed).
 *
 * Countdown: GET /api/billing/countdown and the dashboard banner share
 * getBillingCountdown(). Notices are returned ONLY for breached thresholds
 * (days 7/3/1, usage 80%/100%) plus any adminNotice the team posted.
 *
 * SERVER-ONLY (uses the Admin-SDK-backed prisma shim).
 */

import { getUnscopedPrisma } from "./prisma";
import { PLAN_META, isPaidPlanId, type PaidPlanId } from "./plans";
import { getPlanCatalog, type EffectivePlan } from "./plan-catalog";
import { logger } from "./logger";

export const USAGE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export interface BusinessUsageFields {
  subscriptionStatus?: string;
  plan?: string;
  trialEndsAt?: unknown;
  subscriptionEndsAt?: unknown;
  aiMessagesUsed?: unknown;
  usagePeriodStart?: unknown;
  /** Internal owner comp flag (owner rule 2026-10-21) — see models.ts. */
  isInternalAccount?: unknown;
  adminNotice?: {
    message?: string;
    createdAt?: unknown;
    createdBy?: string;
  } | null;
}

export function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function messagesLimitForPlan(plan: string | undefined): number | null {
  // Paid plans have their catalog allowance; trialing businesses share the
  // Starter allowance (documented on /billing).
  if (isPaidPlanId(plan)) return PLAN_META[plan as PaidPlanId].messagesPerMonth;
  if (plan === "trial") return PLAN_META.starter.messagesPerMonth;
  return null;
}

/**
 * Catalog-aware limit resolution (panel-driven plans, 2026-10-21): the
 * limit comes from the EFFECTIVE catalog (ai_plans merged over PLAN_META),
 * so a Super Admin edit in the Admin Panel moves the gate. Plan "trial"
 * borrows the CURRENT starter entry's messagesPerMonth — config edits to
 * starter move the trial allowance too. Returns undefined when the plan
 * is unknown to the catalog, letting callers fall back to the code
 * behaviour (messagesLimitForPlan). getPlanCatalog itself never throws
 * (it falls back to the code catalog), so any config read error degrades
 * to exactly the PLAN_META behaviour.
 */
async function catalogLimitForPlan(
  plan: string
): Promise<number | null | undefined> {
  const catalog: EffectivePlan[] = await getPlanCatalog();
  if (plan === "trial") {
    const starter = catalog.find((p) => p.id === "starter");
    return starter ? starter.messagesPerMonth : undefined;
  }
  const entry = catalog.find((p) => p.id === plan);
  return entry ? entry.messagesPerMonth : undefined;
}

/**
 * Record one finalized AI reply. Fire-and-forget from the chat pipeline —
 * never throws.
 */
export async function recordAiMessage(businessId: string | null): Promise<void> {
  if (!businessId) return;
  try {
    const db = getUnscopedPrisma();
    const biz = (await db.business.findUnique({
      where: { id: businessId },
      select: { id: true, aiMessagesUsed: true, usagePeriodStart: true },
    })) as unknown as {
      aiMessagesUsed?: unknown;
      usagePeriodStart?: unknown;
    } | null;
    if (!biz) return;

    const now = Date.now();
    const startMs = toDate(biz.usagePeriodStart)?.getTime() ?? 0;
    if (!startMs || now - startMs > USAGE_PERIOD_MS) {
      // New 30-day period.
      await db.business.update({
        where: { id: businessId },
        data: { aiMessagesUsed: 1, usagePeriodStart: new Date(now) },
      });
    } else {
      const used =
        typeof biz.aiMessagesUsed === "number" && biz.aiMessagesUsed >= 0
          ? Math.trunc(biz.aiMessagesUsed)
          : 0;
      await db.business.update({
        where: { id: businessId },
        data: { aiMessagesUsed: used + 1 },
      });
    }
  } catch (err) {
    logger.warn("[metering] recordAiMessage failed (reply unaffected)", {
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Period-aware effective usage: mirrors recordAiMessage's reset semantics
 * (a missing or >30-day-old usagePeriodStart means the count restarts at 0).
 */
export function effectiveAiMessagesUsed(
  biz: BusinessUsageFields & { usagePeriodStart?: unknown },
  nowMs: number = Date.now()
): number {
  const used =
    typeof biz.aiMessagesUsed === "number" && biz.aiMessagesUsed >= 0
      ? Math.trunc(biz.aiMessagesUsed)
      : 0;
  if (used === 0) return 0;
  const startMs = toDate(biz.usagePeriodStart)?.getTime() ?? 0;
  if (!startMs || nowMs - startMs > USAGE_PERIOD_MS) return 0;
  return used;
}

/** Pure gate: true when the business has used up its plan's AI messages.
 *  `limitOverride` (panel-catalog resolution): when provided — including
 *  an explicit null for "no limit" — it replaces the code-catalog lookup;
 *  when omitted the PLAN_META behaviour is unchanged. */
export function isMessageLimitExceeded(
  biz: BusinessUsageFields & { usagePeriodStart?: unknown },
  nowMs: number = Date.now(),
  limitOverride?: number | null
): boolean {
  // Internal owner account (owner rule 2026-10-21): usage is recorded
  // by recordAiMessage but NEVER blocks — no plan limit applies.
  if (biz.isInternalAccount === true) return false;
  const plan = typeof biz.plan === "string" && biz.plan ? biz.plan : "unknown";
  const limit =
    limitOverride !== undefined
      ? limitOverride
      : messagesLimitForPlan(plan === "trial" ? "trial" : plan);
  if (limit === null) return false; // unknown/legacy plan: subscription gate covers it
  return effectiveAiMessagesUsed(biz, nowMs) >= limit;
}

/**
 * Point-of-use gate for every AI-spend entry point. Returns true when the
 * limit is exceeded and the caller must hard-stop (402 / silence) BEFORE
 * spending LLM tokens. Never throws: on a metering read error it fails
 * OPEN with a warning — the subscription gate in the same request already
 * read the same business doc fail-closed, so availability is preserved
 * without weakening the billing hard-stop. Super Admin (null) never blocked.
 */
export async function checkMessageLimitExceeded(
  businessId: string | null
): Promise<boolean> {
  if (!businessId) return false;
  try {
    const biz = (await getUnscopedPrisma().business.findUnique({
      where: { id: businessId },
      select: {
        plan: true,
        aiMessagesUsed: true,
        usagePeriodStart: true,
        isInternalAccount: true,
      },
    })) as unknown as (BusinessUsageFields & { usagePeriodStart?: unknown }) | null;
    if (!biz) return false;
    // Catalog-aware gate: the limit is resolved from the effective
    // (panel-merged) catalog; unknown plans fall back to PLAN_META.
    const plan = typeof biz.plan === "string" && biz.plan ? biz.plan : "unknown";
    const limitOverride = await catalogLimitForPlan(
      plan === "trial" ? "trial" : plan
    );
    return isMessageLimitExceeded(biz, Date.now(), limitOverride);
  } catch (err) {
    logger.warn("[metering] message-limit check failed (allowing request)", {
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export type CountdownNotice =
  | {
      type: "days";
      threshold: 7 | 3 | 1;
      daysRemaining: number;
    }
  | {
      type: "usage";
      threshold: 80 | 100;
      percentUsed: number;
      messagesRemaining: number;
    };

export interface BillingCountdown {
  plan: string;
  /** Whole days until the subscription/trial ends; null when unknown. */
  daysRemaining: number | null;
  /** Whole AI messages left in the current 30-day period; null when unknown. */
  messagesRemaining: number | null;
  messagesLimit: number | null;
  /** 0-100+ (can exceed 100); null when unknown. */
  percentUsed: number | null;
  /** Only breached thresholds are included. */
  notices: CountdownNotice[];
  adminNotice: { message: string; createdAt: Date | null; createdBy: string } | null;
  subscriptionEndsAt: Date | null;
}

const DAY_THRESHOLDS = [7, 3, 1] as const;
const USAGE_THRESHOLDS = [80, 100] as const;

/**
 * Pure countdown computation — unit-testable without Firestore.
 * `nowMs` is injectable for tests.
 */
export function buildCountdown(
  biz: BusinessUsageFields,
  nowMs: number = Date.now(),
  limitOverride?: number | null
): BillingCountdown {
  const rawNotice = biz.adminNotice;
  const adminNotice =
    rawNotice && typeof rawNotice.message === "string" && rawNotice.message.trim()
      ? {
          message: rawNotice.message.trim(),
          createdAt: toDate(rawNotice.createdAt),
          createdBy:
            typeof rawNotice.createdBy === "string" ? rawNotice.createdBy : "team",
        }
      : null;

  // Internal owner account (owner rule 2026-10-21): no countdown
  // exists — no trial days, no message limit, no end date, no
  // threshold notices (a team-posted adminNotice still shows).
  if (biz.isInternalAccount === true) {
    return {
      plan: "internal",
      daysRemaining: null,
      messagesRemaining: null,
      messagesLimit: null,
      percentUsed: null,
      notices: [],
      adminNotice,
      subscriptionEndsAt: null,
    };
  }

  const status = typeof biz.subscriptionStatus === "string" ? biz.subscriptionStatus : "";
  const plan = typeof biz.plan === "string" && biz.plan ? biz.plan : "unknown";

  let endDate: Date | null = null;
  if (status === "active") endDate = toDate(biz.subscriptionEndsAt);
  else if (status === "trialing") endDate = toDate(biz.trialEndsAt);
  const daysRemaining = endDate
    ? Math.ceil((endDate.getTime() - nowMs) / (24 * 60 * 60 * 1000))
    : null;

  const limit =
    limitOverride !== undefined
      ? limitOverride
      : messagesLimitForPlan(plan === "trial" ? "trial" : plan);
  const used =
    typeof biz.aiMessagesUsed === "number" && biz.aiMessagesUsed >= 0
      ? Math.trunc(biz.aiMessagesUsed)
      : 0;
  const messagesRemaining = limit !== null ? Math.max(0, limit - used) : null;
  const percentUsed =
    limit !== null && limit > 0 ? Math.round((used / limit) * 100) : null;

  const notices: CountdownNotice[] = [];
  if (daysRemaining !== null && daysRemaining >= 0) {
    for (const t of DAY_THRESHOLDS) {
      if (daysRemaining <= t) {
        notices.push({ type: "days", threshold: t, daysRemaining });
      }
    }
  }
  if (percentUsed !== null) {
    for (const t of USAGE_THRESHOLDS) {
      if (percentUsed >= t && messagesRemaining !== null) {
        notices.push({
          type: "usage",
          threshold: t,
          percentUsed,
          messagesRemaining,
        });
      }
    }
  }

  return {
    plan,
    daysRemaining,
    messagesRemaining,
    messagesLimit: limit,
    percentUsed,
    notices,
    adminNotice,
    subscriptionEndsAt: toDate(biz.subscriptionEndsAt),
  };
}

/** Server-only: full countdown for a business (never throws). */
export async function getBillingCountdown(
  businessId: string | null
): Promise<BillingCountdown | null> {
  if (!businessId) return null;
  try {
    const biz = (await getUnscopedPrisma().business.findUnique({
      where: { id: businessId },
      select: {
        subscriptionStatus: true,
        plan: true,
        trialEndsAt: true,
        subscriptionEndsAt: true,
        aiMessagesUsed: true,
        usagePeriodStart: true,
        isInternalAccount: true,
        adminNotice: true,
      },
    })) as unknown as BusinessUsageFields | null;
    if (!biz) return null;
    // Catalog-aware: limits shown in the countdown come from the
    // effective (panel-merged) catalog, same as the spend gate.
    const plan = typeof biz.plan === "string" && biz.plan ? biz.plan : "unknown";
    const limitOverride = await catalogLimitForPlan(
      plan === "trial" ? "trial" : plan
    );
    return buildCountdown(biz, Date.now(), limitOverride);
  } catch (err) {
    logger.warn("[billing] getBillingCountdown failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
