/**
 * advance-payments.ts — LEG C (booking batch, staged):
 * advance + transaction-ID MANUAL-check pattern.
 *
 * PATTERN ONLY — RE-IMPLEMENTED FROM SCRATCH. No payment gateway is
 * integrated here, no bKash/Nagad (or any provider) link exists, and
 * nothing in this file verifies a payment automatically. The flow is:
 *
 *   1. The tenant configures, for their own business only: a payment
 *      number, an optional label for that number, and a fixed advance
 *      amount (see `AdvanceConfig`). Nothing is configured by default.
 *   2. The agent states that number + amount EXACTLY as configured
 *      (via the `get_advance_payment_details` tool) and asks the
 *      customer to send money to it and reply with the transaction ID.
 *   3. The customer sends a transaction ID. It is stored with the
 *      order/booking as a payment record with status `checking`
 *      (via the `record_advance_payment` tool). The agent tells the
 *      customer the payment is BEING CHECKED — never that it is
 *      received.
 *   4. A HUMAN on the team checks the money itself (in their own
 *      banking/mobile-banking app — outside this system) and presses
 *      "Payment received" in the dashboard. ONLY then does the payment
 *      become `received`, and ONLY then may the customer be told the
 *      payment is received.
 *
 * BINDING DOCTRINES:
 * - Per-surface identity: every lookup filters by the ambient business.
 *   A payment belonging to another tenant resolves as "not found".
 * - The agent NEVER confirms an order/booking. Payment records never
 *   change an order/booking status, and `markPaymentReceived` never
 *   confirms anything — it only records that a human verified money.
 * - The agent NEVER quotes fares. The advance amount is the tenant's
 *   own configured figure, never a delivery charge or fare, and it is
 *   NEVER taken from model/chat input: the server snapshots it from
 *   tenant config at record time. A model-supplied amount is ignored
 *   (the tool schema has no amount parameter at all).
 * - No chat amount "sticks": receipts are derived from stored payment
 *   docs, never from anything said in chat.
 * - Limit model untouched: recording/checking payments is order data
 *   and team configuration, not a metered AI feature. No new meter.
 * - No invented copy: tool results carry machine codes + numbers; the
 *   agent renders them in the customer's language. Receipt line labels
 *   below are PROPOSAL English wording for owner approval.
 *
 * GUARDRAILS (enforced in code, not just in prompts):
 * - The tool schema has NO card-number, OTP, or password parameter.
 * - `refuseSensitivePaymentInput` refuses any call whose transaction
 *   ID looks like a card number (13-19 digits) or whose arguments
 *   carry otp/password/card/cvv/pin keys. The agent must never ask
 *   for those, and the server refuses them if they arrive anyway.
 * - Fail-closed defaults: no tenant config => advance NOT applicable;
 *   the agent must state NO payment number and NO advance amount.
 *   Enabled-but-no-appliesTo => applies to nothing. An unconfigured
 *   business never gets an invented number or amount.
 *
 * STORAGE (deliberate, minimal-touch choice — mirrors the staged
 * coupon module's precedent):
 * - Payments live in a raw Firestore collection named
 *   `advance_payments` accessed through the Admin SDK (`getAdminDb`),
 *   NOT through the Prisma-style delegate — registering a new
 *   delegate model would mean a large diff to `src/lib/firestore.ts`.
 * - The payment doc id is deterministic:
 *   `${businessId}_${TRANSACTION_ID}` (the transaction-ID charset is
 *   restricted so the id can never contain a `/`). Recording runs
 *   inside a transaction that fails when the doc already exists, so
 *   two simultaneous recordings of the same transaction ID for the
 *   same business cannot both succeed. The same transaction ID at a
 *   DIFFERENT business is a different doc (different money, different
 *   tenant) and is allowed.
 * - Tenant config lives on the business doc itself as the
 *   `advancePayment` field (same doc that already carries
 *   `orderFields`, edited in dashboard "Order Settings"). It is read
 *   and written through the raw Admin SDK for the same minimal-touch
 *   reason: no delegate field registration is staged here. Apply-time
 *   must confirm the `businesses` doc-id convention (the staged coupon
 *   module already relies on the same raw-doc convention for orders).
 * - Record existence + tenancy is the CALLER's job: the store trusts
 *   the caller to have verified that `recordId` belongs to
 *   `businessId` (the agent tool does a tenant-scoped order read; the
 *   dashboard routes run inside `runWithBusiness`). The store itself
 *   enforces `businessId` on every payment doc and the duplicate guard.
 * - Booking records: at HEAD, bookings ARE order docs (`take_order`
 *   records "ORDER or BOOKING" into the orders collection). A distinct
 *   booking record type belongs to Leg A of this batch, which is still
 *   in flight with no staged record type yet. This module therefore
 *   accepts `recordKind: "booking"` as a typed seam, but the agent
 *   tool and dashboard routes REFUSE booking-kind records with
 *   `booking_store_not_wired` until Leg A wires a booking lookup.
 *   Nothing here redefines booking states, and nothing here locks or
 *   confirms a booking (Leg B owns locking; Leg A owns states).
 *
 * AUDIT TRAIL (append-only, never edited):
 * - Every payment doc carries `audit`: one entry per transition.
 *   `recorded` entries say WHO recorded it (customer via the agent,
 *   with conversationId — or a team member, with userId) and WHEN.
 *   `marked_received` entries say WHICH team member pressed "Payment
 *   received" and WHEN. Audit entries are only ever appended inside
 *   the same transaction as the state change they describe.
 * - A duplicate recording attempt writes NOTHING (no new doc, no
 *   audit entry) and returns the existing payment id instead.
 *
 * RECEIPTS:
 * - `computeReceiptBreakdown` is pure: order total − RECEIVED advances
 *   = amount due. Advances still `checking` are shown as an
 *   information line ONLY and are NEVER deducted — money the team has
 *   not verified must not reduce what the customer owes on paper.
 * - Amount due floors at 0 and is null when the order total is null
 *   (service-quote orders with no priced total). Money is rounded to
 *   2 decimals, matching `computeTotal` in `src/lib/orders.ts`.
 *   Currency is NOT assumed: amounts are plain numbers in the tenant's
 *   own currency; no currency symbol is invented here.
 *
 * This file has NO top-level side effects and NO static imports of
 * Firebase/Prisma: store access is via dynamic import inside the async
 * functions, so the pure functions compile standalone for tests.
 */

