/**
 * manual-payments.ts — user-configured manual payment methods (Phase 4b).
 *
 * The business owner (Super Admin) enters his own receiving details in the
 * Admin Console ("AI SaaS" → Payment Methods). Customers on /billing see
 * ONLY enabled methods and pay manually (US bank transfer, Binance Pay,
 * Bybit, OKX, WeChat Pay), then submit a claim with their transaction ID +
 * payment screenshot. The team verifies the claim in the Admin Console and
 * activates the subscription.
 *
 * Firestore layout:
 *   payment_methods_config/{methodId} — one doc per method
 *     (us_bank, binance, bybit, okx, wechat_pay). Field shapes differ per
 *     method; every doc has {enabled: boolean}.
 *   payment_claims/{claimId} — {businessId, plan, interval, method, amount,
 *     reference, txnId, screenshotDataUrl, status:'pending'|'approved'|
 *     'rejected', rejectReason?, createdAt}
 *
 * SERVER-ONLY: uses firebase-admin (same bootstrap pattern as the
 * launch-readiness route). Client components must NOT value-import this
 * module — the /billing page passes serialized method objects as props.
 *
 * NOTE (honest, post-Blaze): payment screenshots are stored as compressed
 * base64 data URLs in the claim doc because Firebase Storage is unavailable
 * until Blaze billing is paid. Migrate `screenshotDataUrl` to a Storage
 * object + download URL once Storage exists.
 */

import admin from "firebase-admin";
import { assertTxnIdNotClaimed } from "./claim-dedupe";
export { DuplicateTxnError } from "./claim-dedupe";

/** Manual payment method ids — one Firestore doc each. */
export type ManualMethodId =
  | "us_bank"
  | "binance"
  | "bybit"
  | "okx"
  | "wechat_pay";

export const MANUAL_METHOD_IDS: readonly ManualMethodId[] = [
  "us_bank",
  "binance",
  "bybit",
  "okx",
  "wechat_pay",
];

export function isManualMethodId(value: unknown): value is ManualMethodId {
  return (
    typeof value === "string" &&
    (MANUAL_METHOD_IDS as readonly string[]).includes(value)
  );
}

export const MANUAL_METHOD_LABELS: Record<ManualMethodId, string> = {
  us_bank: "US bank transfer",
  binance: "Binance Pay",
  bybit: "Bybit",
  okx: "OKX",
  wechat_pay: "WeChat Pay",
};

/** Display fields for one enabled method (serialized to the client). */
export interface ManualPaymentMethod {
  id: ManualMethodId;
  enabled: boolean;
  label: string;
  // us_bank
  bankName?: string;
  accountName?: string;
  routingNumber?: string;
  accountNumber?: string;
  // binance / bybit / okx
  payId?: string;
  uid?: string;
  // wechat_pay
  qrImage?: string;
  note?: string;
}

export type ClaimStatus = "pending" | "approved" | "rejected" | "fraud_rejected";

/** Billing Phase 2: what the claim pays for. Old docs predate the field
 *  and are treated as 'subscription'. */
export type ClaimKind = "subscription" | "wallet_deposit";

export function isClaimKind(value: unknown): value is ClaimKind {
  return value === "subscription" || value === "wallet_deposit";
}

export interface PaymentClaim {
  id: string;
  businessId: string;
  /** Billing Phase 2: 'subscription' (default for old docs) | 'wallet_deposit'. */
  kind: ClaimKind;
  /** Server-generated payment reference (RB-XXXXXXXX) — the customer is
   *  asked to include it in their payment note/memo. */
  refCode: string;
  plan: string;
  interval: string;
  method: ManualMethodId;
  /** Legacy USD float (pre-Phase-2 docs). New claims store amountCents. */
  amount: number;
  /** Integer cents — the money field of record (Billing Phase 2). */
  amountCents?: number;
  /** Panel-offers (2026-10-21): set when a live ai_offers offer priced
   *  this claim — the offer id, and the regular (pre-offer) amount in
   *  cents, so the panel and the fraud monitor can see both figures. */
  offerId?: string;
  regularAmountCents?: number;
  reference: string;
  txnId: string;
  screenshotDataUrl: string;
  status: ClaimStatus;
  /** Billing Phase 2: exchange auto-verification state (crypto methods). */
  autoVerify?: {
    status: "pending" | "matched" | "failed" | "not_configured";
    exchange?: string;
    checkedAt?: unknown;
    note?: string;
  };
  /** Billing Phase 2: Tier-2 vision pre-read of the payment screenshot. */
  visionPreRead?: {
    status: "pending" | "done" | "unavailable";
    extractedTxnId?: string;
    extractedAmount?: string;
    confidence?: "low" | "medium" | "high";
    note?: string;
  };
  rejectReason?: string;
  createdAt: unknown;
}

