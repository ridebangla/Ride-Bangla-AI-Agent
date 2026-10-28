/**
 * order-dashboard.ts — LEG E (Presswayy-video round 2): orders dashboard
 * pure logic. NO imports, NO Firestore, NO network, NO currency conversion.
 *
 * WHAT THIS MODULE DOES (and only this):
 *  - resolves an order's channel from RECORDED sources only;
 *  - filters orders by channel;
 *  - computes live counters from REAL orders only (empty input => zeros);
 *  - builds an invoice view from the ORDER RECORD only.
 *
 * HEAD FACTS THIS MODULE IS BUILT ON (AI repo, HEAD 706df0fd, verified
 * 2026-10-25 by this leg; see LEG-REPORT.md §1):
 *  - Order status vocabulary at HEAD is exactly
 *    "pending" | "confirmed" | "cancelled". There is NO "completed" and NO
 *    "in-progress" status, and NO "delivered" order status.
 *  - The Order record at HEAD has NO channel field, NO currency field, NO
 *    deliveryCharge field and NO paymentMethod/COD field. Those fields are
 *    read here ONLY when present (a later writer may stamp them; see the
 *    field spec in LEG-REPORT.md §5). Absence is never filled by guessing.
 *  - The only recorded source of channel at HEAD is the linked
 *    conversation's `channel` (order.conversationId -> conversation.channel).
 *    Evidenced values: "messenger" (Facebook Page messages), "instagram"
 *    (IG DMs), "widget" (website widget), "whatsapp", "email", "sms",
 *    "telegram", "phone", "api", "web". There is NO Shopify and NO
 *    WooCommerce channel/source anywhere in HEAD code (Leg B, prior batch,
 *    verified the same: 0 hits), so those two filters are honestly empty
 *    until a store integration records them — they are never back-filled.
 *  - Delivery charge at HEAD: NO tenant delivery-charge configuration
 *    exists (Business has only courierDeliveryEnabled/partnerId) and the
 *    only delivery figure in code is a hardcoded 0 in the courier bridge's
 *    ops doc. The invoice therefore shows a delivery charge ONLY when the
 *    order record itself carries one (e.g. the Presswayy Leg H coupon
 *    transaction's `deliveryCharge` / `priceBreakdown`, a staged — not HEAD
 *    — writer). Otherwise it says "not recorded", never a quoted figure.
 *    This module never quotes a fare and never invents a charge.
 *
 * COUNTER DEFINITIONS (stated here so no reader has to guess):
 *  - total: every order in the input, any status.
 *  - pending: status === "pending".
 *  - confirmed: status === "confirmed" (kept as a decomposition line so
 *    the two counters below always add up to it).
 *  - cancelled: status === "cancelled".
 *  - completed: status === "confirmed" AND the courier delivery phase is
 *    exactly "delivered" (Leg C tracking phases). A confirmed order is
 *    NOT "completed" merely because it was confirmed.
 *  - inProgress: status === "confirmed" AND the delivery phase is anything
 *    other than "delivered" — including NO phase at all. Rationale, stated
 *    plainly: fulfilment is underway but delivery is unproven. This is
 *    deliberately conservative for own-delivery orders, which have no
 *    rider phase at all (Leg C: own-delivery "delivered: unknown"), so
 *    they stay in-progress until a "mark delivered" action exists
 *    (open owner decision, also flagged by booking Leg I). Unknown
 *    statuses are counted in `total` only, never forced into a bucket.
 *  - sales: sums `order.total` ONLY. Unpriced orders (total null) and
 *    invalid totals (non-finite, negative) are excluded from the sum and
 *    counted separately (unpricedCount / invalidTotalCount). Sales are
 *    grouped BY CURRENCY and NEVER summed across currencies and NEVER
 *    converted: `salesByCurrency` is a per-currency list. `totalSales`
 *    is a single figure when there are 0 buckets (0 — the empty state)
 *    or exactly 1 bucket (that bucket's total, including the
 *    "currency not recorded" bucket); with two or more currency buckets
 *    it is null and the UI must show the breakdown, never a single
 *    merged figure.
 *  - Currency representation: the recorded currency value is shown
 *    verbatim (e.g. "BDT", "USD" if that is what is recorded). No symbol
 *    is invented and no symbol is mapped from a code. When no currency
 *    is recorded the bucket key is null and the UI must show the amount
 *    with NO currency symbol and a "currency not recorded" note.
 *
 * CHANNEL DEFINITIONS:
 *  - The dashboard filter offers exactly: all, facebook, instagram,
 *    whatsapp, shopify, woocommerce, website, other, unknown.
 *  - Mapping from a RECORDED channel string (order.channel when present,
 *    else the linked conversation's channel):
 *      "messenger" | "facebook"        -> facebook
 *      "instagram"                     -> instagram
 *      "whatsapp"                      -> whatsapp
 *      "shopify"                       -> shopify
 *      "woocommerce"                   -> woocommerce
 *      "widget" | "web" | "website"   -> website
 *      any other non-empty value       -> other (raw value preserved)
 *      missing / empty                 -> unknown
 *  - Nothing else is mapped. In particular "api", "email", "sms",
 *    "telegram" and "phone" are NOT relabelled as website or as any
 *    store channel; they land in "other", honestly, with their raw
 *    value visible. A hand-entered order with no conversation lands in
 *    "unknown", never in a guessed channel.
 *
 * INVOICE RULES (record-only, enforced by buildInvoice):
 *  - Items, prices and quantities come from the order record's `items`
 *    only. No model text, no catalog re-price, no recomputation from
 *    conversation text. (Catalog-wins repricing, if the owner wants it
 *    fleet-wide, belongs to the order-power / Leg H reconciliation —
 *    this module does NOT reprice anything.)
 *  - The invoice total is the order record's `total`. A computed check
 *    (items subtotal - discount + delivery charge) is shown ONLY as a
 *    check: when every component is present and the check differs from
 *    the recorded total, `totalsMatch` is false and the recorded total
 *    still wins — the difference is flagged, never silently "fixed".
 *  - Delivery charge: order.deliveryCharge, else priceBreakdown's
 *    delivery charge, else null ("not recorded"). The hardcoded courier
 *    ops-doc 0 is NEVER used as an invoice delivery charge.
 *  - Discount: priceBreakdown/couponDiscount when present, else null.
 *    No discount is ever invented from a code, a chat message or a
 *    promotion.
 *  - COD: `codState` is "cod" ONLY when the order record's paymentMethod
 *    is exactly "cod" (case-insensitive, trimmed). Any other recorded
 *    method => "not_cod". No recorded method => "not_recorded" and the
 *    COD amount is null. The dashboard must NEVER print "collect this
 *    amount on delivery" for a not_recorded order.
 *  - The invoice contains NO courier-booking action, NO courier-booking
 *    button and NO courier state. It is a document, not a booking action.
 *    (Third-party courier booking is excluded by the task; the platform
 *    courier doctrine — own riders with Partner ID + served-area gating —
 *    lives in the courier bridge, not in the invoice.)
 *
 * All user-facing wording produced by consumers of this module is a
 * PROPOSAL for owner approval (standing no-invented-copy rule). This
 * module itself returns machine values and short machine notes only.
 */