export type AdvanceRecordKind = "order" | "booking";

export type AdvancePaymentStatus = "checking" | "received";

/** Tenant-configured advance settings, stored on the business doc. */
export interface AdvanceConfig {
  /** Master switch. False / missing => advance flow is OFF. */
  enabled: boolean;
  /** Which record kinds the advance applies to. Empty => applies to nothing. */
  appliesTo: AdvanceRecordKind[];
  /** The business's own payment number, stated verbatim to customers. */
  paymentNumber: string;
  /** Tenant's own label for the number (free text, max 60 chars). */
  paymentLabel: string | null;
  /** Fixed advance amount in the tenant's own currency (plain number). */
  advanceAmount: number;
}

export interface AdvanceConfigInput {
  enabled?: unknown;
  appliesTo?: unknown;
  paymentNumber?: unknown;
  paymentLabel?: unknown;
  advanceAmount?: unknown;
}

export type AuditActor =
  | { type: "customer"; conversationId: string | null }
  | { type: "team"; userId: string };

export interface AuditEntry {
  action: "recorded" | "marked_received";
  actor: AuditActor;
  at: string;
}

export interface AdvancePayment {
  id: string;
  businessId: string;
  recordKind: AdvanceRecordKind;
  recordId: string;
  transactionId: string;
  /** Snapshot of the tenant-configured advance amount at record time. */
  amount: number;
  status: AdvancePaymentStatus;
  recordedBy: AuditActor;
  recordedAt: string;
  markedReceivedBy: string | null;
  markedReceivedAt: string | null;
  audit: AuditEntry[];
}

export type AdvanceErrorCode =
  | "invalid_transaction_id"
  | "sensitive_data_refused"
  | "duplicate_transaction_id"
  | "advance_not_configured"
  | "advance_not_applicable"
  | "booking_store_not_wired"
  | "record_not_found"
  | "payment_not_found"
  | "already_received";

