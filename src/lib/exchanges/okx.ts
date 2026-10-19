/**
 * okx.ts — OKX deposit matcher (Billing Phase 2 auto-verify).
 *
 * Honest stub: until OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE are
 * set, isConfigured() is false and findDeposit() reports "not configured" —
 * claims stay pending and the dashboard says so honestly.
 *
 * ---- PLUG-IN POINT: real matching logic (post key-setup) ----
 *   1. Sign a request to GET /api/v5/asset/deposit-history
 *      (OK-ACCESS-SIGN = base64(HMAC-SHA256(timestamp + method + path)),
 *      OK-ACCESS-KEY / OK-ACCESS-PASSPHRASE headers, after = opts.since).
 *   2. Page through recent deposits.
 *   3. MATCH when a deposit's tag/memo contains opts.refCode AND its amount
 *      converts to opts.amountCents (stablecoins 1:1 USD).
 *   4. Return { found: true, note: `OKX deposit ${txId} matched` }.
 * Until that is implemented, findDeposit() returns found:false honestly.
 */

import type {
  DepositMatchOptions,
  DepositMatchResult,
  ExchangeAdapter,
} from "./adapter";

export const okxAdapter: ExchangeAdapter = {
  name: "okx",

  isConfigured(): boolean {
    return Boolean(
      process.env.OKX_API_KEY &&
        process.env.OKX_API_SECRET &&
        process.env.OKX_API_PASSPHRASE
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
      note: "OKX deposit-history matching is not implemented yet",
    };
  },
};
