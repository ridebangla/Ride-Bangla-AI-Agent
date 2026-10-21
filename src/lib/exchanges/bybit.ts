/**
 * bybit.ts — Bybit deposit matcher (payment auto-verify).
 *
 * Real implementation (owner directive 2026-10-21): signed request to
 * GET /v5/asset/deposit/query-record (X-BAPI-* HMAC-SHA256 headers).
 * A deposit matches when its tag (the memo) contains the claim
 * refCode, the coin is a USD stablecoin, the amount equals the claim
 * amountCents, and the deposit status reports success. Live calls
 * need BYBIT_API_KEY / BYBIT_API_SECRET; until then isConfigured()
 * is false and claims stay pending honestly (never auto-rejected).
 */

import { createHmac } from "crypto";
import type {
  DepositMatchOptions,
  DepositMatchResult,
  ExchangeAdapter,
} from "./adapter";
import { amountToCents, matchDeposits, type NormalizedDeposit } from "./match";

const BASE_URL = "https://api.bybit.com";
const PATH = "/v5/asset/deposit/query-record";
const RECV_WINDOW = "5000";

interface BybitDepositRow {
  coin?: string;
  amount?: string;
  txID?: string;
  tag?: string;
  status?: number | string;
}

function normalize(row: BybitDepositRow): NormalizedDeposit {
  const status = String(row.status ?? "");
  return {
    memo: typeof row.tag === "string" ? row.tag : "",
    amountCents: amountToCents(row.amount),
    coin: typeof row.coin === "string" ? row.coin : "",
    txId: typeof row.txID === "string" ? row.txID : "",
    // Bybit v5 deposit record status: 2 = success. Anything else
    // (0/1 processing, 3 failed, unknown) is NOT final — the sweep
    // will look again later; the claim stays pending meanwhile.
    final: status === "2" || /^success$/i.test(status),
  };
}

export const bybitAdapter: ExchangeAdapter = {
  name: "bybit",

  isConfigured(): boolean {
    return Boolean(process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET);
  },

  async findDeposit(
    opts: DepositMatchOptions
  ): Promise<DepositMatchResult> {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      return { found: false, note: "exchange API not configured" };
    }
    const query = new URLSearchParams({
      startTime: String(opts.since.getTime()),
      endTime: String(Date.now()),
      limit: "50",
    }).toString();
    const timestamp = String(Date.now());
    const sign = createHmac("sha256", apiSecret)
      .update(timestamp + apiKey + RECV_WINDOW + query)
      .digest("hex");
    const res = await fetch(`${BASE_URL}${PATH}?${query}`, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Bybit deposit records failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      retCode?: number;
      retMsg?: string;
      result?: { rows?: BybitDepositRow[] };
    };
    if (body.retCode !== 0) {
      throw new Error(
        `Bybit deposit records failed: retCode ${body.retCode} ${body.retMsg ?? ""}`.trim()
      );
    }
    const rows = body.result?.rows ?? [];
    return matchDeposits("Bybit", rows.map(normalize), opts);
  },
};