// ---------------------------------------------------------------------------
// firebase-admin bootstrap (server-only)
// ---------------------------------------------------------------------------

const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  "ride-bangla-app";

let adminDb: admin.firestore.Firestore | null = null;

function getAdminDb(): admin.firestore.Firestore {
  if (adminDb) return adminDb;
  if (admin.apps.length === 0) {
    if (!SERVICE_ACCOUNT_JSON) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_KEY is not set — manual-payment reads need the Admin SDK."
      );
    }
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(SERVICE_ACCOUNT_JSON) as admin.ServiceAccount
      ),
      projectId: PROJECT_ID,
    });
  }
  adminDb = admin.firestore(admin.apps[0]!);
  return adminDb;
}

function strField(
  data: Record<string, unknown>,
  key: string
): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Server-only: the ENABLED methods, in display order, for the /billing page.
 * Reads via the Admin SDK (bypasses Firestore rules). Never throws for a
 * missing/empty config — returns [] and the page says "coming soon".
 */
export async function getPublicManualPaymentMethods(): Promise<
  ManualPaymentMethod[]
> {
  let db: admin.firestore.Firestore;
  try {
    db = getAdminDb();
  } catch {
    return [];
  }
  const out: ManualPaymentMethod[] = [];
  for (const id of MANUAL_METHOD_IDS) {
    let snap: admin.firestore.DocumentSnapshot;
    try {
      snap = await db.collection("payment_methods_config").doc(id).get();
    } catch {
      continue;
    }
    if (!snap.exists) continue;
    const d = snap.data() as Record<string, unknown>;
    if (d.enabled !== true) continue;
    out.push({
      id,
      enabled: true,
      label: strField(d, "label") ?? MANUAL_METHOD_LABELS[id],
      bankName: strField(d, "bankName"),
      accountName: strField(d, "accountName"),
      routingNumber: strField(d, "routingNumber"),
      accountNumber: strField(d, "accountNumber"),
      payId: strField(d, "payId"),
      uid: strField(d, "uid"),
      qrImage: strField(d, "qrImage"),
      note: strField(d, "note"),
    });
  }
  return out;
}

/** Server-only: is this method currently enabled (re-checked at claim time). */
export async function isMethodEnabled(id: ManualMethodId): Promise<boolean> {
  try {
    const snap = await getAdminDb()
      .collection("payment_methods_config")
      .doc(id)
      .get();
    return snap.exists && (snap.data() as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/** Server-only: create a pending payment claim (Admin SDK write).
 *
 *  Billing Phase 2: every claim is created INSIDE a Firestore transaction
 *  with a unique server-generated refCode (RB-XXXXXXXX) — the customer is
 *  shown the code and asked to include it in their payment note/memo.
 *  New claims always carry `kind` and `amountCents` (integer cents; the
 *  legacy `amount` USD float is kept for backwards compatibility with the
 *  /billing page). `autoVerify`/`visionPreRead` start as 'pending'.
 *
 *  Returns { claimId, refCode }.
 */
export async function createPaymentClaim(input: {
  businessId: string;
  plan: string;
  interval: string;
  method: ManualMethodId;
  amount: number;
  amountCents?: number;
  reference: string;
  txnId: string;
  screenshotDataUrl: string;
  kind?: ClaimKind;
  createdBy?: string;
  /** Panel-offers: the live offer that priced this claim, when one did. */
  offerId?: string;
  /** Panel-offers: the regular (pre-offer) amount in cents, when an
   *  offer priced this claim. */
  regularAmountCents?: number;
}): Promise<{ claimId: string; refCode: string }> {
  await assertTxnIdNotClaimed(input.txnId);
  const { createWithUniqueRefCode } = await import("./ref-codes");
  const { id, refCode } = await createWithUniqueRefCode(
    getAdminDb(),
    "payment_claims",
    {
      businessId: input.businessId,
      kind: input.kind ?? "subscription",
      plan: input.plan,
      interval: input.interval,
      method: input.method,
      amount: input.amount,
      // Integer cents is the money field of record; derive from the USD
      // float when the caller only has dollars.
      amountCents:
        typeof input.amountCents === "number"
          ? input.amountCents
          : Math.round(input.amount * 100),
      // Panel-offers passthrough: written only when an offer applied, so
      // pre-offer claim docs keep their exact old shape.
      ...(input.offerId ? { offerId: input.offerId } : {}),
      ...(typeof input.regularAmountCents === "number"
        ? { regularAmountCents: input.regularAmountCents }
        : {}),
      reference: input.reference,
      txnId: input.txnId,
      screenshotDataUrl: input.screenshotDataUrl,
      status: "pending" as ClaimStatus,
      autoVerify: { status: "pending" as const },
      visionPreRead: { status: "pending" as const },
      createdBy: input.createdBy ?? `tenant:${input.businessId}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }
  );
  return { claimId: id, refCode };
}