export type OrderStatus = "pending" | "confirmed" | "cancelled";

export type DashboardChannel =
  | "facebook"
  | "instagram"
  | "whatsapp"
  | "shopify"
  | "woocommerce"
  | "website"
  | "other"
  | "unknown";

export type ChannelFilter = "all" | DashboardChannel;

export const CHANNEL_FILTERS: ChannelFilter[] = [
  "all",
  "facebook",
  "instagram",
  "whatsapp",
  "shopify",
  "woocommerce",
  "website",
  "other",
  "unknown",
];

/** Minimal order shape this module reads. Extra record fields are ignored. */
export interface DashboardOrderInput {
  id: string;
  status: string;
  total?: number | null;
  /** Spec'd field (LEG-REPORT.md §5); absent at HEAD. */
  currency?: string | null;
  /** Spec'd field (LEG-REPORT.md §5); absent at HEAD. */
  channel?: string | null;
  /** Recorded source at HEAD: linked conversation.channel. */
  conversationChannel?: string | null;
  items?: Array<{
    name?: unknown;
    qty?: unknown;
    price?: unknown;
    productId?: unknown;
  }> | null;
  /** Present only on coupon-path orders (staged Leg H writer), else absent. */
  deliveryCharge?: number | null;
  /** Present only on coupon-path orders (staged Leg H writer), else absent. */
  priceBreakdown?: {
    deliveryCharge?: number | null;
    couponDiscount?: number | null;
    productTotal?: number | null;
    finalTotal?: number | null;
    lines?: Array<{ kind?: unknown; amount?: unknown }> | null;
  } | null;
  /** Spec'd field (LEG-REPORT.md §5); absent at HEAD. */
  paymentMethod?: string | null;
  /** Spec'd field (LEG-REPORT.md §5); absent at HEAD. */
  couponDiscount?: number | null;
  /** Courier delivery phase (Leg C tracking); absent => unproven. */
  courierDeliveryPhase?: string | null;
  courierDelivery?: { phase?: unknown } | null;
}

