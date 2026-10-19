/**
 * binance.ts — Binance Pay deposit matcher (Billing Phase 2 auto-verify).
 *
 * Honest stub: until BINANCE_API_KEY / BINANCE_API_SECRET are set,
 * isConfigured() is false and findDeposit() reports "not configured" —
 * claims stay pending and the dashboard says so honestly.
 *
 * ---- PLUG-IN POINT: real matching logic (post key-setup) ----
 *   1. Sign a request to GET /sapi/v1/capital/deposit/hisrec
 *      (HMAC-SHA256 with BINANCE_API_SECRET, X-MBX-APIKEY header).
 *   2. Page through recent deposits (startTime = opts.since).
 *   3. MATCH when a deposit's memo/tag/note contains opts.refCode AND
 *      its amount converts to opts.amountCents (stablecoin deposits are
 *      1:1 USD; convert other assets via the ticker price at deposit time).
 *   4. Return { found: true, note: `Binance deposit ${txId} matched` }.
 * Until that is implemented, findDeposit() returns found:false honestly.
 */

import type {
  DepositMatchOptions,
  DepositMatchResult,
  ExchangeAdapter,
} from "./adapter";

export const binanceAdapter: ExchangeAdapter = {
  name: "binance",

  isConfigured(): boolean {
    return Boolean(
      process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET
    );
  },

  async findDeposit(
    opts: DepositMatchOptions
  ): Promise<DepositMatchResult> {
    if (!this.isConfigured()) {
      return { found: false, note: "exchange API not configured" };
    }
    // ---- PLUG-IN POINT (see file header) ----
    void opts;
    return {
      found: false,
      note: "Binance deposit-history matching is not implemented yet",
    };
  },
};
