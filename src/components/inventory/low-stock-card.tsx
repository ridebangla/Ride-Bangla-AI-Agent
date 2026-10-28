"use client";

/**
 * LEG E (inventory batch, STAGED ONLY) — dashboard low-stock card.
 *
 * Client component mounted on the dashboard page (LE-06 diff). It
 * fetches GET /api/inventory/alerts and renders ONLY what the API
 * returns: counts, the attention list (out-of-stock first, then
 * low-stock), and the not-tracked count. It invents no stock, no
 * rate, and no threshold.
 *
 * Honest states:
 * - 503 stock_store_not_configured → "Stock tracking is not connected
 *   yet" (the Leg A store is pending; no numbers are shown).
 * - daysToStockout null → "Not enough sales data" (never a guessed
 *   number, never a hidden fallback).
 * - unknown count → "Not tracked" (products with no stock record are
 *   never shown as healthy).
 *
 * All user-facing wording in this component is PROPOSAL for owner
 * approval before launch (see LEG-REPORT.md §6, D4). No proactive
 * notification is wired here: in-dashboard display is the alert
 * surface; any banner/message/push channel is an owner decision
 * (D5) and is NOT built in this leg.
 */
import { useEffect, useState } from "react";

interface AlertItem {
  productId: string;
  productName: string;
  variantLabel: string | null;
  displayName: string;
  status: string;
  quantity: number | null;
  threshold: number | null;
  daysToStockout: number | null;
  reason: string | null;
}

interface AlertSummary {
  counts: {
    healthy: number;
    low: number;
    outOfStock: number;
    unknown: number;
    tracked: number;
    total: number;
  };
  attention: AlertItem[];
  unknownItems: AlertItem[];
  windowDays: number;
}

export function LowStockCard() {
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/inventory/alerts")
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 503) {
          setNotConfigured(true);
          return;
        }
        if (!res.ok) {
          setFailed(true);
          return;
        }
        setSummary((await res.json()) as AlertSummary);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="bg-rbai-surface rounded-xl border border-rbai-border">
      <div className="px-5 py-4 border-b border-rbai-border">
        <h3 className="font-semibold text-rbai-text">Stock alerts</h3>
      </div>
      <div className="p-5 space-y-4">
        {notConfigured ? (
          <p className="text-sm text-rbai-text-light">
            Stock tracking is not connected yet for this business.
          </p>
        ) : failed ? (
          <p className="text-sm text-rbai-text-light">
            Stock alerts could not be loaded.
          </p>
        ) : !summary ? (
          <p className="text-sm text-rbai-text-light">Loading stock alerts…</p>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <p className="text-lg font-semibold">{summary.counts.healthy}</p>
                <p className="text-xs text-rbai-text-light">Healthy</p>
              </div>
              <div>
                <p className="text-lg font-semibold">{summary.counts.low}</p>
                <p className="text-xs text-rbai-text-light">Low</p>
              </div>
              <div>
                <p className="text-lg font-semibold">{summary.counts.outOfStock}</p>
                <p className="text-xs text-rbai-text-light">Out of stock</p>
              </div>
              <div>
                <p className="text-lg font-semibold">{summary.counts.unknown}</p>
                <p className="text-xs text-rbai-text-light">Not tracked</p>
              </div>
            </div>
            {summary.attention.length === 0 ? (
              <p className="text-sm text-rbai-text-light">
                No products need attention right now.
              </p>
            ) : (
              <ul className="divide-y divide-rbai-border">
                {summary.attention.map((item) => (
                  <li
                    key={`${item.productId}-${item.variantLabel ?? ""}`}
                    className="py-2 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {item.displayName}
                      </p>
                      <p className="text-xs text-rbai-text-light">
                        {item.status === "out_of_stock"
                          ? "Out of stock"
                          : `Low — ${item.quantity} left (alert at ${item.threshold})`}
                      </p>
                    </div>
                    <span className="text-xs text-rbai-text-light flex-shrink-0">
                      {item.daysToStockout === null
                        ? item.status === "out_of_stock"
                          ? "Out now"
                          : "Not enough sales data"
                        : item.daysToStockout === 0
                          ? "Out now"
                          : `~${item.daysToStockout} days left`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {summary.unknownItems.length > 0 && (
              <p className="text-xs text-rbai-text-light">
                {summary.unknownItems.length} product
                {summary.unknownItems.length === 1 ? "" : "s"} not tracked yet
                — add a stock record to include{" "}
                {summary.unknownItems.length === 1 ? "it" : "them"} in alerts.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
