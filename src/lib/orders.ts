/**
 * orders.ts — Phase 2: per-business order-flow builder + order capture.
 *
 * Each business defines its own custom order fields
 * (`businesses.orderFields`, edited in the dashboard "Order Settings").
 * When the AI takes an order (take_order tool), it must first satisfy every
 * REQUIRED field; `getMissingOrderFields` tells the AI exactly what is
 * still missing so it can ask the customer conversationally.
 *
 * Tenancy: `createOrder` uses the ambient tenant-scoped `prisma` client
 * (fail-closed — throws TenantContextError with no business context).
 * Reading the business row goes through the UNSCOPED client on purpose:
 * the `businesses` collection is not tenant-scoped and the caller already
 * knows its own businessId (fail-closed: missing business => throw).
 */

import { prisma, withBusinessId, getUnscopedPrisma } from "./prisma";
import { logger } from "./logger";
import type { JsonValue } from "./models";

export type OrderFieldType = "text" | "select" | "date" | "number" | "textarea";

export interface OrderField {
  /** Machine key, e.g. "delivery_address". */
  key: string;
  /** Human label shown in the builder and to the AI, e.g. "Delivery address". */
  label: string;
  type: OrderFieldType;
  required: boolean;
  /** Only for type "select". */
  options?: string[];
}

export type OrderStatus = "pending" | "confirmed" | "cancelled";

export interface OrderItem {
  productId?: string | null;
  name: string;
  qty: number;
  price?: number | null;
}

const KEY_RE = /^[a-z0-9_]{1,40}$/;
const FIELD_TYPES: OrderFieldType[] = ["text", "select", "date", "number", "textarea"];

/**
 * Starter field set offered by the Order Settings UI ("Load starter fields").
 * Works for a cake seller, a food shop, or a courier-style business.
 */
export const DEFAULT_ORDER_FIELDS: OrderField[] = [
  { key: "customer_name", label: "Customer name", type: "text", required: true },
  { key: "phone", label: "Phone number", type: "text", required: true },
  { key: "delivery_address", label: "Delivery address", type: "textarea", required: true },
  { key: "delivery_date", label: "Delivery date", type: "date", required: false },
  { key: "notes", label: "Order notes / custom description", type: "textarea", required: false },
];

/**
 * Validate a full orderFields array (used by PUT /api/order-fields).
 * Returns the cleaned array or throws with a human-readable message.
 */