export interface PriceLine {
  /** Machine key, stable for dashboard rendering. */
  key: "order_total" | "advance_received" | "advance_checking" | "amount_due";
  /** PROPOSAL English label — owner approval required before shipping. */
  label: string;
  amount: number | null;
  /** "deduction" lines subtract; "info" lines never affect the due. */
  kind: "total" | "deduction" | "info" | "due";
}

export interface ReceiptBreakdown {
  orderTotal: number | null;
  advanceReceived: number;
  advanceChecking: number;
  amountDue: number | null;
  lines: PriceLine[];
}

const RECORD_KINDS: AdvanceRecordKind[] = ["order", "booking"];
const TXN_RE = /^[A-Z0-9]{6,32}$/;
/** Digits-only, card-number length range (after stripping separators). */
const CARD_LIKE_RE = /^\d{13,19}$/;
const SENSITIVE_KEY_RE = /otp|password|passwd|card|cvv|pin/i;

export const ADVANCE_PAYMENTS_COLLECTION = "advance_payments";
export const BUSINESSES_COLLECTION = "businesses";

/** Round money to 2 decimals, matching `computeTotal` in orders.ts. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Validate tenant-supplied advance config. Every value is tenant
 * supplied; nothing is defaulted except the fail-closed switches:
 * `enabled` defaults to false, `appliesTo` defaults to [] (nothing).
 * A missing payment number or advance amount is REJECTED, never filled.
 */
export function validateAdvanceConfig(input: AdvanceConfigInput): AdvanceConfig {
  const enabled = Boolean(input.enabled ?? false);
  const rawApplies = Array.isArray(input.appliesTo) ? input.appliesTo : [];
  const appliesTo = [...new Set(rawApplies.map((k) => String(k)))]
    .filter((k): k is AdvanceRecordKind =>
      (RECORD_KINDS as string[]).includes(k)
    );
  const paymentNumber = String(input.paymentNumber ?? "").trim();
  if (paymentNumber.length < 6 || paymentNumber.length > 40) {
    throw new Error("paymentNumber must be 6-40 characters.");
  }
  if (!/^[+0-9][0-9 ()-]*$/.test(paymentNumber)) {
    throw new Error("paymentNumber contains unsupported characters.");
  }
  const rawLabel = String(input.paymentLabel ?? "").trim();
  const paymentLabel = rawLabel ? rawLabel.slice(0, 60) : null;
  const amount = Number(input.advanceAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("advanceAmount must be a finite number >= 0.");
  }
  return {
    enabled,
    appliesTo,
    paymentNumber,
    paymentLabel,
    advanceAmount: roundMoney(amount),
  };
}

/** A config with no usable advance is treated as "no config" upstream. */
export function isAdvanceApplicable(
  config: AdvanceConfig | null,
  recordKind: AdvanceRecordKind
): boolean {
  if (!config || !config.enabled) return false;
  if (!config.appliesTo.includes(recordKind)) return false;
  if (!config.paymentNumber) return false;
  if (!(config.advanceAmount > 0)) return false;
  return true;
}

/**
 * Normalize a customer-supplied transaction ID: trim, uppercase, drop
 * spaces/dashes. Returns null when the result is not a plausible ID.
 * (Transaction IDs are operator-issued alphanumerics; anything else
 * is a customer typo, not a different kind of payment reference.)
 */
export function normalizeTransactionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toUpperCase().replace(/[ -]/g, "");
  if (!TXN_RE.test(cleaned)) return null;
  return cleaned;
}

export function isValidTransactionId(raw: unknown): boolean {
  return normalizeTransactionId(raw) !== null;
}

/**
 * Sensitive-data guardrail. Refuses the call when the transaction ID
 * looks like a card number, or when any argument key smells like an
 * OTP / password / card / CVV / PIN field with a non-empty value.
 * Returns the refusal reason, or null when the args are clean.
 */
export function refuseSensitivePaymentInput(
  args: Record<string, unknown>
): string | null {
  for (const [key, value] of Object.entries(args)) {
    if (
      SENSITIVE_KEY_RE.test(key) &&
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return `Refused: field "${key}" must never be collected for payments.`;
    }
  }
  const txnRaw = String(args.transactionId ?? "").replace(/[ -]/g, "");
  if (CARD_LIKE_RE.test(txnRaw)) {
    return "Refused: that looks like a card number, not a transaction ID. Card numbers must never be collected.";
  }
  return null;
}

