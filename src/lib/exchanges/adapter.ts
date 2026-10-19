/**
 * adapter.ts — exchange adapter interface for crypto auto-verify (Billing Phase 2).
 *
 * A claim is "matched" when the exchange's deposit history shows an
 * incoming deposit whose memo/tag CONTAINS the claim's refCode AND whose
 * amount equals the claim's amountCents. The concrete HTTP matching logic
 * is a clearly-marked plug-in point in each exchange file; until exchange
 * API keys are configured, every adapter reports `isConfigured() === false`
 * and the claim stays 'pending' honestly (never auto-rejected).
 */

export type ExchangeName = "binance" | "bybit" | "okx";

export interface DepositMatchOptions {
  /** Server-generated claim reference, e.g. RB-3K7Q9X2A. */
  refCode: string;
  /** Expected amount in integer cents. */
  amountCents: number;
  /** Only consider deposits at/after this time. */
  since: Date;
}

export interface DepositMatchResult {
  found: boolean;
  /** Human-readable note stored on the claim's autoVerify record. */
  note: string;
}

export interface ExchangeAdapter {
  name: ExchangeName;
  /** True only when the API keys for this exchange exist in the environment. */
  isConfigured(): boolean;
  /** Look for a deposit matching refCode + amountCents since `since`. */
  findDeposit(opts: DepositMatchOptions): Promise<DepositMatchResult>;
}
