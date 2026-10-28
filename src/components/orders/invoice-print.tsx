"use client";

/**
 * InvoicePrint — LEG E (Presswayy-video round 2): clean print view for
 * one order. NEW FILE (no HEAD file modified).
 *
 * RECORD-ONLY: every value shown comes from buildInvoice() over the
 * order record (items, prices, recorded delivery charge, recorded
 * total, recorded payment method). Nothing is recomputed from model
 * text, nothing is re-priced from the catalog, no fare is quoted, and
 * no delivery charge is invented when the record has none.
 *
 * NO COURIER ACTION: this view contains no courier-booking button,
 * no courier link and no courier state at all. It is a document.
 * Printing uses the browser's print dialog (window.print) with a
 * print stylesheet that shows only this invoice; the dashboard chrome
 * is hidden in print. Print rendering on real devices is
 * LIVE-UNVERIFIED (see LEG-REPORT.md §8) — this is staged code only.
 *
 * All wording here is a PROPOSAL for owner approval (standing
 * no-invented-copy rule). Machine states (not_recorded, totalsMatch
 * false) are rendered as plain explanatory notes, never as invented
 * figures.
 */

import { buildInvoice, formatMoney, type DashboardOrderInput } from "@/lib/order-dashboard";

export interface InvoiceOrderInput extends DashboardOrderInput {
  createdAt?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
}

export default function InvoicePrint({
  order,
  onClose,
}: {
  order: InvoiceOrderInput;
  onClose: () => void;
}) {
  const inv = buildInvoice(order);
  const money = (amount: number | null) =>
    formatMoney(amount, inv.currency) ?? "Not recorded";
  return (
    <div className="invoice-print-wrap rounded-xl border border-rbai-border bg-rbai-surface p-6">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .invoice-print-wrap, .invoice-print-wrap * { visibility: visible !important; }
          .invoice-print-wrap { position: absolute !important; inset: 0 !important; border: none !important; }
          .invoice-no-print { display: none !important; }
        }
      `}</style>
      <div className="invoice-no-print mb-4 flex items-center justify-between gap-2">
        <h3 className="text-base font-medium text-rbai-text">Invoice</h3>
        <div className="flex gap-2">
          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 text-sm rounded-lg bg-rbai-primary text-white"
          >
            Print
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-lg border border-rbai-border text-rbai-text"
          >
            Close
          </button>
        </div>
      </div>

      <div className="space-y-1 text-sm text-rbai-text">
        <div>Order: {order.id.slice(0, 8)}</div>
        {order.createdAt && <div>Date: {order.createdAt}</div>}
        {order.customerName && <div>Customer: {order.customerName}</div>}
        {order.customerPhone && <div>Phone: {order.customerPhone}</div>}
        {order.deliveryAddress && <div>Delivery address: {order.deliveryAddress}</div>}
        {inv.currency === null && (
          <div className="text-rbai-text-light">
            Note: no currency is recorded on this order, so amounts below
            are shown without a currency symbol.
          </div>
        )}
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-rbai-border text-left text-rbai-text-light">
            <th className="py-2 font-medium">Item</th>
            <th className="py-2 font-medium">Qty</th>
            <th className="py-2 font-medium">Price</th>
            <th className="py-2 font-medium text-right">Line total</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-rbai-text-light">
                No items recorded on this order.
              </td>
            </tr>
          )}
          {inv.lines.map((l, i) => (
            <tr key={i} className="border-b border-rbai-border last:border-0">
              <td className="py-2 text-rbai-text">{l.name || "—"}</td>
              <td className="py-2">{l.qty}</td>
              <td className="py-2">{money(l.price)}</td>
              <td className="py-2 text-right">{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-rbai-text-light">Items subtotal</span>
          <span>
            {money(inv.itemsSubtotal)}
            {inv.hasUnpricedLines && " (partial — some items have no recorded price)"}
          </span>
        </div>
        {inv.discount !== null && (
          <div className="flex justify-between">
            <span className="text-rbai-text-light">Discount (recorded)</span>
            <span>−{money(inv.discount)}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-rbai-text-light">Delivery charge</span>
          <span>{inv.deliveryCharge !== null ? money(inv.deliveryCharge) : "Not recorded"}</span>
        </div>
        <div className="flex justify-between border-t border-rbai-border pt-2 font-medium">
          <span>Total (recorded)</span>
          <span>{money(inv.recordedTotal)}</span>
        </div>
        {inv.totalsMatch === false && (
          <div className="text-rbai-text-light">
            Note: the recorded total differs from the sum of the recorded
            lines above. The recorded total is shown as-is; please check
            the order with the team before collecting payment.
          </div>
        )}
        <div className="flex justify-between border-t border-rbai-border pt-2">
          <span className="text-rbai-text-light">Payment method</span>
          <span>
            {inv.codState === "cod"
              ? "Cash on delivery (COD)"
              : inv.codState === "not_cod"
                ? String(inv.paymentMethod)
                : "Not recorded"}
          </span>
        </div>
        {inv.codState === "cod" && (
          <div className="flex justify-between font-medium">
            <span>Cash to collect on delivery (COD)</span>
            <span>{money(inv.codAmount)}</span>
          </div>
        )}
        {inv.codState === "not_recorded" && (
          <div className="text-rbai-text-light">
            Note: no payment method is recorded on this order, so no COD
            amount is shown. Do not collect on the assumption that this
            order is COD.
          </div>
        )}
      </div>
    </div>
  );
}