/** Deterministic payment doc id — the duplicate guard's anchor. */
export function advancePaymentDocId(
  businessId: string,
  transactionId: string
): string {
  return `${businessId}_${transactionId}`;
}

export function buildAuditEntry(
  action: AuditEntry["action"],
  actor: AuditActor,
  at = new Date().toISOString()
): AuditEntry {
  return { action, actor, at };
}

/**
 * Pure duplicate decision: given the payment doc that already exists
 * for this deterministic id (or null), decide whether recording may
 * proceed. Any existing doc — checking OR received — blocks a second
 * recording of the same transaction ID for the same business.
 */
export function decideAdvanceRecording(args: {
  existing: AdvancePayment | null;
}): { ok: true } | { ok: false; error: "duplicate_transaction_id"; existingPaymentId: string } {
  if (args.existing) {
    return {
      ok: false,
      error: "duplicate_transaction_id",
      existingPaymentId: args.existing.id,
    };
  }
  return { ok: true };
}

/**
 * Pure mark-received decision: only a `checking` payment belonging to
 * this business may transition, and only to `received` (one-way).
 * Cross-tenant ids resolve as `payment_not_found` — never leaking
 * another tenant's payment existence.
 */
export function decideMarkReceived(args: {
  existing: AdvancePayment | null;
  businessId: string;
}):
  | { ok: true }
  | { ok: false; error: "payment_not_found" }
  | { ok: false; error: "already_received" } {
  if (!args.existing || args.existing.businessId !== args.businessId) {
    return { ok: false, error: "payment_not_found" };
  }
  if (args.existing.status === "received") {
    return { ok: false, error: "already_received" };
  }
  return { ok: true };
}

/**
 * Pure receipt math. ONLY `received` advances deduct from the amount
 * due. `checking` advances are listed as information and change
 * nothing — unverified money must not reduce what is owed on paper.
 */
export function computeReceiptBreakdown(args: {
  orderTotal: number | null;
  payments: AdvancePayment[];
}): ReceiptBreakdown {
  let advanceReceived = 0;
  let advanceChecking = 0;
  for (const p of args.payments) {
    if (p.status === "received") advanceReceived += p.amount;
    else advanceChecking += p.amount;
  }
  advanceReceived = roundMoney(advanceReceived);
  advanceChecking = roundMoney(advanceChecking);
  const orderTotal =
    args.orderTotal !== null && Number.isFinite(args.orderTotal)
      ? roundMoney(args.orderTotal)
      : null;
  const amountDue =
    orderTotal === null ? null : Math.max(0, roundMoney(orderTotal - advanceReceived));
  const lines: PriceLine[] = [
    { key: "order_total", label: "Order total", amount: orderTotal, kind: "total" },
  ];
  if (advanceReceived > 0) {
    lines.push({
      key: "advance_received",
      label: "Advance received",
      amount: advanceReceived,
      kind: "deduction",
    });
  }
  if (advanceChecking > 0) {
    lines.push({
      key: "advance_checking",
      label: "Advance awaiting manual check",
      amount: advanceChecking,
      kind: "info",
    });
  }
  lines.push({ key: "amount_due", label: "Amount due", amount: amountDue, kind: "due" });
  return { orderTotal, advanceReceived, advanceChecking, amountDue, lines };
}

// Firestore-backed store (Admin SDK, raw collection — see header).
// ---------------------------------------------------------------------------

type AdminDb = {
  collection: (name: string) => {
    doc: (id: string) => unknown;
    where: (
      field: string,
      op: string,
      value: unknown
    ) => {
      get: () => Promise<{
        docs: Array<{ id: string; data: () => Record<string, unknown> }>;
      }>;
    };
  };
  runTransaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
};

type Tx = {
  get: (ref: unknown) => Promise<{
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
  }>;
  set: (ref: unknown, data: Record<string, unknown>) => void;
  update: (ref: unknown, data: Record<string, unknown>) => void;
};

