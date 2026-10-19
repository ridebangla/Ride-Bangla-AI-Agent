/**
 * bybit.ts — Bybit deposit matcher (Billing Phase 2 auto-verify).
 *
 * Honest stub: until BYBIT_API_KEY / BYBIT_API_SECRET are set,
 * isConfigured() is false and findDeposit() reports "not configured" —
 * claims stay pending and the dashboard says so honestly.
 *
 * ---- PLUG-IN POINT: real matching logic (post key-setup) ----
 *   1. Sign a request to GET /v5/asset/deposit/query-record
 *      (HMAC-SHA256 signature, X-BAPI-API-KEY header, startTime = opts.since).
 *   2. Page through recent deposits.
 *   3. MATCH when a deposit's tag/memo contains opts.refCode AND its amount
 *      converts to opts.amountCents (stablecoins 1:1 USD).
 *   4. Return { found: true, note: `Bybit deposit ${txID} matched` }.
 * Until that is implemented, findDeposit() returns found:false honestly.
 */

import type {
  DepositMatchOptions,
  DepositMatchResult,
  ExchangeAdapter,
} from "./adapter";

export const bybitAdapter: ExchangeAdapter = {
  name: "bybit",

  isConfigured(): boolean {
    return Boolean(process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET);
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
      note: "Bybit deposit-history matching is not implemented yet",
    };
  },
};
