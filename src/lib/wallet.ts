/**
 * wallet.ts — tenant SaaS wallet (Billing Phase 2).
 *
 * Firestore collections (shared contract with the Admin Console — the
 * admin-console worker builds against this exact shape, do not deviate):
 *
 *   wallets/{businessId}:
 *     { businessId, balanceCents: int >= 0, currency: 'USD', updatedAt }
 *   wallet_transactions/{autoId}:
 *     { businessId, type: 'deposit'|'purchase'|'adjustment',
 *       amountCents: signed int, method?, claimId?, plan?, interval?,
 *       balanceAfterCents: int, createdAt, createdBy, note? }
 *
 * Money is integer cents everywhere — no float math. All mutations run
 * inside Firestore transactions. Wallets are server-only: no client writes
 * (see firestore.rules); tenants read their own balance via GET /api/wallet.
 *
 * SERVER-ONLY: uses firebase-admin. Never import from client components.
 */

import admin from "firebase-admin";
import { getAdminDb } from "./admin-db";
import { createWithUniqueRefCode } from "./ref-codes";
import { runFraudHeuristics } from "./fraud-monitor";
import { kickVisionPreRead } from "./auto-verify";
import {
  isManualMethodId,
  isMethodEnabled,
  type ManualMethodId,
  type ClaimKind,
} from "./manual-payments";
import {
  PLAN_META,
  isPaidPlanId,
  isBillingInterval,
  type PaidPlanId,
  type BillingInterval,
} from "./plans";
import { logger } from "./logger";

export type WalletTransactionType = "deposit" | "purchase" | "adjustment";

export interface Wallet {
  businessId: string;
  /** Integer cents, always >= 0. */
  balanceCents: number;
  currency: "USD";
  updatedAt: Date | null;
}