async function getDb(): Promise<AdminDb> {
  const { getAdminDb } = await import("./firestore");
  return getAdminDb() as unknown as AdminDb;
}

function decodePayment(
  id: string,
  data: Record<string, unknown>
): AdvancePayment {
  const auditRaw = Array.isArray(data.audit) ? data.audit : [];
  return {
    id,
    businessId: String(data.businessId ?? ""),
    recordKind: (RECORD_KINDS as string[]).includes(String(data.recordKind))
      ? (data.recordKind as AdvanceRecordKind)
      : "order",
    recordId: String(data.recordId ?? ""),
    transactionId: String(data.transactionId ?? ""),
    amount: Number(data.amount ?? 0),
    status: data.status === "received" ? "received" : "checking",
    recordedBy: (data.recordedBy as AuditActor) ?? {
      type: "customer",
      conversationId: null,
    },
    recordedAt: String(data.recordedAt ?? ""),
    markedReceivedBy:
      typeof data.markedReceivedBy === "string" ? data.markedReceivedBy : null,
    markedReceivedAt:
      typeof data.markedReceivedAt === "string" ? data.markedReceivedAt : null,
    audit: auditRaw
      .filter(
        (e): e is Record<string, unknown> =>
          !!e && typeof e === "object" && typeof (e as { action?: unknown }).action === "string"
      )
      .map((e) => ({
        action: e.action as AuditEntry["action"],
        actor: e.actor as AuditActor,
        at: String(e.at ?? ""),
      })),
  };
}

/**
 * Read the tenant's advance config from the business doc. Returns null
 * when the business has no `advancePayment` field or it is invalid —
 * invalid config is treated as NO config (fail-closed), never as a
 * partially-invented one.
 */
export async function getAdvanceConfig(
  businessId: string
): Promise<AdvanceConfig | null> {
  if (!businessId) return null;
  const db = await getDb();
  const ref = db.collection(BUSINESSES_COLLECTION).doc(businessId) as {
    get: () => Promise<{
      exists: boolean;
      data: () => Record<string, unknown> | undefined;
    }>;
  };
  const snap = await ref.get();
  if (!snap.exists) return null;
  const raw = snap.data()?.advancePayment;
  if (!raw || typeof raw !== "object") return null;
  try {
    return validateAdvanceConfig(raw as AdvanceConfigInput);
  } catch {
    return null;
  }
}

/**
 * Write the tenant's advance config onto the business doc (dashboard
 * settings route). Validates first; a rejected config writes nothing.
 */
export async function setAdvanceConfig(
  businessId: string,
  input: AdvanceConfigInput
): Promise<AdvanceConfig> {
  const config = validateAdvanceConfig(input);
  const db = await getDb();
  const ref = db.collection(BUSINESSES_COLLECTION).doc(businessId) as {
    update: (data: Record<string, unknown>) => Promise<void>;
    set: (data: Record<string, unknown>, opts?: unknown) => Promise<void>;
  };
  try {
    await ref.update({ advancePayment: config });
  } catch {
    // Doc may not exist yet under the raw collection; merge-set instead.
    await ref.set({ advancePayment: config }, { merge: true });
  }
  return config;
}

/**
 * Record a customer-supplied transaction ID against an order/booking.
 * Atomic duplicate guard: the deterministic doc id + a transaction
 * existence check mean a second simultaneous recording of the same
 * transaction ID for the same business fails with
 * `duplicate_transaction_id` instead of silently overwriting or
 * double-counting. The amount is ALWAYS the caller-supplied snapshot
 * of tenant config — never model/chat input (the tool schema has no
 * amount parameter). The caller MUST have verified that `recordId`
 * belongs to `businessId` before calling.
 */
export async function recordAdvancePayment(args: {
  businessId: string;
  recordKind: AdvanceRecordKind;
  recordId: string;
  transactionId: string;
  amount: number;
  recordedBy: AuditActor;
}): Promise<
  | { ok: true; payment: AdvancePayment }
  | { ok: false; error: "duplicate_transaction_id"; existingPaymentId: string }