export function validateOrderFields(input: unknown): OrderField[] {
  if (!Array.isArray(input)) {
    throw new Error("orderFields must be an array.");
  }
  if (input.length > 30) {
    throw new Error("Too many order fields (max 30).");
  }
  const seen = new Set<string>();
  return input.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Field #${i + 1} is not an object.`);
    }
    const f = raw as Record<string, unknown>;
    const key = String(f.key ?? "").trim().toLowerCase();
    if (!KEY_RE.test(key)) {
      throw new Error(
        `Field #${i + 1}: key must be 1-40 chars of lowercase letters, digits or underscore.`
      );
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate field key: "${key}".`);
    }
    seen.add(key);
    const label = String(f.label ?? "").trim().slice(0, 80);
    if (!label) {
      throw new Error(`Field "${key}": label is required.`);
    }
    const type = String(f.type ?? "text") as OrderFieldType;
    if (!FIELD_TYPES.includes(type)) {
      throw new Error(`Field "${key}": unknown type "${type}".`);
    }
    const required = Boolean(f.required);
    let options: string[] | undefined;
    if (type === "select") {
      const rawOpts = Array.isArray(f.options) ? f.options : [];
      options = rawOpts
        .map((o) => String(o ?? "").trim())
        .filter(Boolean)
        .slice(0, 20);
      if (options.length === 0) {
        throw new Error(`Field "${key}": select fields need at least one option.`);
      }
    }
    return { key, label, type, required, ...(options ? { options } : {}) };
  });
}

/** Read a business's order field definitions (empty array when none). */
export async function getOrderFields(businessId: string): Promise<OrderField[]> {
  const biz = await getUnscopedPrisma().business.findUnique({
    where: { id: businessId },
    select: { id: true, orderFields: true },
  });
  if (!biz) {
    throw new Error(`Unknown business: ${businessId}`);
  }
  try {
    return validateOrderFields((biz as { orderFields?: unknown }).orderFields ?? []);
  } catch {
    // Tolerate legacy/corrupt data: treat as no fields rather than crash.
    return [];
  }
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

/**
 * Which REQUIRED fields still have no usable value in `collected`
 * (collected = { key: value } from the AI's take_order call).
 * An empty array means the order may be created.
 */
export function getMissingOrderFields(
  fields: OrderField[],
  collected: Record<string, unknown>
): OrderField[] {
  return fields.filter((f) => f.required && isEmptyValue(collected[f.key]));
}

/** Normalize the free-form items array coming from the AI tool call. */
export function normalizeItems(input: unknown): OrderItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 50)
    .map((raw): OrderItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const it = raw as Record<string, unknown>;
      const name = String(it.name ?? "").trim().slice(0, 200);
      if (!name) return null;
      const qty = Number(it.qty ?? 1);
      const price =
        it.price === null || it.price === undefined || it.price === ""
          ? null
          : Number(it.price);
      const item: OrderItem = {
        productId:
          typeof it.productId === "string" && it.productId ? it.productId : null,
        name,
        qty: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1,
        price: price !== null && Number.isFinite(price) && price >= 0 ? price : null,
      };
      return item;
    })
    .filter((it): it is OrderItem => it !== null);
}

export function computeTotal(items: OrderItem[]): number | null {
  if (items.length === 0) return null;
  let total = 0;
  let priced = false;
  for (const it of items) {
    if (it.price !== null && it.price !== undefined) {
      total += it.price * it.qty;
      priced = true;
    }
  }
  return priced ? Math.round(total * 100) / 100 : null;
}

export interface CreateOrderInput {
  conversationId?: string | null;
  customerId?: string | null;
  items: OrderItem[];
  customFields: Record<string, unknown>;
  total?: number | null;
  /** Free-text summary shown on the dashboard (e.g. "2x Chocolate Cake"). */
  summary?: string;
}

/** Persist an order doc in the tenant's `orders` collection. */
export async function createOrder(input: CreateOrderInput) {
  const customFields: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(input.customFields ?? {})) {
    if (v === undefined) continue;
    customFields[k] =
      v === null ? null : (["string", "number", "boolean"].includes(typeof v) ? (v as JsonValue) : String(v));
  }
  const items = input.items ?? [];
  const total =
    input.total !== undefined && input.total !== null
      ? input.total
      : computeTotal(items);
  return prisma.order.create({
    data: withBusinessId({
      conversationId: input.conversationId ?? null,
      customerId: input.customerId ?? null,
      items: items as unknown as JsonValue,
      customFields: customFields as unknown as JsonValue,
      status: "pending" as OrderStatus,
      total,
      summary: (input.summary ?? "").slice(0, 300),
    }),
  });
}

/** Mark an order confirmed/cancelled (dashboard). */
export async function setOrderStatus(orderId: string, status: OrderStatus) {
  if (!["pending", "confirmed", "cancelled"].includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status },
  });

  // Courier bridge (owner directive 2026-10-21): confirming an order
  // automatically creates its Ride Bangla courier booking; cancelling
  // mirrors into a still-unclaimed booking. This hook is the single
  // funnel — every channel's orders are confirmed through here. The
  // bridge NEVER throws into the status update (its outcome is recorded
  // on the order itself as `courierBooking`); the order is re-read so
  // the caller sees the booking state.
  if (status === "confirmed" || status === "cancelled") {
    try {
      const bridge = await import("./courier-bridge");
      if (status === "confirmed") {
        await bridge.handleOrderConfirmed(orderId);
      } else {
        await bridge.handleOrderCancelled(orderId);
      }
      const fresh = await getUnscopedPrisma().order.findUnique({
        where: { id: orderId },
      });
      if (fresh) return fresh;
    } catch (err) {
      logger.error("Courier bridge hook failed:", err);
    }
  }
  return updated;
}
