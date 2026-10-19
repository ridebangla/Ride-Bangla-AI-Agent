/**
 * exchanges/index.ts — adapter lookup for auto-verify.
 *
 * Maps a manual payment method id to its exchange adapter (crypto methods
 * only). Non-crypto methods (us_bank, wechat_pay) have no adapter and are
 * never auto-verified — they stay on the human verification path.
 */

import type { ExchangeAdapter, ExchangeName } from "./adapter";
import { binanceAdapter } from "./binance";
import { bybitAdapter } from "./bybit";
import { okxAdapter } from "./okx";
import type { ManualMethodId } from "../manual-payments";

export type { ExchangeAdapter, ExchangeName };
export { binanceAdapter, bybitAdapter, okxAdapter };

const ADAPTERS: Record<ExchangeName, ExchangeAdapter> = {
  binance: binanceAdapter,
  bybit: bybitAdapter,
  okx: okxAdapter,
};

/** The exchange adapter for a payment method, or null for non-crypto methods. */
export function getAdapterForMethod(
  method: ManualMethodId
): ExchangeAdapter | null {
  if (method === "binance" || method === "bybit" || method === "okx") {
    return ADAPTERS[method];
  }
  return null;
}