> {
  const transactionId = normalizeTransactionId(args.transactionId);
  if (!transactionId) throw new Error("invalid_transaction_id");
  const amount = roundMoney(args.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("advance amount must be a finite number >= 0.");
  }
  const db = await getDb();
  const id = advancePaymentDocId(args.businessId, transactionId);
  const ref = db.collection(ADVANCE_PAYMENTS_COLLECTION).doc(id);
  const now = new Date().toISOString();
  return db.runTransaction(async (txRaw) => {
    const tx = txRaw as Tx;
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existing = decodePayment(id, snap.data() ?? {});
      const decision = decideAdvanceRecording({ existing });
      if (!decision.ok) return decision;
    }
    const payment: AdvancePayment = {
      id,
      businessId: args.businessId,
      recordKind: args.recordKind,
      recordId: args.recordId,
      transactionId,
      amount,
      status: "checking",
      recordedBy: args.recordedBy,
      recordedAt: now,
      markedReceivedBy: null,
      markedReceivedAt: null,
      audit: [buildAuditEntry("recorded", args.recordedBy, now)],
    };
    tx.set(ref, payment as unknown as Record<string, unknown>);
    return { ok: true, payment };
  });
}

/**
 * The team action: "Payment received". Only a `checking` payment of
 * THIS business may transition, and only to `received`. The audit
 * entry naming the team member is appended in the same transaction.
 * This function NEVER confirms/locks/unlocks any order or booking.
 */
export async function markPaymentReceived(args: {
  businessId: string;
  paymentId: string;
  markedByUserId: string;
}): Promise<
  | { ok: true; payment: AdvancePayment }
  | { ok: false; error: "payment_not_found" }
  | { ok: false; error: "already_received" }
> {
  const db = await getDb();
  const ref = db.collection(ADVANCE_PAYMENTS_COLLECTION).doc(args.paymentId);
  const now = new Date().toISOString();
  return db.runTransaction(async (txRaw) => {
    const tx = txRaw as Tx;
    const snap = await tx.get(ref);
    const existing = snap.exists
      ? decodePayment(args.paymentId, snap.data() ?? {})
      : null;
    const decision = decideMarkReceived({
      existing,
      businessId: args.businessId,
    });
    if (!decision.ok) return decision;
    const payment = existing as AdvancePayment;
    const updated: AdvancePayment = {
      ...payment,
      status: "received",
      markedReceivedBy: args.markedByUserId,
      markedReceivedAt: now,
      audit: [
        ...payment.audit,
        buildAuditEntry(
          "marked_received",
          { type: "team", userId: args.markedByUserId },
          now
        ),
      ],
    };
    tx.update(ref, {
      status: "received",
      markedReceivedBy: args.markedByUserId,
      markedReceivedAt: now,
      audit: updated.audit as unknown as Record<string, unknown>,
    });
    return { ok: true, payment: updated };
  });
}

/** Tenant-scoped payment lookup by id (cross-tenant => null). */
export async function getAdvancePayment(
  businessId: string,
  paymentId: string
): Promise<AdvancePayment | null> {
  const db = await getDb();
  const ref = db.collection(ADVANCE_PAYMENTS_COLLECTION).doc(paymentId) as {
    get: () => Promise<{
      exists: boolean;
      data: () => Record<string, unknown> | undefined;
    }>;
  };
  const snap = await ref.get();
  if (!snap.exists) return null;
  const payment = decodePayment(paymentId, snap.data() ?? {});
  if (payment.businessId !== businessId) return null;
  return payment;
}

/**
 * All payments for one order/booking of this business, oldest first
 * (audit order). NOTE: no server-side orderBy on purpose — a where()
 * on businessId combined with orderBy() on recordedAt would need a
 * Firestore composite index that may not exist. Sorting in memory
 * keeps the list working with zero index provisioning.
 */
export async function listPaymentsForRecord(
  businessId: string,
  recordKind: AdvanceRecordKind,
  recordId: string
): Promise<AdvancePayment[]> {
  const db = await getDb();
  const query = db
    .collection(ADVANCE_PAYMENTS_COLLECTION)
    .where("businessId", "==", businessId);
  const snap = await query.get();
  return snap.docs
    .map((d) => decodePayment(d.id, d.data()))
    .filter(
      (p) =>
        p.businessId === businessId &&
        p.recordKind === recordKind &&
        p.recordId === recordId
    )
    .sort((a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""));
}
