/**
 * auto-verify.ts — AI payment verification + auto-activation
 * (Billing Phase 2 + owner directive 2026-10-21: the AUTOMATIC path is
 * PRIMARY — a clean, fully-verified payment activates with no human
 * touch; the Admin Console's manual verify is backup/correction only).
 *
 * runAutoVerify(): scans `payment_claims` for pending SUBSCRIPTION claims
 * and decides each one:
 *   - crypto method (binance/bybit/okx) → match an incoming exchange
 *     deposit whose memo/tag contains the claim's refCode with a
 *     matching amount (real signed deposit-history adapters in
 *     ./exchanges; live calls are key-gated on the owner's exchange
 *     API keys):
 *       - exchange not configured → autoVerify.status = 'not_configured'
 *       - deposit matched         → autoVerify.status = 'matched', the
 *                                   claim is approved and the
 *                                   subscription activated (idempotent),
 *                                   decision + audit recorded
 *       - no match                → left 'pending' (NEVER auto-rejected —
 *                                   the deposit may land later)
 *   - bank (us_bank) → the AI receipt decision
 *     engine (payment-decision.ts): the screenshot is read with a
 *     receipt-specific prompt and EVERY check must pass (exact amount,
 *     USD-or-unread currency, txn id or refCode visible, sane date,
 *     configured recipient, txn not already approved elsewhere) to
 *     auto-activate. Any failure → the claim STAYS 'pending' with the
 *     full check list recorded as `decision` evidence for the human
 *     queue (never auto-rejected). Claims that already carry a decision
 *     are left to the human queue.
 *
 * kickClaimDecision(claimId): the primary path — fired at claim
 * creation so a clean payment activates immediately, not on the next
 * sweep. kickVisionPreRead(): Tier-2 advisory pre-read (unchanged):
 * extract txn id / amount for the console, never decides anything.
 *
 * Every AI decision writes `decision` {by:'ai', outcome, checks,
 * decidedAt} on the claim and an `admin_audit_logs` entry in the
 * console's exact shape (actor 'Auto-Verify (AI)', role 'system',
 * category 'finance'; txn ids masked — no full financial identifiers
 * in logs). approveSubscriptionClaim() also stores
 * `activationSnapshot` on the claim so the Admin Console can reverse
 * an approval exactly.
 *
 * SERVER-ONLY.
 */

import admin from "firebase-admin";
import { getAdminDb } from "./admin-db";
import { getAdapterForMethod } from "./exchanges";
import { isValidRefCode } from "./ref-codes";
import { perceiveMedia, describeImageWithVision } from "./ai/media";
import { hasAnyProviderKey, resolveSiteKeys, type ProviderKeys } from "./ai/providers";
import { isPaidPlanId, isBillingInterval } from "./plans";
import { getCatalogPlan } from "./plan-catalog";
import { txnLockId, txnNormOf } from "./claim-dedupe";
import {
  RECEIPT_QUESTION,
  parseReceiptExtraction,
  evaluateReceiptChecks,
  type DecisionCheck,
  type ReceiptExtraction,
} from "./payment-decision";
import { logger } from "./logger";

const AUTO_VERIFY_METHODS = ["binance", "bybit", "okx"] as const;
const RECEIPT_METHODS = ["us_bank"] as const;

export type AutoVerifyAction =
  | "matched_approved"
  | "auto_approved"
  | "human_review"
  | "not_configured"
  | "no_match"
  | "skipped"
  | "error";

export interface AutoVerifyOutcome {
  claimId: string;
  businessId: string;
  action: AutoVerifyAction;
  note: string;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as admin.firestore.Timestamp).toDate();
  }
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Idempotent: approve a subscription claim and activate the subscription.
 * Re-running on an already-approved claim is a safe no-op.
 */