/** Round to cents the way orders.ts computeTotal does. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function cleanChannel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v ? v : null;
}

// ---------------------------------------------------------------------------
// Channel resolution + filter
// ---------------------------------------------------------------------------

export interface ResolvedChannel {
  channel: DashboardChannel;
  /** The recorded string that produced the mapping, or null. */
  rawChannel: string | null;
  /** Where the recorded value came from. */
  source: "order" | "conversation" | "none";
}

export function normalizeChannel(raw: unknown): DashboardChannel {
  const v = cleanChannel(raw);
  if (v === null) return "unknown";
  switch (v) {
    case "messenger":
    case "facebook":
      return "facebook";
    case "instagram":
      return "instagram";
    case "whatsapp":
      return "whatsapp";
    case "shopify":
      return "shopify";
    case "woocommerce":
      return "woocommerce";
    case "widget":
    case "web":
    case "website":
      return "website";
    default:
      return "other";
  }
}

export function resolveChannel(order: DashboardOrderInput): ResolvedChannel {
  const fromOrder = cleanChannel(order.channel);
  if (fromOrder !== null) {
    return {
      channel: normalizeChannel(fromOrder),
      rawChannel: fromOrder,
      source: "order",
    };
  }
  const fromConversation = cleanChannel(order.conversationChannel);
  if (fromConversation !== null) {
    return {
      channel: normalizeChannel(fromConversation),
      rawChannel: fromConversation,
      source: "conversation",
    };
  }
  return { channel: "unknown", rawChannel: null, source: "none" };
}

export function filterOrdersByChannel<T extends DashboardOrderInput>(
  orders: T[],
  filter: ChannelFilter,
): T[] {
  if (filter === "all") return [...orders];
  return orders.filter((o) => resolveChannel(o).channel === filter);
}

