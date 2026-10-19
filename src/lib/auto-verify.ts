/**
 * auto-verify.ts — crypto claim auto-verification + Tier-2 vision pre-read
 * (Billing Phase 2).
 *
 * runAutoVerify(): scans `payment_claims` for pending SUBSCRIPTION claims
 * paid via a crypto method (binance/bybit/okx) and tries to match an
 * incoming exchange deposit whose memo/tag contains the claim's refCode
 * with a matching amount. Outcomes per claim:
 *   - exchange not configured → autoVerify.status = 'not_configured'
 *   - deposit matched         → autoVerify.status = 'matched', then the
 *                               claim is approved and the subscription
 *                               activated (idempotent)
 *   - no match                → left 'pending' (NEVER auto-rejected —
 *                               user decision: lightweight, no false
 *                               rejections)
 *   - non-crypto method       → skipped (human verification path)
 *
 * kickVisionPreRead(): Tier-2 — after a claim is created, read the payment
 * screenshot with the business's configured AI backend (if any) and store
 * the extracted txn id / amount with a confidence level. Async, never
 * throws, never blocks claim creation. When no AI backend is configured
 * the claim records status 'unavailable' honestly.
 *
 * SERVER-ONLY.
 */

import admin from "firebase-admin";
import { getAdminDb } from "./admin-db";
import { getAdapterForMethod } from "./exchanges";
import { isValidRefCode } from "./ref-codes";
import { getUnscopedPrisma } from "./prisma";
import { perceiveMedia } from "./ai/media";
import { isPaidPlanId, isBillingInterval } from "./plans";
import { logger } from "./logger";

const AUTO_VERIFY_METHODS = ["binance", "bybit", "okx"] as const;

export type AutoVerifyAction =
  | "matched_approved"
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
): Promise<{ approved: boolean }> {
  const db = getAdminDb();
  const claimRef = db.collection("payment_claims").doc(claimId);

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
    if (!isPaidPlanId(plan)) {
      throw new Error(`Claim ${claimId} has an invalid plan.`);
    }

    const now = new Date();
    const endsAt = new Date(now);
    if (interval === "yearly") endsAt.setFullYear(endsAt.getFullYear() + 1);
    else endsAt.setMonth(endsAt.getMonth() + 1);

    const businessId = String(claim.businessId ?? "");
    tx.set(
      db.collection("businesses").doc(businessId),
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
    });

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

/**
 * One auto-verify sweep over pending crypto subscription claims.
 * Safe to run on a schedule; per-claim failures never abort the sweep.
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
    const claimId = doc.id;
    const claim = doc.data() as Record<string, unknown>;
    const businessId = String(claim.businessId ?? "");
    const method = String(claim.method ?? "");

    const finish = (action: AutoVerifyAction, note: string) => {
      outcomes.push({ claimId, businessId, action, note });
    };

    if (!(AUTO_VERIFY_METHODS as readonly string[]).includes(method)) {
      finish("skipped", `method ${method || "unknown"} is not auto-verifiable`);
      continue;
    }

    const adapter = getAdapterForMethod(
      method as "binance" | "bybit" | "okx"
    );
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
      finish("not_configured", "exchange API not configured");
      continue;
    }

    const refCode = claim.refCode;
    const amountCents =
      typeof claim.amountCents === "number"
        ? Math.trunc(claim.amountCents)
        : Math.round(Number(claim.amount ?? 0) * 100);
    if (!isValidRefCode(refCode) || !Number.isInteger(amountCents) || amountCents <= 0) {
      finish("skipped", "claim has no usable refCode/amount");
      continue;
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
      finish("error", "exchange lookup failed");
      continue;
    }

    if (match.found) {
      await markAutoVerify(db, claimId, {
        status: "matched",
        exchange: method,
        note: match.note,
      });
      try {
        await approveSubscriptionClaim(claimId, "auto-verify");
        finish("matched_approved", match.note);
      } catch (err) {
        finish(
          "error",
          `deposit matched but approval failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      // Lightweight by design: no match is NOT a rejection — the claim
      // stays pending for human verification.
      await markAutoVerify(db, claimId, {
        status: "pending",
        exchange: method,
        note: match.note,
      }).catch(() => {});
      finish("no_match", match.note);
    }
  }

  logger.info("[auto-verify] sweep complete", {
    checked: outcomes.length,
    matched: outcomes.filter((o) => o.action === "matched_approved").length,
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

  // The "AI backend" is the business's own configured AI key (honest
  // 'unavailable' when the business never connected one).
  let apiKey: string | undefined;
  try {
    const settings = (await getUnscopedPrisma().settings.findFirst({
      where: { businessId },
    })) as unknown as { aiApiKey?: unknown } | null;
    if (typeof settings?.aiApiKey === "string" && settings.aiApiKey.trim()) {
      apiKey = settings.aiApiKey.trim();
    }
  } catch {
    // fall through to 'unavailable'
  }
  if (!apiKey) {
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
    const seen = await perceiveMedia(apiKey, "gpt-4o-mini", {
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
