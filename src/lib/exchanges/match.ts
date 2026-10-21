/**
 * match.ts — shared deposit-matching for the exchange adapters
 * (payment auto-verify, owner directive 2026-10-21).
 *
 * A deposit MATCHES a claim when ALL of these hold:
 *   - the deposit is FINAL on the exchange (adapter-normalized), and
 *   - its memo / tag / note CONTAINS the claim's refCode, and
 *   - its coin is a USD stablecoin (1:1 with USD — no price conversion
 *     is ever guessed), and
 *   - its amount, in integer cents, equals the claim's amountCents
 *     exactly.
 * Anything else is "no match" — the claim stays pending for a human
 * (never auto-rejected). False negatives are safe by design; a false
 * positive would activate a subscription on someone else's money.
 */

import type { DepositMatchOptions, DepositMatchResult } from "./adapter";

/** Coins treated as exactly 1:1 with USD for auto-matching. */
export const USD_STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "BUSD",
  "TUSD",
]);

export interface NormalizedDeposit {
  /** Memo / tag / note attached to the deposit ("" when none). */
  memo: string;
  /** Deposit amount converted to integer USD cents, or null when the
   *  raw amount cannot be parsed safely. */
  amountCents: number | null;
  /** Asset code as reported by the exchange (e.g. "USDT"). */
  coin: string;
  /** Exchange transaction id (evidence only — never logged in full
   *  beyond the claim's own decision record). */
  txId: string;
  /** True only when the exchange reports the deposit as completed. */
  final: boolean;
}

/** Parse a decimal amount string ("19.00000000") to integer cents. */
export function amountToCents(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  }
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const value = Number(clean);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function matchDeposits(
  exchangeLabel: string,
  deposits: NormalizedDeposit[],
  opts: DepositMatchOptions
): DepositMatchResult {
  let sawRef = false;
  for (const d of deposits) {
    if (!d.memo || !d.memo.includes(opts.refCode)) continue;
    sawRef = true;
    if (!d.final) continue;
    if (!USD_STABLECOINS.has(d.coin.toUpperCase())) continue;
    if (d.amountCents === null || d.amountCents !== opts.amountCents) {
      continue;
    }
    return {
      found: true,
      note: `${exchangeLabel} deposit ${d.txId} matched refCode ${opts.refCode} + amount $${(opts.amountCents / 100).toFixed(2)}`,
    };
  }
  return {
    found: false,
    note: sawRef
      ? `${exchangeLabel}: a deposit mentions ${opts.refCode} but is not final, not a USD stablecoin, or the amount differs — left for human review`
      : `${exchangeLabel}: no deposit mentioning ${opts.refCode} since ${opts.since.toISOString()}`,
  };
}