export interface WalletTransaction {
  id: string;
  businessId: string;
  type: WalletTransactionType;
  /** Signed integer cents (negative for purchases). */
  amountCents: number;
  method?: ManualMethodId;
  claimId?: string;
  plan?: PaidPlanId;
  interval?: BillingInterval;
  /** Integer cents — wallet balance right after this transaction. */
  balanceAfterCents: number;
  createdAt: Date | null;
  createdBy: string;
  note?: string;
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

function asWallet(businessId: string, data: Record<string, unknown>): Wallet {
  const raw = data.balanceCents;
  const balanceCents =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return {
    businessId,
    balanceCents,
    currency: "USD",
    updatedAt: toDate(data.updatedAt),
  };
}

function asTransaction(
  id: string,
  data: Record<string, unknown>
): WalletTransaction {
  return {
    id,
    businessId: String(data.businessId ?? ""),
    type: data.type as WalletTransactionType,
    amountCents:
      typeof data.amountCents === "number" ? Math.trunc(data.amountCents) : 0,
    method: isManualMethodId(data.method) ? data.method : undefined,
    claimId: typeof data.claimId === "string" ? data.claimId : undefined,
    plan: isPaidPlanId(data.plan) ? data.plan : undefined,
    interval: isBillingInterval(data.interval) ? data.interval : undefined,
    balanceAfterCents:
      typeof data.balanceAfterCents === "number"
        ? Math.trunc(data.balanceAfterCents)
        : 0,
    createdAt: toDate(data.createdAt),
    createdBy: String(data.createdBy ?? ""),
    note: typeof data.note === "string" ? data.note : undefined,
  };
}

/** Server-only: read a tenant's wallet (zero-balance default, never throws). */
export async function getWallet(businessId: string): Promise<Wallet> {
  try {
    const snap = await getAdminDb()
      .collection("wallets")
      .doc(businessId)
      .get();
    if (!snap.exists) {
      return { businessId, balanceCents: 0, currency: "USD", updatedAt: null };
    }
    return asWallet(businessId, snap.data() as Record<string, unknown>);
  } catch (err) {
    logger.warn("[wallet] getWallet failed — returning zero balance", {
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { businessId, balanceCents: 0, currency: "USD", updatedAt: null };
  }
}

/** Server-only: recent wallet transactions, newest first (never throws). */
export async function getWalletTransactions(
  businessId: string,
  limit = 100
): Promise<WalletTransaction[]> {
  try {
    const snap = await getAdminDb()
      .collection("wallet_transactions")
      .where("businessId", "==", businessId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 200))
      .get();
    return snap.docs.map((d) =>
      asTransaction(d.id, d.data() as Record<string, unknown>)
    );
  } catch (err) {
    logger.warn("[wallet] getWalletTransactions failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Price of a plan+interval in integer cents (server-side, never from client). */
export function planPriceCents(
  plan: PaidPlanId,
  interval: BillingInterval
): number {
  return (
    (interval === "yearly"
      ? PLAN_META[plan].yearlyPriceUsd
      : PLAN_META[plan].priceUsd) * 100
  );
}

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "method_disabled"
      | "invalid_amount"
      | "insufficient_balance"
      | "not_found"
      | "wrong_kind"
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/**
 * Server-only: file a wallet-deposit claim.
 *
 * Validates the method is enabled and the amount is a positive integer
 * number of cents, creates the claim (kind='wallet_deposit') with a unique
 * refCode inside a transaction, then runs the fraud heuristics and kicks
 * the Tier-2 vision pre-read (both async, never blocking, never throwing).
 */
export async function createDepositClaim(
  businessId: string,
  input: {
    method: ManualMethodId;
    amountCents: number;
    txnId: string;
    screenshotDataUrl: string;
  }
): Promise<{ claimId: string; refCode: string }> {
  if (!isManualMethodId(input.method)) {
    throw new WalletError("Unknown payment method.", "method_disabled");
  }
  if (!(await isMethodEnabled(input.method))) {
    throw new WalletError(
      "This payment method is no longer available.",
      "method_disabled"
    );
  }
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > 100_000_000 // $1M sanity cap
  ) {
    throw new WalletError(
      "Deposit amount must be a positive whole-cent value.",
      "invalid_amount"
    );
  }
  const txnId = input.txnId.trim();
  if (!txnId || txnId.length > 200) {
    throw new WalletError("A valid transaction ID is required.", "invalid_amount");
  }

  const kind: ClaimKind = "wallet_deposit";
  const { id: claimId, refCode } = await createWithUniqueRefCode(
    getAdminDb(),
    "payment_claims",
    {
      businessId,
      kind,
      plan: "",
      interval: "",
      method: input.method,
      amount: input.amountCents / 100,
      amountCents: input.amountCents,
      reference: "",
      txnId,
      screenshotDataUrl: input.screenshotDataUrl,
      status: "pending",
      autoVerify: { status: "pending" },
      visionPreRead: { status: "pending" },
      createdBy: `tenant:${businessId}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }
  );

  // Monitoring + Tier-2 pre-read: async, never block or fail the claim.
  const base = {
    businessId,
    claimId,
    kind,
    amountCents: input.amountCents,
    txnId,
  };
  await runFraudHeuristics(base);
  kickVisionPreRead(claimId);

  return { claimId, refCode };
}

/**
 * Server-only: buy/renew a plan from the wallet balance.
 *
 * Single Firestore transaction: balance check + deduct + transaction row +
 * business subscription activation. Throws WalletError('insufficient_balance')
 * when the wallet cannot cover the price. Idempotent per call — one call
 * performs at most one deduction.
 */
export async function purchaseFromWallet(
  businessId: string,
  input: { plan: PaidPlanId; interval: BillingInterval }
): Promise<{ balanceCents: number; subscriptionEndsAt: Date }> {
  if (!isPaidPlanId(input.plan) || !isBillingInterval(input.interval)) {
    throw new WalletError("Invalid plan or interval.", "invalid_amount");
  }
  const priceCents = planPriceCents(input.plan, input.interval);
  const db = getAdminDb();
  const walletRef = db.collection("wallets").doc(businessId);
  const businessRef = db.collection("businesses").doc(businessId);

  const result = await db.runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);
    const balanceCents =
      walletSnap.exists &&
      typeof (walletSnap.data() as { balanceCents?: unknown }).balanceCents ===
        "number"
        ? Math.trunc(
            (walletSnap.data() as { balanceCents: number }).balanceCents
          )
        : 0;
    if (balanceCents < priceCents) {
      throw new WalletError(
        `Insufficient wallet balance: need $${(priceCents / 100).toFixed(2)}, have $${(balanceCents / 100).toFixed(2)}.`,
        "insufficient_balance"
      );
    }
    const newBalance = balanceCents - priceCents;
    const now = new Date();
    const endsAt = new Date(now);
    if (input.interval === "yearly") endsAt.setFullYear(endsAt.getFullYear() + 1);
    else endsAt.setMonth(endsAt.getMonth() + 1);

    tx.set(
      walletRef,
      {
        businessId,
        balanceCents: newBalance,
        currency: "USD",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    const txnRef = db.collection("wallet_transactions").doc();
    tx.set(txnRef, {
      businessId,
      type: "purchase",
      amountCents: -priceCents,
      plan: input.plan,
      interval: input.interval,
      balanceAfterCents: newBalance,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: `tenant:${businessId}`,
      note: `${PLAN_META[input.plan].name} ${input.interval} subscription`,
    });
    tx.set(
      businessRef,
      {
        subscriptionStatus: "active",
        plan: input.plan,
        billingInterval: input.interval,
        subscriptionEndsAt: admin.firestore.Timestamp.fromDate(endsAt),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { balanceCents: newBalance, subscriptionEndsAt: endsAt };
  });

  logger.info("[wallet] plan purchased from wallet", {
    businessId,
    plan: input.plan,
    interval: input.interval,
    priceCents,
    balanceCents: result.balanceCents,
  });
  return result;
}

/**
 * Server-only: credit a wallet for an APPROVED deposit claim.
 *
 * Called by the Admin Console approval path (shared contract). The
 * transaction only proceeds when the claim is status 'pending' AND
 * kind 'wallet_deposit'; re-running on an already-approved claim is a
 * safe no-op (idempotent).
 */
export async function creditWalletForClaim(
  claimId: string,
  adminId: string
): Promise<{ credited: boolean; balanceCents: number }> {
  const db = getAdminDb();
  const claimRef = db.collection("payment_claims").doc(claimId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(claimRef);
    if (!snap.exists) {
      throw new WalletError(`Claim ${claimId} not found.`, "not_found");
    }
    const claim = snap.data() as Record<string, unknown>;
    const kind: string =
      typeof claim.kind === "string" ? claim.kind : "subscription";
    if (kind !== "wallet_deposit") {
      throw new WalletError(
        `Claim ${claimId} is not a wallet deposit claim.`,
        "wrong_kind"
      );
    }
    if (claim.status !== "pending") {
      // Idempotent: already handled (approved/rejected) — no double credit.
      const businessId = String(claim.businessId ?? "");
      const w = businessId
        ? await tx.get(db.collection("wallets").doc(businessId))
        : null;
      const balanceCents =
        w &&
        w.exists &&
        typeof (w.data() as { balanceCents?: unknown }).balanceCents ===
          "number"
          ? Math.trunc((w.data() as { balanceCents: number }).balanceCents)
          : 0;
      return { credited: false, balanceCents };
    }

    const businessId = String(claim.businessId ?? "");
    const amountCents =
      typeof claim.amountCents === "number"
        ? Math.trunc(claim.amountCents)
        : Math.round(Number(claim.amount ?? 0) * 100);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new WalletError(
        `Claim ${claimId} has an invalid amount.`,
        "invalid_amount"
      );
    }

    const walletRef = db.collection("wallets").doc(businessId);
    const walletSnap = await tx.get(walletRef);
    const prevBalance =
      walletSnap.exists &&
      typeof (walletSnap.data() as { balanceCents?: unknown }).balanceCents ===
        "number"
        ? Math.trunc((walletSnap.data() as { balanceCents: number }).balanceCents)
        : 0;
    const newBalance = prevBalance + amountCents;

    tx.set(
      walletRef,
      {
        businessId,
        balanceCents: newBalance,
        currency: "USD",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    const txnRef = db.collection("wallet_transactions").doc();
    tx.set(txnRef, {
      businessId,
      type: "deposit",
      amountCents,
      method: claim.method ?? null,
      claimId,
      balanceAfterCents: newBalance,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: adminId,
      note: "Manual deposit claim approved",
    });
    tx.update(claimRef, {
      status: "approved",
      approvedBy: adminId,
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { credited: true, balanceCents: newBalance };
  });

  logger.info("[wallet] deposit claim credited", {
    claimId,
    adminId,
    credited: result.credited,
    balanceCents: result.balanceCents,
  });
  return result;
}
