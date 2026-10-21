/**
 * payment-decision.ts — AI verification decision for manual payment
 * claims (owner directive 2026-10-21: the AI verifies payments itself
 * and activates clean subscriptions with NO human touch; uncertain
 * claims wait for a human — never auto-rejected).
 *
 * This module holds the PURE parts of the bank/WeChat decision:
 * the receipt-extraction prompt, the parser for the vision answer,
 * and the check evaluation. The orchestration (vision call, Firestore
 * writes, activation, audit) lives in auto-verify.ts.
 *
 * SERVER-ONLY.
 */

/** The exact instruction given to the vision model for a receipt. */
export const RECEIPT_QUESTION =
  "This image should be a payment receipt or transfer confirmation " +
  "screenshot. Read it exactly as printed and answer with ONLY these " +
  "labeled lines, one per line, writing UNKNOWN when a value is not " +
  "clearly readable:\n" +
  "RECEIPT: YES or NO (NO when the image is not a payment receipt)\n" +
  "AMOUNT: the amount paid, number only (for example 19.00)\n" +
  "CURRENCY: USD, CNY, BDT, EUR, or the currency symbol/name you see\n" +
  "TXN: the transaction / reference / order number exactly as shown\n" +
  "DATE: the payment date and time exactly as shown\n" +
  "RECIPIENT: the name, account name, Pay ID or UID the money was sent TO\n" +
  "NOTE: any note / memo / remark text attached to the payment\n" +
  "Do not guess or invent values.";

export interface ReceiptExtraction {
  isReceipt: boolean;
  /** Parsed amount in integer cents, or null when unreadable. */
  amountCents: number | null;
  /** Currency token as read ("USD", "CNY", "$", "¥", ...), or null. */
  currency: string | null;
  /** Transaction / reference / order number as read, or null. */
  txnId: string | null;
  /** Payment date as read (raw text), or null. */
  dateText: string | null;
  /** Parsed payment date, or null when the text does not parse. */
  date: Date | null;
  /** Recipient name / Pay ID / UID as read, or null. */
  recipient: string | null;
  /** Note / memo / remark text as read, or null. */
  noteText: string | null;
  /** Full raw vision answer (refCode search + evidence). */
  raw: string;
}

function field(text: string, label: string): string | null {
  // LAST match wins (attack-test 2026-10-21): a screenshot can carry
  // printed text that a vision model transcribes BEFORE its own answer
  // block; the model's own labeled answer is the final block, so an
  // injected first block must never be the one parsed.
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "gim");
  let v: string | null = null;
  for (const m of text.matchAll(re)) {
    const candidate = m[1].trim();
    if (candidate) v = candidate;
  }
  if (!v || /^unknown$/i.test(v)) return null;
  return v;
}

/**
 * Parse a receipt amount into integer cents — EXACTLY (attack-test
 * 2026-10-21). A negative amount (refund / reversal receipts show one)
 * is never a payment, and sub-cent precision (18.995) must not round
 * UP into an exact match: fraction digits beyond cents are accepted
 * only when they are all zeros ("19.00000000").
 */
