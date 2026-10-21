/**
 * okx.ts — OKX deposit matcher (payment auto-verify).
 *
 * Real implementation (owner directive 2026-10-21): signed request to
 * GET /api/v5/asset/deposit-history (OK-ACCESS-SIGN =
 * base64(HMAC-SHA256(timestamp + method + requestPath)), OK-ACCESS-KEY
 * / OK-ACCESS-PASSPHRASE headers). A deposit matches when its memo
 * contains the claim refCode, the coin is a USD stablecoin, the
 * amount equals the claim amountCents, and state == '2' (deposit
 * successful). Live calls need OKX_API_KEY / OKX_API_SECRET /
 * OKX_API_PASSPHRASE; until then isConfigured() is false and claims
 * stay pending honestly (never auto-rejected).
 */

import { createHmac } from "crypto";
import type {
  DepositMatchOptions,
  DepositMatchResult,
  ExchangeAdapter,
} from "./adapter";
import { amountToCents, matchDeposits, type NormalizedDeposit } from "./match";

const BASE_URL = "https://www.okx.com";
const PATH = "/api/v5/asset/deposit-history";

interface OkxDepositRow {
  amt?: string;
  ccy?: string;
  txId?: string;
  memo?: string;
  state?: string;
}

function normalize(row: OkxDepositRow): NormalizedDeposit {
  return {
    memo: typeof row.memo === "string" ? row.memo : "",
    amountCents: amountToCents(row.amt),
    coin: typeof row.ccy === "string" ? row.ccy : "",
    txId: typeof row.txId === "string" ? row.txId : "",
    // OKX deposit state: '2' = deposit successful. '0'/'1' are still
    // confirming/credited-not-final, '3'/'4' are pending/failed — none
    // of those may activate a subscription.
    final: row.state === "2",
  };
}

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
    const apiKey = process.env.OKX_API_KEY;
    const apiSecret = process.env.OKX_API_SECRET;
    const passphrase = process.env.OKX_API_PASSPHRASE;
    if (!apiKey || !apiSecret || !passphrase) {
      return { found: false, note: "exchange API not configured" };
    }
    const query = new URLSearchParams({
      begin: String(opts.since.getTime()),
      end: String(Date.now()),
      limit: "100",
    }).toString();
    const timestamp = new Date().toISOString();
    const sign = createHmac("sha256", apiSecret)
      .update(`${timestamp}GET${PATH}?${query}`)
      .digest("base64");
    const res = await fetch(`${BASE_URL}${PATH}?${query}`, {
      method: "GET",
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`OKX deposit history failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: OkxDepositRow[];
    };
    if (body.code !== "0") {
      throw new Error(
        `OKX deposit history failed: code ${body.code} ${body.msg ?? ""}`.trim()
      );
    }
    const rows = body.data ?? [];
    return matchDeposits("OKX", rows.map(normalize), opts);
  },
};