export function countByChannel(
  orders: DashboardOrderInput[],
): Record<DashboardChannel, number> {
  const counts: Record<DashboardChannel, number> = {
    facebook: 0,
    instagram: 0,
    whatsapp: 0,
    shopify: 0,
    woocommerce: 0,
    website: 0,
    other: 0,
    unknown: 0,
  };
  for (const o of orders) counts[resolveChannel(o).channel] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Counters + sales (real orders only; empty input => zeros, never placeholders)
// ---------------------------------------------------------------------------

export interface SalesBucket {
  /** Recorded currency verbatim, or null when the order records none. */
  currency: string | null;
  total: number;
  orderCount: number;
}

export interface OrderCounters {
  total: number;
  pending: number;
  confirmed: number;
  cancelled: number;
  /** Confirmed + delivery phase exactly "delivered". */
  completed: number;
  /** Confirmed + delivery phase anything else (incl. no phase). */
  inProgress: number;
  /** Orders whose status is none of pending/confirmed/cancelled. */
  unknownStatus: number;
  /** Priced orders grouped by currency; never merged across currencies. */
  salesByCurrency: SalesBucket[];
  /**
   * Single sales figure when there are 0 or 1 currency buckets (0 with
   * no priced orders at all — the honest empty-state figure, not a
   * placeholder). Null with 2+ buckets: the UI must show the
   * per-currency breakdown instead of a merged total.
   */
  totalSales: number | null;
  /** The single bucket's currency when totalSales is set, else null. */
  totalSalesCurrency: string | null;
  /** Orders with total === null (excluded from every sales sum). */
  unpricedCount: number;
  /** Orders with a non-finite or negative total (excluded, flagged). */
  invalidTotalCount: number;
}

function courierPhase(order: DashboardOrderInput): string | null {
  const direct = cleanChannel(order.courierDeliveryPhase);
  if (direct !== null) return direct;
  if (order.courierDelivery && typeof order.courierDelivery === "object") {
    return cleanChannel(order.courierDelivery.phase);
  }
  return null;
}

export function computeCounters(
  orders: DashboardOrderInput[],
): OrderCounters {
  let pending = 0;
  let confirmed = 0;
  let cancelled = 0;
  let completed = 0;
  let inProgress = 0;
  let unknownStatus = 0;
  let unpricedCount = 0;
  let invalidTotalCount = 0;
  const buckets = new Map<string, SalesBucket>();
  // Null-currency bucket key: a string that cannot collide with a real
  // currency code, kept internal; the bucket's `currency` stays null.
  const NULL_KEY = "\0no-currency-recorded";

  for (const o of orders) {
    switch (o.status) {
      case "pending":
        pending += 1;
        break;
      case "confirmed": {
        confirmed += 1;
        if (courierPhase(o) === "delivered") completed += 1;
        else inProgress += 1;
        break;
      }
      case "cancelled":
        cancelled += 1;
        break;
      default:
        unknownStatus += 1;
        break;
    }

    if (o.total === null || o.total === undefined) {
      unpricedCount += 1;
    } else if (!isFiniteNonNegative(o.total)) {
      invalidTotalCount += 1;
    } else {
      const currency =
        typeof o.currency === "string" && o.currency.trim()
          ? o.currency.trim()
          : null;
      const key = currency ?? NULL_KEY;
      const bucket = buckets.get(key) ?? {
        currency,
        total: 0,
        orderCount: 0,
      };
      bucket.total = round2(bucket.total + o.total);
      bucket.orderCount += 1;
      buckets.set(key, bucket);
    }
  }

  const salesByCurrency = [...buckets.values()].sort((a, b) =>
    (a.currency ?? "").localeCompare(b.currency ?? ""),
  );
  const totalSales =
    salesByCurrency.length >= 2
      ? null
      : salesByCurrency.length === 1
        ? salesByCurrency[0].total
        : 0;
  const totalSalesCurrency =
    salesByCurrency.length === 1 ? salesByCurrency[0].currency : null;

  return {
    total: orders.length,
    pending,
    confirmed,
    cancelled,
    completed,
    inProgress,
    unknownStatus,
    salesByCurrency,
    totalSales,
    totalSalesCurrency,
    unpricedCount,
    invalidTotalCount,
  };
}

// ---------------------------------------------------------------------------
// Invoice (order record only)
// ---------------------------------------------------------------------------

export interface InvoiceLine {
  name: string;
  qty: number;
  price: number | null;
  /** price * qty, or null when the item price is not recorded. */
  lineTotal: number | null;
}

export type CodState = "cod" | "not_cod" | "not_recorded";

export interface Invoice {
  orderId: string;
  lines: InvoiceLine[];
  /** Sum of priced lines, or null when no line carries a price. */
  itemsSubtotal: number | null;
  /** True when at least one line has no recorded price (subtotal partial). */
  hasUnpricedLines: boolean;
  /** Recorded delivery charge, or null when not recorded anywhere. */
  deliveryCharge: number | null;
  /** Recorded discount, or null when none is recorded. */
  discount: number | null;
  /** The order record's total. Never recomputed, never overwritten. */
  recordedTotal: number | null;
  /**
   * itemsSubtotal - discount + deliveryCharge, ONLY when all three
   * components are present. Otherwise null (no check possible).
   */
  computedCheck: number | null;
  /**
   * null when no check is possible; otherwise whether the computed check
   * equals the recorded total to the cent. A false value is a FLAG for
   * the team — the recorded total still wins and is never "fixed" here.
   */
  totalsMatch: boolean | null;
  paymentMethod: string | null;
  codState: CodState;
  /** == recordedTotal when codState is "cod", else null. Never assumed. */
  codAmount: number | null;
  /** Recorded currency verbatim, or null. */
  currency: string | null;
}

function cleanMoney(v: unknown): number | null {
  return isFiniteNonNegative(v) ? round2(v as number) : null;
}

export function buildInvoice(order: DashboardOrderInput): Invoice {
  const rawItems = Array.isArray(order.items) ? order.items : [];
  const lines: InvoiceLine[] = rawItems.map((it) => {
    const name =
      typeof it.name === "string" && it.name.trim()
        ? it.name.trim().slice(0, 200)
        : "";
    const qtyRaw = Number(it.qty ?? 1);
    const qty =
      Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;
    const price = cleanMoney(it.price);
    return {
      name,
      qty,
      price,
      lineTotal: price === null ? null : round2(price * qty),
    };
  });

  let itemsSubtotal: number | null = null;
  let hasUnpricedLines = false;
  for (const l of lines) {
    if (l.lineTotal === null) {
      hasUnpricedLines = true;
    } else {
      itemsSubtotal = round2((itemsSubtotal ?? 0) + l.lineTotal);
    }
  }
  if (lines.length === 0) itemsSubtotal = null;

  const deliveryCharge =
    cleanMoney(order.deliveryCharge) ??
    cleanMoney(order.priceBreakdown?.deliveryCharge);
  const discount =
    cleanMoney(order.couponDiscount) ??
    cleanMoney(order.priceBreakdown?.couponDiscount);
  const recordedTotal = cleanMoney(order.total);
  const computedCheck =
    itemsSubtotal !== null && discount !== null && deliveryCharge !== null
      ? round2(itemsSubtotal - discount + deliveryCharge)
      : itemsSubtotal !== null && deliveryCharge !== null && discount === null
        ? round2(itemsSubtotal + deliveryCharge)
        : null;
  // NOTE: the second branch above covers the common no-discount case
  // (discount null means "no discount recorded", so the check is
  // subtotal + delivery). When discount is recorded it must be included.
  const totalsMatch =
    computedCheck !== null && recordedTotal !== null
      ? Math.abs(computedCheck - recordedTotal) < 0.005
      : null;

  const paymentMethod =
    typeof order.paymentMethod === "string" && order.paymentMethod.trim()
      ? order.paymentMethod.trim()
      : null;
  const codState: CodState =
    paymentMethod === null
      ? "not_recorded"
      : paymentMethod.toLowerCase() === "cod"
        ? "cod"
        : "not_cod";

  return {
    orderId: order.id,
    lines,
    itemsSubtotal,
    hasUnpricedLines,
    deliveryCharge,
    discount,
    recordedTotal,
    computedCheck,
    totalsMatch,
    paymentMethod,
    codState,
    codAmount: codState === "cod" ? recordedTotal : null,
    currency:
      typeof order.currency === "string" && order.currency.trim()
        ? order.currency.trim()
        : null,
  };
}

/**
 * Money display helper for dashboard/invoice renderers. The recorded
 * currency code is shown verbatim; with no recorded currency NO symbol
 * is shown at all. `null` amount renders as null (caller shows the
 * "not recorded" wording) — never as 0.
 */
export function formatMoney(
  amount: number | null,
  currency: string | null,
): string | null {
  if (amount === null) return null;
  const n = amount.toFixed(2);
  return currency ? `${currency} ${n}` : n;
}