export function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$€£¥₹৳,\s]/g, "");
  if (!cleaned || cleaned.includes("-")) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > 2 && !/^0*$/.test(frac.slice(2))) return null;
  const cents =
    Number(m[1]) * 100 + Number((frac + "00").slice(0, 2) || "0");
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Parse the labeled vision answer into structured receipt fields. */
export function parseReceiptExtraction(text: string): ReceiptExtraction {
  const receiptLine = field(text, "RECEIPT");
  // Only an explicit YES counts (attack-test 2026-10-21): a missing or
  // UNKNOWN RECEIPT line used to default to "is a receipt", skipping
  // the only receipt-ness gate for non-receipt images / failed reads.
  const isReceipt = receiptLine ? /^yes$/i.test(receiptLine.trim()) : false;
  const amountRaw = field(text, "AMOUNT");
  const amountCents = amountRaw ? parseAmountToCents(amountRaw) : null;
  const dateText = field(text, "DATE");
  let date: Date | null = null;
  if (dateText) {
    const parsed = new Date(dateText);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  return {
    isReceipt,
    amountCents,
    currency: field(text, "CURRENCY"),
    txnId: field(text, "TXN"),
    dateText,
    date,
    recipient: field(text, "RECIPIENT"),
    noteText: field(text, "NOTE"),
    raw: text,
  };
}

const NON_USD_CURRENCIES =
  /^(cny|rmb|cnh|bdt|taka|eur|gbp|inr|pkr|aed|sar|¥|￥|元|৳|€|£|₹|₨)$/i;

export function isUsdCurrency(token: string | null): boolean {
  if (!token) return false;
  return /^(usd|us\$|\$|dollar|dollars)$/i.test(token.trim());
}

export function isExplicitNonUsdCurrency(token: string | null): boolean {
  if (!token) return false;
  return NON_USD_CURRENCIES.test(token.trim());
}

/** Normalize a txn/reference string for comparison. */
export function normalizeTxn(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export interface DecisionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReceiptDecisionInput {
  /** The claim's server-computed amount (the price of record). */
  claimAmountCents: number;
  /** The txnId the customer typed on the claim. */
  claimTxnId: string;
  /** The claim's unique reference code. */
  refCode: string;
  /** When the claim was created (payment must not postdate it by much). */
  claimCreatedAt: Date | null;
  /** Vision extraction, or null when vision was unavailable. */
  extraction: ReceiptExtraction | null;
  /** Why vision was unavailable (recorded as evidence), if it was. */
  visionUnavailableReason?: string;
  /** Recipient the business configured for this method (bank account
   *  name / Pay ID), or null when none is configured. */
  expectedRecipient: string | null;
  /** True when ANOTHER approved claim already used this txnId. */
  txnAlreadyApprovedElsewhere: boolean;
  now?: Date;
}

export interface ReceiptDecision {
  outcome: "auto_approve" | "human_review";
  checks: DecisionCheck[];
}

/**
 * Evaluate every check for a bank/WeChat claim. Auto-approve requires
 * EVERY check to pass — one failure routes the claim to a human with
 * the evidence attached (the claim itself is never rejected here).
 */
export function evaluateReceiptChecks(
  input: ReceiptDecisionInput
): ReceiptDecision {
  const checks: DecisionCheck[] = [];
  const now = input.now ?? new Date();
  const ex = input.extraction;

  checks.push({
    name: "txn_unique",
    ok: !input.txnAlreadyApprovedElsewhere,
    detail: input.txnAlreadyApprovedElsewhere
      ? "This transaction ID already funded another approved claim — blocked from auto-activation."
      : "No other approved claim uses this transaction ID.",
  });

  if (!ex) {
    checks.push({
      name: "vision_available",
      ok: false,
      detail:
        input.visionUnavailableReason ??
        "The payment screenshot could not be read by AI.",
    });
    return { outcome: "human_review", checks };
  }
  checks.push({
    name: "vision_available",
    ok: true,
    detail: "Payment screenshot read by AI.",
  });

  checks.push({
    name: "is_receipt",
    ok: ex.isReceipt,
    detail: ex.isReceipt
      ? "The screenshot is a payment receipt."
      : "The screenshot does not look like a payment receipt.",
  });

  checks.push({
    name: "amount_exact",
    ok: ex.amountCents !== null && ex.amountCents === input.claimAmountCents,
    detail:
      ex.amountCents === null
        ? "No amount could be read from the screenshot."
        : ex.amountCents === input.claimAmountCents
          ? `Screenshot amount matches the expected $${(input.claimAmountCents / 100).toFixed(2)}.`
          : `Screenshot amount $${(ex.amountCents / 100).toFixed(2)} does not match the expected $${(input.claimAmountCents / 100).toFixed(2)}.`,
  });

  const nonUsd = isExplicitNonUsdCurrency(ex.currency);
  checks.push({
    name: "currency_ok",
    ok: !nonUsd,
    detail: nonUsd
      ? `Screenshot currency reads ${ex.currency}, not USD — a human must confirm the conversion.`
      : isUsdCurrency(ex.currency)
        ? "Screenshot currency is USD."
        : "Currency not clearly readable; amount match carries the decision.",
  });

  const txnMatch =
    ex.txnId !== null &&
    normalizeTxn(ex.txnId) === normalizeTxn(input.claimTxnId) &&
    normalizeTxn(input.claimTxnId).length >= 6;
  // An empty/short refCode must never satisfy this check vacuously
  // (attack-test 2026-10-21): every string "contains" an empty refCode,
  // which let legacy claims without a refCode auto-approve on a wrong
  // transaction id.
  const refNeedle = input.refCode.trim().toUpperCase();
  const refVisible =
    refNeedle.length >= 6 &&
    (ex.raw.toUpperCase().includes(refNeedle) ||
      (ex.noteText !== null &&
        ex.noteText.toUpperCase().includes(refNeedle)));
  checks.push({
    name: "txn_or_ref_match",
    ok: txnMatch || refVisible,
    detail: txnMatch
      ? "Screenshot transaction number matches the claimed transaction ID."
      : refVisible
        ? `Screenshot shows the claim reference ${input.refCode}.`
        : "Neither the claimed transaction ID nor the claim reference could be found on the screenshot.",
  });

  let dateOk = false;
  let dateDetail = "No readable payment date on the screenshot.";
  if (ex.date) {
    const created = input.claimCreatedAt ?? now;
    const earliest = new Date(created.getTime() - 30 * 24 * 60 * 60 * 1000);
    const latest = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    dateOk = ex.date >= earliest && ex.date <= latest;
    dateDetail = dateOk
      ? `Payment date ${ex.dateText} is within the expected window.`
      : `Payment date ${ex.dateText} is outside the expected window (too old or in the future).`;
  }
  checks.push({ name: "date_sane", ok: dateOk, detail: dateDetail });

  if (input.expectedRecipient) {
    const expected = input.expectedRecipient.toLowerCase();
    const seen = (ex.recipient ?? "").toLowerCase();
    const recipientOk =
      seen.length >= 3 &&
      (seen.includes(expected) || expected.includes(seen));
    checks.push({
      name: "recipient_match",
      ok: recipientOk,
      detail: recipientOk
        ? "Screenshot recipient matches the configured payment account."
        : "Screenshot recipient does not clearly match the configured payment account.",
    });
  } else {
    checks.push({
      name: "recipient_match",
      ok: true,
      detail: "No recipient is configured for this method — check skipped.",
    });
  }

  const outcome = checks.every((c) => c.ok) ? "auto_approve" : "human_review";
  return { outcome, checks };
}
