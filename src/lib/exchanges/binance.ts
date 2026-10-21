/**
 * binance.ts — Binance deposit matcher (payment auto-verify).
 *
 * Real implementation (owner directive 2026-10-21): signed request to
 * GET /sapi/v1/capital/deposit/hisrec (HMAC-SHA256 query signature,
 * X-MBX-APIKEY header) with startTime = opts.since. A deposit matches
 * when its addressTag (the memo) contains the claim refCode, the coin
 * is a USD stablecoin, the amount equals the claim amountCents, and
 * status == 1 (credited). Live calls need BINANCE_API_KEY /
 * BINANCE_API_SECRET in the platform env; until then isConfigured()
 * is false and claims stay pending honestly (never auto-rejected).
 */

import { createHmac } from "crypto";
import type {
  DepositMatchOptions,
  DepositMatchResult,
  ExchangeAdapter,
} from "./adapter";
import { amountToCents, matchDeposits, type NormalizedDeposit } from "./match";

const BASE_URL = "https://api.binance.com";
const PATH = "/sapi/v1/capital/deposit/hisrec";

interface BinanceDepositRow {
  amount?: string;
  coin?: string;
  status?: number;
  addressTag?: string;
  txId?: string;
  insertTime?: number;
}

function normalize(row: BinanceDepositRow): NormalizedDeposit {
  return {
    memo: typeof row.addressTag === "string" ? row.addressTag : "",
    amountCents: amountToCents(row.amount),
    coin: typeof row.coin === "string" ? row.coin : "",
    txId: typeof row.txId === "string" ? row.txId : "",
    // Binance capital deposit status: 1 = credited/success.
    final: row.status === 1,
  };
}

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
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    if (!apiKey || !apiSecret) {
      return { found: false, note: "exchange API not configured" };
    }
    const params = new URLSearchParams({
      startTime: String(opts.since.getTime()),
      recvWindow: "10000",
      timestamp: String(Date.now()),
    });
    const signature = createHmac("sha256", apiSecret)
      .update(params.toString())
      .digest("hex");
    const res = await fetch(`${BASE_URL}${PATH}?${params.toString()}&signature=${signature}`, {
      method: "GET",
      headers: { "X-MBX-APIKEY": apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Binance deposit history failed: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as BinanceDepositRow[];
    if (!Array.isArray(rows)) {
      throw new Error("Binance deposit history returned an unexpected shape");
    }
    return matchDeposits("Binance", rows.map(normalize), opts);
  },
};
