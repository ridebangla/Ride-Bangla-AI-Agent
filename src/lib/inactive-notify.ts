/**
 * inactive-notify.ts — automatic tenant notifications (owner directive
 * 2026-10-21: the panel can notify inactive accounts, "যদিও এই নিজে
 * থেকেই পাঠাবে" — and the system should also send on its own).
 *
 * What exists without this module: trial/usage warnings are computed
 * live by billing-usage (buildCountdown) and shown when a tenant opens
 * the dashboard or the bell — nothing is ever WRITTEN to a tenant who
 * simply never comes back. This sweep writes the one stored notice the
 * tenant surfaces already read — `adminNotice` on the business doc
 * (dashboard banner + GET /api/notifications bell) — for:
 *   - trial_ending:          trial ends within 3 days (once per trial)
 *   - trial_ended:           trial lapsed, gate inactive
 *   - subscription_inactive: any other gate-inactive state
 *     (past_due / canceled / expired / suspended / paid period lapsed)
 *
 * Discipline:
 * - Gate truth comes from isSubscriptionActive() itself — no second
 *   derivation that could drift from enforcement.
 * - Internal owner accounts and manual-override tenants are active by
 *   rule and are never notified.
 * - Dedupe: the doc carries autoNotify {kind, episodeKey, sentAt}; an
 *   episode (keyed by the status + the relevant end date) is notified
 *   once, with ONE repeat allowed after 7 days for the inactive kinds.
 * - A fresh human notice wins: if adminNotice was written by a person
 *   (createdBy not starting "system:") within the last 7 days, the
 *   sweep leaves it untouched.
 * - createdBy is "system:auto-notify" so the panel can tell automatic
 *   notices from team-written ones.
 *
 * The message texts are MINIMAL functional defaults proposed for owner
 * approval (listed verbatim in final-verification/
 * admin-tenant-control.md). TEXTS carries EN + BN variants, but the
 * composed tenant notice renders ENGLISH ONLY (language rule
 * 2026-10-21: default UI language is English, no mixing).
 */

import { getAdminDb } from "@/lib/admin-db";
import { isSubscriptionActive } from "@/lib/subscription";
import { logger } from "@/lib/logger";

export const AUTO_NOTIFY_CREATED_BY = "system:auto-notify";
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_ENDING_WINDOW_MS = 3 * DAY_MS;
const REPEAT_AFTER_MS = 7 * DAY_MS;
const HUMAN_NOTICE_PROTECT_MS = 7 * DAY_MS;

export type AutoNoticeKind =
  | "trial_ending"
  | "trial_ended"
  | "subscription_inactive";

/** The gate-relevant fields of a business doc (raw Firestore shapes). */
export interface BusinessGateFields {
  isActive?: unknown;
  isInternalAccount?: unknown;
  manualActiveOverride?: unknown;
  subscriptionStatus?: unknown;
  trialEndsAt?: unknown;
  subscriptionEndsAt?: unknown;
  adminNotice?: { createdAt?: unknown; createdBy?: unknown } | null;
  autoNotify?: {
    kind?: unknown;
    episodeKey?: unknown;
    sentAt?: unknown;
  } | null;
}

export interface AutoNoticeDecision {
  kind: AutoNoticeKind;
  episodeKey: string;
}

function toMs(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function toDateOrNull(value: unknown): Date | null {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms);
}

function iso(ms: number | null): string {
  return ms === null ? "none" : new Date(ms).toISOString();
}

/**
 * Pure decision: should this business receive an automatic notice, and
 * for which episode? Mirrors the platform gate exactly (it CALLS it).
 */
export function decideAutoNotice(
  fields: BusinessGateFields,
  nowMs: number
): AutoNoticeDecision | null {
  if (fields.isInternalAccount === true) return null;
  if (fields.manualActiveOverride === true) return null;

  const status =
    typeof fields.subscriptionStatus === "string"
      ? fields.subscriptionStatus
      : "";
  const trialEndMs = toMs(fields.trialEndsAt);
  const subEndMs = toMs(fields.subscriptionEndsAt);
  // The gate's own date handling expects Date-shaped values; raw
  // Firestore Timestamps are normalized first so the sweep can never
  // drift from enforcement (a Timestamp fed straight in would read as
  // "no date" and flip period checks).
  const active = isSubscriptionActive({
    isActive: fields.isActive,
    isInternalAccount: fields.isInternalAccount,
    manualActiveOverride: fields.manualActiveOverride,
    subscriptionStatus: fields.subscriptionStatus,
    trialEndsAt: toDateOrNull(fields.trialEndsAt),
    subscriptionEndsAt: toDateOrNull(fields.subscriptionEndsAt),
  } as unknown as Parameters<typeof isSubscriptionActive>[0]);

  if (active) {
    if (
      status === "trialing" &&
      trialEndMs !== null &&
      trialEndMs > nowMs &&
      trialEndMs - nowMs <= TRIAL_ENDING_WINDOW_MS
    ) {
      return { kind: "trial_ending", episodeKey: `trial:${iso(trialEndMs)}` };
    }
    return null;
  }

  if (status === "trialing") {
    return { kind: "trial_ended", episodeKey: `trial:${iso(trialEndMs)}` };
  }
  return {
    kind: "subscription_inactive",
    episodeKey: `sub:${status || "none"}:${iso(subEndMs ?? trialEndMs)}`,
  };
}

