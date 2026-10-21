/**
 * fraud-monitor.ts — lightweight payment-claim fraud heuristics (Billing Phase 2).
 *
 * Runs ONCE at claim creation (subscription and wallet-deposit claims).
 * Deliberately lightweight: three deterministic checks, no ML, no
 * auto-rejection of real payments. A triggered heuristic writes a row to
 * `fraud_signals` for the team to review in the Admin Console — it NEVER
 * blocks or rejects the claim itself.
 *
 * Checks:
 *   duplicate_txn  — the same txnId already exists on another claim
 *                    (any business) → severity 'high'.
 *   amount_mismatch — subscription claim amount != the expected price
 *                    for the chosen interval (effective catalog price, or
 *                    the live offer's effective price when the claim
 *                    carries that offerId), or a non-positive deposit
 *                    amount → severity 'medium'.
 *   velocity       — more than 3 claims from the same business in the last
 *                    24h → severity 'medium'.
 *
 * SERVER-ONLY. runFraudHeuristics() never throws — a monitoring failure
 * must not fail the customer's claim.
 */

import admin from "firebase-admin";
import { getAdminDb } from "./admin-db";
import { PLAN_META, isPaidPlanId, type BillingInterval } from "./plans";
import {
  getCatalogPlan,
  getOfferById,
  isOfferLive,
  offerEffectivePrice,
} from "./plan-catalog";
import { logger } from "./logger";
import type { ClaimKind } from "./manual-payments";

export type FraudSignalType =
  | "duplicate_txn"
  | "amount_mismatch"
  | "velocity";

export interface FraudSignalDescriptor {
  type: FraudSignalType;
  severity: "low" | "medium" | "high";
  detail: string;
}

export interface FraudCheckInput {
  businessId: string;
  claimId: string;
  kind: ClaimKind;
  /** Cents, signed int. */
  amountCents: number;
  plan?: string;
  interval?: BillingInterval;
  /** Panel-offers (2026-10-21): the live offer that priced this claim,
   *  when one did. runFraudHeuristics resolves the expected amount from
   *  it; detectFraudSignals stays pure. */
  offerId?: string;
  /** Pre-resolved expected amount (cents) for subscription claims —
   *  catalog/offer-aware. When provided, it replaces the PLAN_META
   *  lookup in detectFraudSignals. */
  expectedCents?: number;
}

export interface FraudQuerySnapshot {
  /** True when a DIFFERENT claim already carries this txnId. */
  txnIdSeenElsewhere: boolean;
  /** Number of claims from this business in the last 24h (incl. this one). */
  claimsLast24h: number;
}

/**
 * Pure evaluation: given the claim and what the queries found, which
 * signals fire? Unit-testable without Firestore.
 */
export function detectFraudSignals(
  input: FraudCheckInput,
  found: FraudQuerySnapshot
): FraudSignalDescriptor[] {
  const signals: FraudSignalDescriptor[] = [];

  if (found.txnIdSeenElsewhere) {
    signals.push({
      type: "duplicate_txn",
      severity: "high",
      detail: `Transaction ID was already submitted on another claim (claim ${input.claimId}).`,
    });
  }

  if (input.kind === "subscription") {
    // Expected amount: a pre-resolved catalog/offer price wins; otherwise
    // the code-catalog price for code plans (unchanged behaviour).
    let expectedCents: number | null = null;
    if (typeof input.expectedCents === "number") {
      expectedCents = input.expectedCents;
    } else if (isPaidPlanId(input.plan)) {
      expectedCents =
        (input.interval === "yearly"
          ? PLAN_META[input.plan].yearlyPriceUsd
          : PLAN_META[input.plan].priceUsd) * 100;
    }
    if (expectedCents !== null && input.amountCents !== expectedCents) {
      signals.push({
        type: "amount_mismatch",
        severity: "medium",
        detail: `Claim amount ${input.amountCents}c differs from the ${input.plan}/${input.interval ?? "monthly"} price ${expectedCents}c.`,
      });
    }
  } else if (input.amountCents <= 0) {
    signals.push({
      type: "amount_mismatch",
      severity: "medium",
      detail: `Wallet deposit amount is not positive (${input.amountCents}c).`,
    });
  }

  if (found.claimsLast24h > 3) {
    signals.push({
      type: "velocity",
      severity: "medium",
      detail: `${found.claimsLast24h} claims from this business in the last 24h.`,
    });
  }

  return signals;
}

async function writeSignals(
  db: admin.firestore.Firestore,
  input: FraudCheckInput,
  signals: FraudSignalDescriptor[]
): Promise<void> {
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const s of signals) {
    const ref = db.collection("fraud_signals").doc();
    batch.set(ref, {
      businessId: input.businessId,
      type: s.type,
      severity: s.severity,
      detail: s.detail,
      claimId: input.claimId,
      status: "open",
      createdAt: now,
    });
  }
  await batch.commit();
}

/**
 * Run the heuristics for a freshly created claim and persist any signals.
 * Never throws; logs and swallows monitoring failures.
 */
export async function runFraudHeuristics(
  input: FraudCheckInput & { txnId: string }
): Promise<void> {
  try {
    const db = getAdminDb();
    const claims = db.collection("payment_claims");

    const [dupSnap, recentSnap] = await Promise.all([
      claims.where("txnId", "==", input.txnId).limit(5).get(),
      claims
        .where("businessId", "==", input.businessId)
        .where(
          "createdAt",
          ">",
          admin.firestore.Timestamp.fromDate(
            new Date(Date.now() - 24 * 60 * 60 * 1000)
          )
        )
        .get(),
    ]);

    const txnIdSeenElsewhere = dupSnap.docs.some(
      (d) => d.id !== input.claimId
    );

    // Catalog/offer-aware expected amount (panel plans + offers,
    // 2026-10-21): when the claim carries an offerId that is still live
    // for its plan, the expected amount is that offer's effective price;
    // otherwise the effective catalog price. A config-priced or
    // offer-priced claim must NOT be flagged as an amount mismatch.
    // Resolution failure leaves expectedCents unset → detectFraudSignals
    // falls back to the code-catalog behaviour exactly as before.
    let expectedCents: number | undefined;
    if (input.kind === "subscription" && input.plan) {
      try {
        const plan = await getCatalogPlan(input.plan);
        if (plan) {
          const interval: BillingInterval =
            input.interval === "yearly" ? "yearly" : "monthly";
          let effective: number | null = null;
          if (input.offerId) {
            const offer = await getOfferById(input.offerId);
            if (
              offer &&
              offer.planId === input.plan &&
              isOfferLive(offer, new Date())
            ) {
              effective = offerEffectivePrice(plan, offer, interval);
            }
          }
          const usd =
            effective ??
            (interval === "yearly" ? plan.yearlyPriceUsd : plan.priceUsd);
          expectedCents = Math.round(usd * 100);
        }
      } catch {
        expectedCents = undefined;
      }
    }

    const signals = detectFraudSignals(
      expectedCents !== undefined ? { ...input, expectedCents } : input,
      {
        txnIdSeenElsewhere,
        claimsLast24h: recentSnap.size,
      }
    );

    if (signals.length > 0) {
      await writeSignals(db, input, signals);
      logger.warn("[fraud] signals recorded", {
        businessId: input.businessId,
        claimId: input.claimId,
        types: signals.map((s) => `${s.type}:${s.severity}`).join(","),
      });
    }
  } catch (err) {
    // Monitoring must never fail the claim.
    logger.warn("[fraud] heuristic run failed (claim unaffected)", {
      businessId: input.businessId,
      claimId: input.claimId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
