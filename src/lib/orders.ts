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
import {
  appendAuditTrail,
  planHumanStatusChange,
  type LockAuditEntry,
  type LockActorType,
} from "./order-lock";
import {
  queueOrderRatingRequest,
  prismaRatingStore,
} from "./order-rating-requests";
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

/**
 * Mark an order confirmed/cancelled (dashboard) — LEG B (staged).
 *
 * HUMAN-CONFIRM-ONLY + LOCKED (shared guard, src/lib/order-lock.ts):
 * - Only a human actor may write status. An "agent" or "customer"
 *   actor is refused BEFORE any write, so no agent tool, chat path,
 *   or future auto-confirm switch can confirm/cancel/reopen an order
 *   even if one were added by mistake — the data layer says no.
 * - Every status write appends one audit entry to `lockAudit` in the
 *   SAME update as the status change (plus `lockedAt` on confirm,
 *   cleared on reopen). A post-confirmation change without an audit
 *   entry cannot happen through this function.
 * - Backward compatibility: callers that pass no `opts` (the pre-LB
 *   dashboard route shape) still work, but their audit entry is
 *   flagged `actorUnverified: true` with actorId null — the gap is
 *   visible, never invented. The LB-03 route always passes a
 *   verified dashboard actor, so real dashboard transitions are
 *   attributed. Cross-tenant ids fail closed with a P2025-style
 *   error (the route maps it to 404, exactly as before).
 * - The courier bridge hook below is UNCHANGED: it is a consequence
 *   of a human confirmation, never a status writer, and its
 *   single-field `courierBooking` write is not a content edit, so
 *   the lock does not (and must not) block it.
 */
export interface SetOrderStatusOptions {
  actorType?: LockActorType;
  actorId?: string | null;
  /** Optional human reason (dashboard may pass body.reason). */
  reason?: string | null;
  conversationId?: string | null;
  /** Test seam; defaults to new Date().toISOString(). */
  nowIso?: string;
}

export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
  opts?: SetOrderStatusOptions
) {
  if (!["pending", "confirmed", "cancelled"].includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const actorType: LockActorType = opts?.actorType ?? "human";
  if (actorType !== "human") {
    throw new Error(
      "Only a human team member may confirm, cancel, or reopen an order."
    );
  }
  const nowIso = opts?.nowIso ?? new Date().toISOString();
  // Current record first: the guard and the audit trail both need it,
  // and the scoped update below still enforces tenancy (a cross-tenant
  // id throws P2025 there, exactly as before — no existence leak).
  const current = await getUnscopedPrisma().order.findUnique({
    where: { id: orderId },
  });
  if (!current) {
    // Preserve HEAD behaviour for unknown ids: the scoped update throws
    // P2025, which the route maps to 404.
    return prisma.order.update({
      where: { id: orderId },
      data: { status },
    });
  }
  const currentStatus = String(
    (current as { status?: unknown }).status ?? ""
  );
  const plan = planHumanStatusChange({
    record: {
      id: orderId,
      status: currentStatus,
      lockedAt: (current as { lockedAt?: unknown }).lockedAt,
      lockAudit: (current as { lockAudit?: unknown }).lockAudit,
    },
    toStatus: status,
    actorType: "human",
    actorId: opts?.actorId ?? null,
    reason: opts?.reason ?? null,
    conversationId: opts?.conversationId ?? null,
    nowIso,
  });
  if (!plan.allowed) {
    throw new Error(plan.message);
  }
  const existingTrail = (current as { lockAudit?: unknown }).lockAudit;
  const trail: LockAuditEntry[] = appendAuditTrail(
    existingTrail,
    plan.auditEntry
  );
  // Same cast pattern createOrder already uses for JSON fields
  // (items/customFields as unknown as JsonValue); the Order model
  // carries an index signature, so lockAudit/lockedAt persist like
  // the courierBooking precedent.
  const data: {
    status: OrderStatus;
    lockAudit: JsonValue;
    lockedAt?: string | null;
  } = { status, lockAudit: trail as unknown as JsonValue };
  if (plan.setLockedAt !== undefined) {
    data.lockedAt = plan.setLockedAt;
  }
  const updated = await prisma.order.update({
    where: { id: orderId },
    data,
  });

  // Merge note (family stack): Leg B already read the pre-update record
  // above (current/currentStatus); it serves as Leg I's previous-status
  // read — no second read. decideRatingRequest compares previousStatus
  // to status for equality only, so B's string form is equivalent to
  // Leg I's null-on-missing form for every real order status.
  const previousStatus = currentStatus;
  let result = updated;

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
      if (fresh) result = fresh;
    } catch (err) {
      logger.error("Courier bridge hook failed:", err);
    }
  }

  // Leg I: after a CONFIRM (and after the bridge, so the fresh
  // order is used), queue the star-rating request in the order's
  // own chat. Fail-soft by design — a notification failure never
  // breaks a confirm, and the queue itself refuses non-transitions,
  // unlinked orders, foreign conversations, takeover threads, and
  // duplicate requests. Rating language follows the business's
  // settings language (no customer text exists at confirm time).
  if (status === "confirmed") {
    try {
      const settings = await prisma.settings.findFirst().catch(() => null);
      const businessName =
        settings && typeof settings.businessName === "string"
          ? settings.businessName
          : "";
      const lang = settings?.language === "bn" ? "bn" : "en";
      await queueOrderRatingRequest(
        result,
        previousStatus,
        { businessName, lang },
        prismaRatingStore(prisma, withBusinessId)
      );
    } catch (err) {
      logger.warn("[orders] rating request queue failed (confirm unaffected)", {
        orderId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