/**
 * Pure dedupe/protection check: given the doc's existing autoNotify
 * marker and adminNotice, may the sweep write this decision now?
 */
export function shouldSendAutoNotice(
  fields: BusinessGateFields,
  decision: AutoNoticeDecision,
  nowMs: number
): boolean {
  // A fresh human-written notice is never overwritten by the machine.
  const notice = fields.adminNotice;
  if (notice && typeof notice.createdBy === "string") {
    if (!notice.createdBy.startsWith("system:")) {
      const createdMs = toMs(notice.createdAt);
      if (createdMs !== null && nowMs - createdMs < HUMAN_NOTICE_PROTECT_MS) {
        return false;
      }
    }
  }
  const marker = fields.autoNotify;
  if (
    marker &&
    marker.kind === decision.kind &&
    marker.episodeKey === decision.episodeKey
  ) {
    if (decision.kind === "trial_ending") return false; // once per trial
    const sentMs = toMs(marker.sentAt);
    if (sentMs !== null && nowMs - sentMs < REPEAT_AFTER_MS) return false;
  }
  return true;
}

const TEXTS: Record<
  AutoNoticeKind,
  { titleEn: string; bodyEn: string; titleBn: string; bodyBn: string }
> = {
  trial_ending: {
    titleEn: "Your free trial is ending soon",
    bodyEn:
      "Renew your subscription to keep your AI agent running without interruption.",
    titleBn: "আপনার ফ্রি ট্রায়াল শীঘ্রই শেষ হচ্ছে",
    bodyBn:
      "আপনার AI এজেন্ট নিরবচ্ছিন্নভাবে চালু রাখতে সাবস্ক্রিপশন নবায়ন করুন।",
  },
  trial_ended: {
    titleEn: "Your free trial has ended",
    bodyEn:
      "Your AI agent is paused. Please renew your subscription to reactivate it.",
    titleBn: "আপনার ফ্রি ট্রায়াল শেষ হয়েছে",
    bodyBn:
      "আপনার AI এজেন্ট বন্ধ আছে। পুনরায় চালু করতে সাবস্ক্রিপশন নবায়ন করুন।",
  },
  subscription_inactive: {
    titleEn: "Your AI agent is paused",
    bodyEn:
      "Your subscription is inactive, so your agent is not replying to customers. Renew to resume.",
    titleBn: "আপনার AI এজেন্ট বন্ধ আছে",
    bodyBn:
      "আপনার সাবস্ক্রিপশন সক্রিয় নয়, তাই এজেন্ট গ্রাহকদের উত্তর দিচ্ছে না। পুনরায় চালু করতে নবায়ন করুন।",
  },
};

/** The exact message written to adminNotice.message for a kind.
 *  English only — the BN variants stay in TEXTS as the bn resource. */
export function autoNoticeMessage(kind: AutoNoticeKind): string {
  const t = TEXTS[kind];
  return `${t.titleEn} — ${t.bodyEn}`;
}

export interface InactiveNotifyResult {
  businessId: string;
  action: "sent" | "skipped";
  kind?: AutoNoticeKind;
  reason?: string;
}

/**
 * One sweep over every business. Server-side only (Admin SDK) — the
 * same invocation pattern as runAutoVerify: a scheduler holding
 * CRON_SECRET or the platform Super Admin triggers it through
 * POST /api/billing/notify-inactive.
 */
export async function runInactiveNotifySweep(
  nowMs: number = Date.now()
): Promise<{ checked: number; sent: number; results: InactiveNotifyResult[] }> {
  const db = getAdminDb();
  const snap = await db.collection("businesses").get();
  const results: InactiveNotifyResult[] = [];
  let sent = 0;

  for (const doc of snap.docs) {
    const fields = doc.data() as BusinessGateFields;
    const decision = decideAutoNotice(fields, nowMs);
    if (!decision) {
      results.push({ businessId: doc.id, action: "skipped", reason: "no_notice_needed" });
      continue;
    }
    if (!shouldSendAutoNotice(fields, decision, nowMs)) {
      results.push({
        businessId: doc.id,
        action: "skipped",
        kind: decision.kind,
        reason: "deduped_or_recent_manual_notice",
      });
      continue;
    }
    try {
      await doc.ref.update({
        adminNotice: {
          message: autoNoticeMessage(decision.kind),
          createdAt: new Date(nowMs),
          createdBy: AUTO_NOTIFY_CREATED_BY,
        },
        autoNotify: {
          kind: decision.kind,
          episodeKey: decision.episodeKey,
          sentAt: new Date(nowMs),
        },
      });
      sent += 1;
      results.push({ businessId: doc.id, action: "sent", kind: decision.kind });
    } catch (err) {
      logger.warn("[inactive-notify] write failed", {
        businessId: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({ businessId: doc.id, action: "skipped", kind: decision.kind, reason: "write_failed" });
    }
  }

  return { checked: snap.size, sent, results };
}