export async function approveSubscriptionClaim(
  claimId: string,
  approvedBy: string
): Promise<{ approved: boolean; conflict?: boolean }> {
  const db = getAdminDb();
  const claimRef = db.collection("payment_claims").doc(claimId);

  // Panel-created plans (attack-test 2026-10-21): a code plan id is always
  // valid; any OTHER plan id is valid only when it exists as an ACTIVE
  // plan in the effective catalog (ai_plans merged over the code catalog).
  // Resolved BEFORE the transaction (the catalog read is a separate
  // Firestore read); the transaction re-checks the claim's plan against
  // this pre-read value and fails closed on any mismatch.
  const preSnap = await claimRef.get();
  const prePlan: unknown = preSnap.exists
    ? (preSnap.data() as Record<string, unknown>).plan
    : undefined;
  let prePlanOk = isPaidPlanId(prePlan);
  if (!prePlanOk && typeof prePlan === "string" && prePlan) {
    const catalogPlan = await getCatalogPlan(prePlan).catch(() => null);
    prePlanOk = !!catalogPlan && catalogPlan.active;
  }

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(claimRef);
    if (!snap.exists) {
      throw new Error(`Claim ${claimId} not found.`);
    }
    const claim = snap.data() as Record<string, unknown>;
    const kind: string =
      typeof claim.kind === "string" ? claim.kind : "subscription";
    if (kind !== "subscription") {
      throw new Error(`Claim ${claimId} is not a subscription claim.`);
    }
    if (claim.status !== "pending") {
      return { approved: false };
    }

    const plan = claim.plan;
    const interval = isBillingInterval(claim.interval) ? claim.interval : "monthly";
    if (!isPaidPlanId(plan) && !(prePlanOk && plan === prePlan)) {
      throw new Error(`Claim ${claimId} has an invalid plan.`);
    }

    const now = new Date();
    const endsAt = new Date(now);
    if (interval === "yearly") endsAt.setFullYear(endsAt.getFullYear() + 1);
    else endsAt.setMonth(endsAt.getMonth() + 1);

    const businessId = String(claim.businessId ?? "");
    const bizRef = db.collection("businesses").doc(businessId);
    // Snapshot the pre-activation state (all reads happen before any
    // write, per Firestore transaction rules) so the Admin Console can
    // reverse this approval exactly — restoring what was there instead
    // of guessing.
    const bizSnap = await tx.get(bizRef);
    const bizData = bizSnap.exists
      ? (bizSnap.data() as Record<string, unknown>)
      : undefined;
    // One transaction ID funds at most ONE approval (attack-test
    // 2026-10-21): the shared txn lock doc is read (and taken, when a
    // legacy claim predates creation locks) INSIDE this transaction.
    // A lock owned by a DIFFERENT claim aborts the approval — this is
    // what serializes two concurrent decisions on claims that share a
    // payment, which the non-transactional uniqueness query cannot.
    const claimTxnId = typeof claim.txnId === "string" ? claim.txnId : "";
    const txnNorm = txnNormOf(claimTxnId);
    let lockRef: admin.firestore.DocumentReference | null = null;
    let lockNeedsWrite = false;
    if (txnNorm) {
      lockRef = db.collection("payment_claim_locks").doc(txnLockId(txnNorm));
      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists) {
        const owner = (lockSnap.data() as { claimId?: unknown }).claimId;
        if (typeof owner === "string" && owner !== claimId) {
          return { approved: false, conflict: true };
        }
      } else {
        lockNeedsWrite = true;
      }
    }
    const activationSnapshot = {
      existed: bizSnap.exists,
      subscriptionStatus:
        typeof bizData?.subscriptionStatus === "string"
          ? bizData.subscriptionStatus
          : null,
      plan: typeof bizData?.plan === "string" ? bizData.plan : null,
      billingInterval:
        typeof bizData?.billingInterval === "string"
          ? bizData.billingInterval
          : null,
      subscriptionEndsAt: toDate(bizData?.subscriptionEndsAt)?.toISOString() ?? null,
      isActive: typeof bizData?.isActive === "boolean" ? bizData.isActive : null,
      // Activation resets the usage period (below) — capture the
      // pre-activation values too, or a reversal can never restore
      // them exactly (attack-test 2026-10-21).
      aiMessagesUsed:
        typeof bizData?.aiMessagesUsed === "number" ? bizData.aiMessagesUsed : null,
      usagePeriodStart: toDate(bizData?.usagePeriodStart)?.toISOString() ?? null,
    };
    tx.set(
      bizRef,
      {
        subscriptionStatus: "active",
        plan,
        billingInterval: interval,
        subscriptionEndsAt: admin.firestore.Timestamp.fromDate(endsAt),
        // Reset the message-usage period on (re)activation so the new
        // billing cycle starts with a fresh allowance.
        aiMessagesUsed: 0,
        usagePeriodStart: admin.firestore.Timestamp.fromDate(now),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.update(claimRef, {
      status: "approved",
      approvedBy,
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      activationSnapshot,
    });
    if (lockRef && lockNeedsWrite) {
      tx.set(lockRef, {
        product: "ai",
        txnId: claimTxnId,
        txnIdNorm: txnNorm,
        claimId,
        businessId,
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    logger.info("[auto-verify] subscription claim approved", {
      claimId,
      businessId,
      plan,
      interval,
      approvedBy,
    });
    return { approved: true };
  });
}

async function markAutoVerify(
  db: admin.firestore.Firestore,
  claimId: string,
  autoVerify: {
    status: "pending" | "matched" | "failed" | "not_configured";
    exchange?: string;
    note?: string;
  }
): Promise<void> {
  await db
    .collection("payment_claims")
    .doc(claimId)
    .update({
      autoVerify: {
        ...autoVerify,
        checkedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
}

/** Mask a txn id for audit-log notes: last 4 characters only. */
function maskTxn(txn: string): string {
  const clean = txn.trim();
  if (!clean) return "n/a";
  if (clean.length <= 4) return "••••";
  return `••••${clean.slice(-4)}`;
}

export interface ClaimDecision {
  by: "ai";
  outcome: "auto_approve" | "human_review";
  checks: DecisionCheck[];
}

/**
 * Record the AI decision on the claim (`decision` field — the evidence
 * the human queue works from). Returns true when a NEW decision was
 * written (first decision, or the outcome changed) — the caller writes
 * the audit entry only then, so sweep retries never flood the log.
 */
async function recordDecision(
  db: admin.firestore.Firestore,
  claimId: string,
  existing: unknown,
  decision: ClaimDecision
): Promise<boolean> {
  const prev = (existing ?? null) as { outcome?: unknown } | null;
  if (prev && prev.outcome === decision.outcome) return false;
  await db
    .collection("payment_claims")
    .doc(claimId)
    .update({
      decision: {
        by: decision.by,
        outcome: decision.outcome,
        checks: decision.checks,
        decidedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  return true;
}

/**
 * One `admin_audit_logs` entry in the Admin Console's exact shape
 * (auditLogService.createAuditLog) for an AI verification decision.
 * Txn ids are masked — no full financial identifiers in logs.
 * Best-effort: an audit failure never undoes a verification decision.
 */
async function writeAutoVerifyAudit(
  db: admin.firestore.Firestore,
  entry: {
    claimId: string;
    outcome: "auto_approve" | "human_review";
    note: string;
  }
): Promise<void> {
  try {
    await db.collection("admin_audit_logs").doc().set({
      actorUid: null,
      actorName: "Auto-Verify (AI)",
      actorEmail: "",
      actorRole: "system",
      action:
        entry.outcome === "auto_approve"
          ? "ai_saas.payment_claim.auto_verify_approve"
          : "ai_saas.payment_claim.auto_verify_review",
      entityType: "ai_saas_payment_claim",
      entityId: entry.claimId,
      category: "finance",
      status: entry.outcome === "auto_approve" ? "success" : "info",
      note: entry.note,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn("[auto-verify] audit write failed", {
      claimId: entry.claimId,
      error: String(err),
    });
  }
}

function claimAmountCents(claim: Record<string, unknown>): number {
  return typeof claim.amountCents === "number"
    ? Math.trunc(claim.amountCents)
    : Math.round(Number(claim.amount ?? 0) * 100);
}

/**
 * Process one pending crypto subscription claim: match the exchange
 * deposit, and on a match approve + activate + record the decision and
 * audit entry. No match is NOT a rejection — the claim stays pending.
 */
async function processCryptoClaim(
  db: admin.firestore.Firestore,
  claimId: string,
  claim: Record<string, unknown>
): Promise<{ action: AutoVerifyAction; note: string }> {
  const method = String(claim.method ?? "");

  const adapter = getAdapterForMethod(method as "binance" | "bybit" | "okx");
  if (!adapter || !adapter.isConfigured()) {
    await markAutoVerify(db, claimId, {
      status: "not_configured",
      exchange: method,
      note: "Exchange API keys are not configured — human verification required.",
    }).catch((err) =>
      logger.warn("[auto-verify] mark not_configured failed", {
        claimId,
        error: String(err),
      })
    );
    return { action: "not_configured", note: "exchange API not configured" };
  }

  const refCode = claim.refCode;
  const amountCents = claimAmountCents(claim);
  if (!isValidRefCode(refCode) || !Number.isInteger(amountCents) || amountCents <= 0) {
    return { action: "skipped", note: "claim has no usable refCode/amount" };
  }

  const since =
    toDate(claim.createdAt) ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  let match;
  try {
    match = await adapter.findDeposit({ refCode, amountCents, since });
  } catch (err) {
    await markAutoVerify(db, claimId, {
      status: "failed",
      exchange: method,
      note: `Exchange lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    return { action: "error", note: "exchange lookup failed" };
  }

  if (!match.found) {
    // Lightweight by design: no match is NOT a rejection — the claim
    // stays pending for human verification / a later sweep.
    await markAutoVerify(db, claimId, {
      status: "pending",
      exchange: method,
      note: match.note,
    }).catch(() => {});
    return { action: "no_match", note: match.note };
  }

  await markAutoVerify(db, claimId, {
    status: "matched",
    exchange: method,
    note: match.note,
  });
  const checks: DecisionCheck[] = [
    { name: "exchange_deposit_match", ok: true, detail: match.note },
  ];
  try {
    const { approved, conflict } = await approveSubscriptionClaim(claimId, "auto-verify");
    if (conflict) {
      // The deposit matched THIS claim's refCode, but the claim's
      // transaction ID is already owned by another claim (attack-test
      // 2026-10-21) — never activate; a human untangles it.
      const conflictChecks: DecisionCheck[] = [
        ...checks,
        {
          name: "txn_unique",
          ok: false,
          detail:
            "This transaction ID is already claimed by another payment claim — blocked from auto-activation.",
        },
      ];
      const wrote = await recordDecision(db, claimId, claim.decision, {
        by: "ai",
        outcome: "human_review",
        checks: conflictChecks,
      }).catch(() => false);
      if (wrote) {
        await writeAutoVerifyAudit(db, {
          claimId,
          outcome: "human_review",
          note:
            `Exchange deposit matched ${method} payment (${(amountCents / 100).toFixed(2)} USD, ` +
            `ref ${refCode}) for business ${String(claim.businessId ?? "")}, but the claim's ` +
            `transaction ID is already claimed by another claim — routed to human review.`,
        });
      }
      return { action: "human_review", note: "txn id claimed by another claim" };
    }
    if (approved) {
      const wrote = await recordDecision(db, claimId, claim.decision, {
        by: "ai",
        outcome: "auto_approve",
        checks,
      }).catch(() => false);
      if (wrote) {
        await writeAutoVerifyAudit(db, {
          claimId,
          outcome: "auto_approve",
          note:
            `Auto-verified ${method} payment (${(amountCents / 100).toFixed(2)} USD, ` +
            `ref ${refCode}) for business ${String(claim.businessId ?? "")}: exchange ` +
            `deposit matched on reference + exact amount; subscription activated by Auto-Verify (AI).`,
        });
      }
    }
    return { action: "matched_approved", note: match.note };
  } catch (err) {
    return {
      action: "error",
      note: `deposit matched but approval failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The configured recipient for the receipt decision's recipient check. */
async function configuredRecipient(
  db: admin.firestore.Firestore,
  method: string
): Promise<string | null> {
  // Design contract: the recipient check applies when a recipient is
  // configured for the method (us_bank accountName).
  if (method !== "us_bank") return null;
  try {
    const snap = await db
      .collection("payment_methods_config")
      .doc(method)
      .get();
    if (!snap.exists) return null;
    const name = (snap.data() as Record<string, unknown>).accountName;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Decide one pending bank subscription claim from its payment
 * screenshot. EVERY check must pass to auto-activate; any failure
 * leaves the claim pending with the check list as evidence.
 */
async function decideReceiptClaim(
  db: admin.firestore.Firestore,
  claimId: string,
  claim: Record<string, unknown>
): Promise<{ action: AutoVerifyAction; note: string }> {
  const businessId = String(claim.businessId ?? "");
  const method = String(claim.method ?? "");
  const amountCents = claimAmountCents(claim);
  const refCode = typeof claim.refCode === "string" ? claim.refCode : "";
  const claimTxnId = typeof claim.txnId === "string" ? claim.txnId : "";

  // One transaction ID funds at most one subscription: if another
  // claim was already APPROVED with this txnId, never auto-activate.
  // The comparison is on the NORMALIZED txn form (attack-test
  // 2026-10-21): the old exact-string query let a re-cased / re-dashed
  // variant of an approved payment sail through as "unique".
  let txnAlreadyApprovedElsewhere = false;
  if (claimTxnId) {
    try {
      const norm = txnNormOf(claimTxnId);
      const byExact = await db
        .collection("payment_claims")
        .where("txnId", "==", claimTxnId)
        .where("status", "==", "approved")
        .limit(5)
        .get();
      let docs = byExact.docs;
      if (norm) {
        const byNorm = await db
          .collection("payment_claims")
          .where("txnIdNorm", "==", norm)
          .where("status", "==", "approved")
          .limit(5)
          .get();
        docs = [...docs, ...byNorm.docs];
      }
      txnAlreadyApprovedElsewhere = docs.some((d) => {
        if (d.id === claimId) return false;
        if (!norm) return true;
        const other = (d.data() as { txnId?: unknown }).txnId;
        return txnNormOf(typeof other === "string" ? other : "") === norm;
      });
    } catch (err) {
      logger.warn("[auto-verify] txn uniqueness check failed", {
        claimId,
        error: String(err),
      });
    }
  }

  // Read the receipt with the business's resolved AI backend (its own
  // keys first, platform env keys as fallback — the same resolution
  // the vision pre-read uses). No backend → no AI decision → human.
  let extraction: ReceiptExtraction | null = null;
  let visionUnavailableReason: string | undefined;
  const shot = claim.screenshotDataUrl;
  if (typeof shot !== "string" || !shot.startsWith("data:image/")) {
    visionUnavailableReason = "No readable payment screenshot on the claim.";
  } else {
    const keys = await resolveSiteKeys(businessId).catch(
      () => ({}) as ProviderKeys
    );
    if (!hasAnyProviderKey(keys)) {
      visionUnavailableReason =
        "AI backend not configured for this business — the payment screenshot could not be read.";
    } else {
      const parts = shot.split(",");
      if (parts.length < 2 || !parts[1]) {
        visionUnavailableReason = "The payment screenshot could not be read by AI.";
      } else {
        try {
          const answer = await describeImageWithVision(
            keys,
            "gpt-4o-mini",
            Buffer.from(parts[1], "base64"),
            "image/jpeg",
            RECEIPT_QUESTION
          );
          extraction = parseReceiptExtraction(answer);
        } catch (err) {
          visionUnavailableReason = "The payment screenshot could not be read by AI.";
          logger.warn("[auto-verify] receipt read failed", {
            claimId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const expectedRecipient = await configuredRecipient(db, method);
  const decision = evaluateReceiptChecks({
    claimAmountCents: amountCents,
    claimTxnId,
    refCode,
    claimCreatedAt: toDate(claim.createdAt),
    extraction,
    visionUnavailableReason,
    expectedRecipient,
    txnAlreadyApprovedElsewhere,
  });

  if (decision.outcome === "auto_approve") {
    try {
      const { approved, conflict } = await approveSubscriptionClaim(claimId, "auto-verify");
      if (conflict) {
        // Another claim owns this transaction ID (attack-test
        // 2026-10-21): the approval-time lock caught what the
        // pre-check query could not (concurrent claims). Route to a
        // human with the txn_unique check flipped to failed.
        const checks: DecisionCheck[] = decision.checks.map((c) =>
          c.name === "txn_unique"
            ? {
                ...c,
                ok: false,
                detail:
                  "This transaction ID is already claimed by another payment claim — blocked from auto-activation.",
              }
            : c
        );
        const wrote = await recordDecision(db, claimId, claim.decision, {
          by: "ai",
          outcome: "human_review",
          checks,
        }).catch(() => false);
        if (wrote) {
          await writeAutoVerifyAudit(db, {
            claimId,
            outcome: "human_review",
            note:
              `Receipt checks passed for ${method} payment (${(amountCents / 100).toFixed(2)} USD, ` +
              `ref ${refCode || "n/a"}, txn ${maskTxn(claimTxnId)}) for business ${businessId}, ` +
              `but the transaction ID is already claimed by another claim — routed to human review.`,
          });
        }
        return {
          action: "human_review",
          note: "txn id claimed by another claim — left pending for human review",
        };
      }
      if (!approved) {
        return {
          action: "skipped",
          note: "claim was no longer pending when activation ran",
        };
      }
    } catch (err) {
      // The payment evidence passed but activation failed — hand the
      // claim to a human WITH the passing checks plus the failure.
      const checks: DecisionCheck[] = [
        ...decision.checks,
        {
          name: "activation",
          ok: false,
          detail: `Automatic activation failed (${err instanceof Error ? err.message : String(err)}) — a human must activate this claim manually.`,
        },
      ];
      const wrote = await recordDecision(db, claimId, claim.decision, {
        by: "ai",
        outcome: "human_review",
        checks,
      }).catch(() => false);
      if (wrote) {
        await writeAutoVerifyAudit(db, {
          claimId,
          outcome: "human_review",
          note:
            `Receipt checks passed for ${method} payment (${(amountCents / 100).toFixed(2)} USD, ` +
            `ref ${refCode || "n/a"}, txn ${maskTxn(claimTxnId)}) for business ${businessId}, ` +
            `but automatic activation failed — routed to human review.`,
        });
      }
      return { action: "error", note: "activation failed after receipt checks passed" };
    }

    await markAutoVerify(db, claimId, {
      status: "matched",
      note: "AI receipt verification passed every check — subscription auto-activated.",
    }).catch(() => {});
    const wrote = await recordDecision(db, claimId, claim.decision, {
      by: "ai",
      outcome: "auto_approve",
      checks: decision.checks,
    }).catch(() => false);
    if (wrote) {
      await writeAutoVerifyAudit(db, {
        claimId,
        outcome: "auto_approve",
        note:
          `Auto-verified ${method} payment (${(amountCents / 100).toFixed(2)} USD, ` +
          `ref ${refCode || "n/a"}, txn ${maskTxn(claimTxnId)}) for business ${businessId}: ` +
          `receipt checks all passed; subscription activated by Auto-Verify (AI).`,
      });
    }
    return { action: "auto_approved", note: "receipt checks passed — auto-activated" };
  }

  const wrote = await recordDecision(db, claimId, claim.decision, {
    by: "ai",
    outcome: "human_review",
    checks: decision.checks,
  }).catch(() => false);
  if (wrote) {
    const failed = decision.checks.filter((c) => !c.ok).map((c) => c.name);
    await writeAutoVerifyAudit(db, {
      claimId,
      outcome: "human_review",
      note:
        `AI receipt verification for ${method} payment (${(amountCents / 100).toFixed(2)} USD, ` +
        `ref ${refCode || "n/a"}, txn ${maskTxn(claimTxnId)}) for business ${businessId} ` +
        `needs human review — failed checks: ${failed.join(", ") || "none recorded"}. ` +
        `Claim left pending (never auto-rejected).`,
    });
  }
  return {
    action: "human_review",
    note: "receipt checks did not all pass — left pending for human review",
  };
}

/**
 * Decide ONE claim by id (the primary path, kicked at claim creation,
 * and the sweep's per-claim worker). Only pending SUBSCRIPTION claims
 * are decided; wallet deposits keep the existing pre-read + human path.
 * Never throws.
 */
export async function runClaimDecision(
  claimId: string
): Promise<AutoVerifyOutcome> {
  const db = getAdminDb();
  try {
    const snap = await db.collection("payment_claims").doc(claimId).get();
    if (!snap.exists) {
      return { claimId, businessId: "", action: "skipped", note: "claim not found" };
    }
    const claim = snap.data() as Record<string, unknown>;
    const businessId = String(claim.businessId ?? "");
    const kind = typeof claim.kind === "string" ? claim.kind : "subscription";
    if (claim.status !== "pending" || kind !== "subscription") {
      return {
        claimId,
        businessId,
        action: "skipped",
        note: "claim is not a pending subscription claim",
      };
    }
    const method = String(claim.method ?? "");
    if ((AUTO_VERIFY_METHODS as readonly string[]).includes(method)) {
      const r = await processCryptoClaim(db, claimId, claim);
      return { claimId, businessId, ...r };
    }
    if ((RECEIPT_METHODS as readonly string[]).includes(method)) {
      if (claim.decision) {
        return {
          claimId,
          businessId,
          action: "skipped",
          note: "AI decision already recorded — awaiting human review",
        };
      }
      const r = await decideReceiptClaim(db, claimId, claim);
      return { claimId, businessId, ...r };
    }
    return {
      claimId,
      businessId,
      action: "skipped",
      note: `method ${method || "unknown"} is not auto-verifiable`,
    };
  } catch (err) {
    logger.warn("[auto-verify] claim decision failed", {
      claimId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      claimId,
      businessId: "",
      action: "error",
      note: "decision failed — claim left pending",
    };
  }
}

/** Fire-and-forget entry point — never throws, never blocks claim creation. */
export function kickClaimDecision(claimId: string): void {
  void runClaimDecision(claimId).catch((err) =>
    logger.warn("[auto-verify] claim decision kick failed (claim unaffected)", {
      claimId,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}

/**
 * One auto-verify sweep over pending subscription claims — the backstop
 * for the creation-time kick (deposits that land after the claim,
 * missed kicks, retries). Safe to run on a schedule; per-claim failures
 * never abort the sweep.
 */
export async function runAutoVerify(): Promise<AutoVerifyOutcome[]> {
  const db = getAdminDb();
  const outcomes: AutoVerifyOutcome[] = [];

  const snap = await db
    .collection("payment_claims")
    .where("status", "==", "pending")
    .where("kind", "==", "subscription")
    .get();

  for (const doc of snap.docs) {
    const claim = doc.data() as Record<string, unknown>;
    const businessId = String(claim.businessId ?? "");
    const method = String(claim.method ?? "");

    if ((AUTO_VERIFY_METHODS as readonly string[]).includes(method)) {
      const r = await processCryptoClaim(db, doc.id, claim);
      outcomes.push({ claimId: doc.id, businessId, ...r });
      continue;
    }
    if ((RECEIPT_METHODS as readonly string[]).includes(method)) {
      if (claim.decision) {
        outcomes.push({
          claimId: doc.id,
          businessId,
          action: "skipped",
          note: "AI decision already recorded — awaiting human review",
        });
        continue;
      }
      const r = await decideReceiptClaim(db, doc.id, claim);
      outcomes.push({ claimId: doc.id, businessId, ...r });
      continue;
    }
    outcomes.push({
      claimId: doc.id,
      businessId,
      action: "skipped",
      note: `method ${method || "unknown"} is not auto-verifiable`,
    });
  }

  logger.info("[auto-verify] sweep complete", {
    checked: outcomes.length,
    matched: outcomes.filter((o) => o.action === "matched_approved").length,
    autoApproved: outcomes.filter((o) => o.action === "auto_approved").length,
  });
  return outcomes;
}

// ---------------------------------------------------------------------------
// Tier-2 vision pre-read
// ---------------------------------------------------------------------------

interface VisionPreRead {
  status: "pending" | "done" | "unavailable";
  extractedTxnId?: string;
  extractedAmount?: string;
  confidence?: "low" | "medium" | "high";
  note?: string;
}

function parseVisionDescription(text: string): {
  extractedTxnId?: string;
  extractedAmount?: string;
  confidence: "low" | "medium" | "high";
} {
  const txnMatch =
    /(?:txn|tx|hash|transaction|utr|ref(?:erence)?)[\s#:.-]*([a-zA-Z0-9]{8,})/i.exec(
      text
    ) ?? /\b([a-fA-F0-9]{16,})\b/.exec(text);
  const amtMatch =
    /(?:amount|total|paid|rs\.?|৳|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(
      text
    );
  const extractedTxnId = txnMatch?.[1];
  const extractedAmount = amtMatch?.[1];
  const confidence =
    extractedTxnId && extractedAmount
      ? "high"
      : extractedTxnId || extractedAmount
        ? "medium"
        : "low";
  return { extractedTxnId, extractedAmount, confidence };
}

/** Fire-and-forget entry point — never throws, never blocks claim creation. */
export function kickVisionPreRead(claimId: string): void {
  void visionPreRead(claimId).catch((err) =>
    logger.warn("[vision] pre-read failed (claim unaffected)", {
      claimId,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}

async function visionPreRead(claimId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.collection("payment_claims").doc(claimId);
  const setPreRead = (v: VisionPreRead) =>
    ref.update({ visionPreRead: v }).catch(() => {});

  let snap;
  try {
    snap = await ref.get();
  } catch {
    return;
  }
  if (!snap.exists) return;
  const claim = snap.data() as Record<string, unknown>;
  const businessId = String(claim.businessId ?? "");

  // The "AI backend" is the business's resolved provider keys — its own
  // dedicated keys first, shared env keys as fallback (honest
  // 'unavailable' when the business never connected one).
  const keys = await resolveSiteKeys(businessId).catch(() => ({} as ProviderKeys));
  if (!hasAnyProviderKey(keys)) {
    await setPreRead({
      status: "unavailable",
      note: "AI backend not configured for this business.",
    });
    return;
  }

  const shot = claim.screenshotDataUrl;
  if (typeof shot !== "string" || !shot.startsWith("data:image/")) {
    await setPreRead({ status: "unavailable", note: "No payment screenshot." });
    return;
  }
  const parts = shot.split(",");
  if (parts.length < 2 || !parts[1]) {
    await setPreRead({ status: "unavailable", note: "Unreadable screenshot." });
    return;
  }

  try {
    const seen = await perceiveMedia(keys, "gpt-4o-mini", {
      kind: "image",
      mimeType: "image/jpeg",
      bytes: Buffer.from(parts[1], "base64"),
    });
    const parsed = parseVisionDescription(seen.description);
    await setPreRead({
      status: "done",
      ...parsed,
      note:
        parsed.confidence === "low"
          ? "Could not extract transaction details from the screenshot."
          : "Extracted from the payment screenshot (advisory — the team still verifies).",
    });
  } catch {
    await setPreRead({
      status: "unavailable",
      note: "Vision read failed.",
    });
  }
}

// Exported for unit tests.
export const __testables = { parseVisionDescription };
