/**
 * courier-bridge.ts — Agent-order → Ride Bangla courier bridge.
 *
 * Owner directive 2026-10-21: when the AI Agent confirms an order for a
 * business (any channel — website widget, Messenger, WhatsApp, …), the
 * order AUTOMATICALLY becomes a courier booking in Ride Bangla's own
 * courier system and appears in the Rider app dispatch flow. Nobody books
 * a courier separately; the agent's order confirmation IS the courier
 * booking.
 *
 * HOW IT WORKS
 * - Trigger: `setOrderStatus()` in ./orders is the platform's single
 *   order-status choke point (only the dashboard PATCH route calls it).
 *   It calls `handleOrderConfirmed` / `handleOrderCancelled` here after a
 *   status change. Every channel funnels into the same order doc, so one
 *   hook covers every channel.
 * - Write path: SERVER-ONLY, via the Admin SDK (`getAdminDb()` in
 *   ./admin-db) into the shared ride-bangla-app Firestore — the same
 *   trusted path the billing modules use. Never a client write, never the
 *   client-writable free-form order path.
 * - Target model (ops): `courier_orders/{id}` (canonical order doc) +
 *   `rider_dispatch_queue/{id}` (the doc the Rider app listens to; shape
 *   mirrors the ops backend's own `syncDispatchQueueEntry` output field
 *   for field) + `admin_orders/{id}` (monitoring mirror, as written by
 *   the ops `createCustomerOrder` callable).
 * - Idempotency: the courier doc id is deterministic —
 *   `agent_{agentOrderId}` — and creation is a single transaction that
 *   returns the existing booking when the doc already exists. One agent
 *   order ⇒ at most one courier booking, however many times the confirm
 *   event fires.
 * - Two-way link: the agent order carries `courierBooking`
 *   ({ state, courierOrderId, … }); the courier doc carries
 *   `agentOrderId / agentBusinessId / source: "ai_agent"`.
 *   `getCourierDeliveryStatus()` reads the live ops docs back so the
 *   agent/dashboard answer from real state.
 *
 * MONEY SAFETY (the Round-2 forgery lesson): the payload builders below
 * copy ONLY whitelisted fields. They NEVER write a delivery fee,
 * commission rate/amount, VAT, or distance — those are computed by the
 * ops side alone (road-distance pricing in `createCustomerOrder` /
 * admin), and rider earnings are computed from the ORDER doc's fee by
 * the ops backend. Nothing a customer typed in chat can reach a money
 * field. Statuses written here are fixed constants, never input.
 *
 * NEEDS-INFO: without a deliverable drop address AND a reachable phone
 * (or a resolvable pickup), NO ops doc is created — the order's link is
 * marked `needs_info` with the exact missing fields. Nothing is ever
 * fabricated.
 *
 * SERVER-ONLY. Never import from client components.
 */

import admin from "firebase-admin";
import { getAdminDb } from "./admin-db";
import { getUnscopedPrisma } from "./prisma";
import { logger } from "./logger";
import type { Business, JsonValue, Order } from "./models";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const COURIER_ORDERS_COLLECTION = "courier_orders";
export const DISPATCH_QUEUE_COLLECTION = "rider_dispatch_queue";
export const ADMIN_ORDERS_COLLECTION = "admin_orders";

/**
 * The platform's own Ride Bangla business is identified by its public
 * widget site key (already embedded on every Ride Bangla site) or by the
 * internal-owner flag — never by an email string.
 */
export const RIDE_BANGLA_OWN_SITE_KEY =
  "rbsite-00f37b79c72f4e678febbd82d43bb46c";

/** Deterministic ops doc id for an agent order's courier booking. */
export function courierOrderIdFor(agentOrderId: string): string {
  return `agent_${agentOrderId}`;
}

/**
 * Agent order ids are server-minted UUIDs (the Firestore shim's
 * `randomUUID()`), so a legitimate id is always doc-id safe. An id
 * outside this charset (path separators, dots, unicode tricks) can
 * never come from the platform's own order creation — fail closed
 * rather than letting it shape a Firestore doc path.
 */
const SAFE_AGENT_ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
export function isSafeAgentOrderId(agentOrderId: string): boolean {
  return SAFE_AGENT_ORDER_ID.test(agentOrderId);
}

/* ------------------------------------------------------------------ */
/* Link + setting                                                      */
/* ------------------------------------------------------------------ */

export type CourierBookingState =
  | "booked"
  | "needs_info"
  | "cancelled"
  | "cancel_requested"
  | "failed";

export interface CourierBookingLink {
  state: CourierBookingState;
  courierOrderId?: string;
  /** Field keys still needed before a booking can be created. */
  missing?: string[];
  /** Last ops status snapshot, when one was recorded. */
  opsStatus?: string;
  bookedAt?: string;
  updatedAt: string;
  error?: string;
}

export function readBookingLink(order: {
  courierBooking?: unknown;
}): CourierBookingLink | null {
  const raw = order.courierBooking;
  if (!raw || typeof raw !== "object") return null;
  const link = raw as CourierBookingLink;
  if (typeof link.state !== "string") return null;
  return link;
}

/**
 * Effective per-business setting. The stored boolean always wins. When
 * the business has never stored it, the default is ON only for the
 * platform's own Ride Bangla business (the owner's business) and OFF for
 * every tenant — a tenant outside the courier service area simply never
 * enables it.
 */
export function resolveCourierDeliveryEnabled(business: {
  courierDeliveryEnabled?: unknown;
  isInternalAccount?: unknown;
  siteKey?: unknown;
}): boolean {
  if (typeof business.courierDeliveryEnabled === "boolean") {
    return business.courierDeliveryEnabled;
  }
  if (business.isInternalAccount === true) return true;
  if (business.siteKey === RIDE_BANGLA_OWN_SITE_KEY) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Delivery-detail extraction + payload builders (pure, whitelisted)   */
/* ------------------------------------------------------------------ */

export interface PreparedBooking {
  opsCustomerId: string;
  customerName: string;
  customerPhone: string;
  pickupAddress: string;
  pickupName: string;
  pickupPhone: string;
  dropAddress: string;
  items: Array<{ name: string; qty: number; price: number | null }>;
  total: number | null;
  notes: string;
  businessName: string;
  conversationId: string | null;
}

export type ExtractResult =
  | { ok: true; prepared: PreparedBooking }
  | { ok: false; missing: string[] };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, max = 500): string {
  if (typeof value === "string")
    // Strip zero-width / format characters (ZWSP, ZWNJ/ZWJ, BOM, soft
    // hyphen, word joiner): they are invisible, so a "blank" address
    // padded with them must not pass the deliverability length check,
    // and they have no place in names/notes shown to riders either.
    return value
      .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060]/g, "")
      .trim()
      .slice(0, max);
  if (typeof value === "number" && Number.isFinite(value))
    return String(value).slice(0, max);
  return "";
}

function isDeliverableAddress(value: string): boolean {
  return value.trim().length >= 8;
}

function isReachablePhone(value: string): boolean {
  return value.replace(/\D/g, "").length >= 10;
}

/** Items are re-mapped through the whitelist — nothing else survives. */
export function whitelistItems(
  raw: unknown
): Array<{ name: string; qty: number; price: number | null }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; qty: number; price: number | null }> = [];
  for (const entry of raw.slice(0, 50)) {
    const it = asRecord(entry);
    const name = cleanText(it.name, 200);
    if (!name) continue;
    const qtyRaw = Number(it.qty);
    const qty =
      Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;
    const priceRaw =
      it.price === null || it.price === undefined || it.price === ""
        ? null
        : Number(it.price);
    out.push({
      name,
      qty,
      price:
        priceRaw !== null && Number.isFinite(priceRaw) && priceRaw >= 0
          ? priceRaw
          : null,
    });
  }
  return out;
}

/**
 * Extract the deliverable facts for a booking from an agent order +
 * business. Pickup = the order's own `pickup` field when the customer
 * gave one (courier-style orders for Ride Bangla itself), else the
 * business's profile address. Returns the exact list of missing fields
 * instead of guessing when something is absent.
 */
export function extractDeliveryDetails(
  order: Pick<Order, "customFields" | "items" | "total" | "customerId" | "conversationId" | "id">,
  business: Pick<Business, "name" | "contactName" | "contactPhone" | "contactAddress">
): ExtractResult {
  const cf = asRecord(order.customFields);
  const missing: string[] = [];

  const dropAddress =
    cleanText(cf.delivery_address, 500) ||
    cleanText(cf.dropoff, 500) ||
    cleanText(cf.address, 500);
  if (!isDeliverableAddress(dropAddress)) missing.push("delivery_address");

  const customerPhone =
    cleanText(cf.phone, 40) ||
    cleanText(cf.customer_phone, 40) ||
    cleanText(cf.phone_number, 40);
  if (!isReachablePhone(customerPhone)) missing.push("phone");

  const explicitPickup = cleanText(cf.pickup, 500);
  const pickupAddress = explicitPickup || cleanText(business.contactAddress, 500);
  if (!isDeliverableAddress(pickupAddress)) missing.push("pickup_address");

  if (missing.length > 0) return { ok: false, missing };

  const customerName =
    cleanText(cf.customer_name, 120) ||
    cleanText(cf.name, 120) ||
    cleanText(cf.customerName, 120);

  const rawTotal = order.total;
  const total =
    typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0
      ? rawTotal
      : null;

  const opsCustomerId =
    typeof order.customerId === "string" && order.customerId.trim()
      ? order.customerId.trim()
      : `agent_guest_${(order.conversationId || order.id).replace(/[^A-Za-z0-9_-]/g, "_")}`;

  return {
    ok: true,
    prepared: {
      opsCustomerId,
      customerName,
      customerPhone,
      pickupAddress,
      pickupName: cleanText(business.name, 160),
      pickupPhone: cleanText(business.contactPhone, 40),
      dropAddress,
      items: whitelistItems(order.items),
      total,
      notes: cleanText(cf.notes, 500) || cleanText(cf.note, 500),
      businessName: cleanText(business.name, 160),
      conversationId: order.conversationId ?? null,
    },
  };
}

type DocData = Record<string, unknown>;

/**
 * The canonical courier order doc. Mirrors the ops `createCustomerOrder`
 * COD-courier payload's shape and dual snake/camel key convention, MINUS
 * every server-computed money/route field (fee, commission, VAT,
 * distance, coordinates — the ops side alone computes those) and PLUS
 * the agent link fields and the `dropoff_*` aliases the dispatch mirror
 * reads (the ops payload's `destination_*` naming leaves the queue
 * mirror's dropoff empty; the aliases keep bridge orders correct
 * through both paths).
 */
export function buildCourierOrderDoc(
  prepared: PreparedBooking,
  agentOrderId: string,
  businessId: string,
  ts: unknown
): DocData {
  const courierOrderId = courierOrderIdFor(agentOrderId);
  const hasTotal = prepared.total !== null;
  const doc: DocData = {
    id: courierOrderId,
    order_id: courierOrderId,
    orderId: courierOrderId,
    customer_id: prepared.opsCustomerId,
    customerId: prepared.opsCustomerId,
    customer_name: prepared.customerName || null,
    customerName: prepared.customerName || null,
    customer_phone: prepared.customerPhone,
    customerPhone: prepared.customerPhone,
    sender_name: prepared.pickupName || null,
    senderName: prepared.pickupName || null,
    sender_phone: prepared.pickupPhone || null,
    senderPhone: prepared.pickupPhone || null,
    business_name: prepared.businessName || null,
    businessName: prepared.businessName || null,
    pickup_address: prepared.pickupAddress,
    pickupAddress: prepared.pickupAddress,
    destination_address: prepared.dropAddress,
    destinationAddress: prepared.dropAddress,
    dropoff_address: prepared.dropAddress,
    dropoffAddress: prepared.dropAddress,
    pickup_latitude: null,
    pickupLatitude: null,
    pickup_longitude: null,
    pickupLongitude: null,
    destination_latitude: null,
    destinationLatitude: null,
    destination_longitude: null,
    destinationLongitude: null,
    items: prepared.items,
    item_count: prepared.items.length,
    itemCount: prepared.items.length,
    delivery_notes: prepared.notes || null,
    deliveryNotes: prepared.notes || null,
    payment_method: "cash_on_delivery",
    paymentMethod: "cash_on_delivery",
    payment_status: hasTotal ? "cash_on_delivery" : "pending",
    paymentStatus: hasTotal ? "cash_on_delivery" : "pending",
    status: "pending_rider_assignment",
    tracking_status: "pending_rider_assignment",
    trackingStatus: "pending_rider_assignment",
    dispatch_status: "ready_for_dispatch",
    dispatchStatus: "ready_for_dispatch",
    rider_dispatch_status: "ready_for_dispatch",
    riderDispatchStatus: "ready_for_dispatch",
    order_type: "courier",
    orderType: "courier",
    service_type: "courier",
    serviceType: "courier",
    source: "ai_agent",
    agent_order_id: agentOrderId,
    agentOrderId: agentOrderId,
    agent_business_id: businessId,
    agentBusinessId: businessId,
    agent_conversation_id: prepared.conversationId,
    agentConversationId: prepared.conversationId,
    created_by: "ai_agent",
    createdBy: "ai_agent",
    rider_id: null,
    riderId: null,
    created_at: ts,
    createdAt: ts,
    updated_at: ts,
    updatedAt: ts,
  };
  if (hasTotal) {
    doc.total_amount = prepared.total;
    doc.totalAmount = prepared.total;
    doc.total_payable = prepared.total;
    doc.totalPayable = prepared.total;
  }
  return doc;
}

/**
 * The dispatch-queue doc — field-for-field the ops backend's own
 * `syncDispatchQueueEntry` output, so the Rider app sees a bridge booking
 * exactly as it sees a backend-mirrored one. Money/distance carry the
 * backend's own pre-pricing representation (0 = not yet priced by ops;
 * the rider UI renders "—"); the ORDER doc above is where money lives,
 * and it carries no fee until ops pricing sets one.
 */
export function buildDispatchQueueDoc(
  prepared: PreparedBooking,
  agentOrderId: string,
  ts: unknown
): DocData {
  const courierOrderId = courierOrderIdFor(agentOrderId);
  return {
    orderId: courierOrderId,
    order_id: courierOrderId,
    orderCollection: COURIER_ORDERS_COLLECTION,
    order_collection: COURIER_ORDERS_COLLECTION,
    orderType: "courier",
    order_type: "courier",
    customerId: prepared.opsCustomerId,
    customer_id: prepared.opsCustomerId,
    partnerId: null,
    partner_id: null,
    riderId: null,
    rider_id: null,
    pickupAddress: prepared.pickupAddress,
    pickup_address: prepared.pickupAddress,
    dropoffAddress: prepared.dropAddress,
    dropoff_address: prepared.dropAddress,
    deliveryFee: 0,
    delivery_fee: 0,
    distanceKm: 0,
    distance_km: 0,
    eligibleVehicleTypes: [],
    eligible_vehicle_types: [],
    status: "ready_for_dispatch",
    orderStatus: "ready_for_dispatch",
    order_status: "ready_for_dispatch",
    dispatchStatus: "ready_for_dispatch",
    dispatch_status: "ready_for_dispatch",
    agentOrderId: agentOrderId,
    agent_order_id: agentOrderId,
    createdAt: ts,
    created_at: ts,
    updatedAt: ts,
    updated_at: ts,
  };
}

/** The admin monitoring mirror, same convention as `createCustomerOrder`. */
export function buildAdminOrderDoc(courierDoc: DocData): DocData {
  return {
    ...courierDoc,
    admin_role: "monitoring_only",
    operational_receiver: "nearby_rider",
  };
}

/* ------------------------------------------------------------------ */
/* Status flow-back                                                    */
/* ------------------------------------------------------------------ */

export type CourierPhase =
  | "awaiting_rider"
  | "rider_assigned"
  | "picked_up"
  | "on_the_way"
  | "delivered"
  | "cancelled"
  | "unknown";

export interface CourierDeliveryStatus {
  linkState: CourierBookingState | "none";
  courierOrderId: string | null;
  /** Raw ops status from `courier_orders.status` (null when unreadable). */
  opsStatus: string | null;
  dispatchStatus: string | null;
  riderAssigned: boolean;
  riderId: string | null;
  phase: CourierPhase;
}

const TERMINAL_OPS_STATUSES = [
  "delivered",
  "cancelled",
  "rejected",
  "completed",
  "refunded",
];

export function isTerminalOpsStatus(status: string): boolean {
  return TERMINAL_OPS_STATUSES.includes(status);
}

export function normalizeCourierPhase(
  opsStatus: string | null,
  riderAssigned: boolean
): CourierPhase {
  switch (opsStatus) {
    case "delivered":
    case "completed":
      return "delivered";
    case "cancelled":
    case "rejected":
    case "failed":
      return "cancelled";
    case "picked_up":
      return "picked_up";
    case "on_the_way":
    case "arrived":
    case "payment_confirmed":
      return "on_the_way";
    case "accepted":
    case "assigned":
      return "rider_assigned";
    default:
      return riderAssigned ? "rider_assigned" : "awaiting_rider";
  }
}

/* ------------------------------------------------------------------ */
/* Store (Firestore in production; fake in the harness)                */
/* ------------------------------------------------------------------ */

/** What an already-existing doc at the deterministic booking id is:
 *  genuinely this order's bridge booking (owned) or something else. */
export interface ExistingBookingInfo {
  /** True only when the doc carries THIS order's bridge link fields
   *  (agentOrderId + agentBusinessId + source "ai_agent"). A foreign
   *  doc squatting at the deterministic id is never adopted. */
  owned: boolean;
  /** The doc's raw ops status (null when absent/not a string). */
  status: string | null;
}

/** Classify a doc found at a booking id against the booking being built. */
export function classifyExistingBooking(
  doc: Record<string, unknown> | null,
  agentOrderId: string,
  businessId: string
): ExistingBookingInfo | null {
  if (!doc) return null;
  const owned =
    (doc.agentOrderId === agentOrderId || doc.agent_order_id === agentOrderId) &&
    (doc.agentBusinessId === businessId ||
      doc.agent_business_id === businessId) &&
    doc.source === "ai_agent";
  return {
    owned,
    status: typeof doc.status === "string" ? doc.status : null,
  };
}

export interface CourierBridgeStore {
  getDoc(
    collection: string,
    id: string
  ): Promise<Record<string, unknown> | null>;
  /** Atomically create courier + queue + admin docs iff the courier doc
   *  does not already exist. Returns whether this call created them;
   *  when it did not, `existing` classifies the doc that was found
   *  (older store implementations may omit it — callers then classify
   *  via getDoc). */
  createBookingIfAbsent(
    courierOrderId: string,
    docs: { courier: DocData; queue: DocData; adminOrder: DocData }
  ): Promise<{ created: boolean; existing?: ExistingBookingInfo | null }>;
  /** Cancel a booking iff it is still unclaimed and non-terminal.
   *  "claimed" = a rider already holds it (ops owns it now);
   *  "closed" = terminal ops status; "missing" = no courier doc. */
  cancelBookingIfUnclaimed(
    courierOrderId: string,
    ts: unknown
  ): Promise<"cancelled" | "claimed" | "closed" | "missing">;
  /** Re-create a booking whose ops docs were cancelled through this
   *  bridge (agent order re-confirmed after an agent-side cancel):
   *  replaces the cancelled docs with the fresh payload iff the
   *  existing doc is this order's own bridge booking, still
   *  `cancelled`, and still unclaimed. */
  reviveCancelledBooking(
    courierOrderId: string,
    docs: { courier: DocData; queue: DocData; adminOrder: DocData }
  ): Promise<"revived" | "claimed" | "closed" | "missing" | "foreign">;
}

export function createFirestoreStore(
  db: admin.firestore.Firestore
): CourierBridgeStore {
  return {
    async getDoc(collection, id) {
      const snap = await db.collection(collection).doc(id).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },

    async createBookingIfAbsent(courierOrderId, docs) {
      const courierRef = db
        .collection(COURIER_ORDERS_COLLECTION)
        .doc(courierOrderId);
      return db.runTransaction(async (tx) => {
        const existing = await tx.get(courierRef);
        if (existing.exists)
          return {
            created: false,
            existing: classifyExistingBooking(
              existing.data() as Record<string, unknown>,
              String(docs.courier.agentOrderId ?? ""),
              String(docs.courier.agentBusinessId ?? "")
            ),
          };
        tx.set(courierRef, docs.courier);
        tx.set(
          db.collection(DISPATCH_QUEUE_COLLECTION).doc(courierOrderId),
          docs.queue
        );
        tx.set(
          db.collection(ADMIN_ORDERS_COLLECTION).doc(courierOrderId),
          docs.adminOrder
        );
        return { created: true };
      });
    },

    async reviveCancelledBooking(courierOrderId, docs) {
      const courierRef = db
        .collection(COURIER_ORDERS_COLLECTION)
        .doc(courierOrderId);
      const queueRef = db
        .collection(DISPATCH_QUEUE_COLLECTION)
        .doc(courierOrderId);
      return db.runTransaction(async (tx) => {
        const courierSnap = await tx.get(courierRef);
        if (!courierSnap.exists) return "missing" as const;
        const courier = courierSnap.data() as Record<string, unknown>;
        const info = classifyExistingBooking(
          courier,
          String(docs.courier.agentOrderId ?? ""),
          String(docs.courier.agentBusinessId ?? "")
        );
        if (!info?.owned) return "foreign" as const;
        if (courier.status !== "cancelled") return "closed" as const;
        const queueSnap = await tx.get(queueRef);
        const queue = queueSnap.exists
          ? (queueSnap.data() as Record<string, unknown>)
          : {};
        const riderId =
          (typeof queue.riderId === "string" && queue.riderId) ||
          (typeof queue.rider_id === "string" && queue.rider_id) ||
          (typeof courier.riderId === "string" && courier.riderId) ||
          (typeof courier.rider_id === "string" && courier.rider_id) ||
          "";
        if (riderId) return "claimed" as const;
        tx.set(courierRef, docs.courier);
        tx.set(queueRef, docs.queue);
        tx.set(
          db.collection(ADMIN_ORDERS_COLLECTION).doc(courierOrderId),
          docs.adminOrder
        );
        return "revived" as const;
      });
    },

    async cancelBookingIfUnclaimed(courierOrderId, ts) {
      const courierRef = db
        .collection(COURIER_ORDERS_COLLECTION)
        .doc(courierOrderId);
      const queueRef = db
        .collection(DISPATCH_QUEUE_COLLECTION)
        .doc(courierOrderId);
      return db.runTransaction(async (tx) => {
        const courierSnap = await tx.get(courierRef);
        if (!courierSnap.exists) return "missing" as const;
        const courier = courierSnap.data() as Record<string, unknown>;
        const status = typeof courier.status === "string" ? courier.status : "";
        if (isTerminalOpsStatus(status)) return "closed" as const;
        const queueSnap = await tx.get(queueRef);
        const queue = queueSnap.exists
          ? (queueSnap.data() as Record<string, unknown>)
          : {};
        const riderId =
          (typeof queue.riderId === "string" && queue.riderId) ||
          (typeof queue.rider_id === "string" && queue.rider_id) ||
          (typeof courier.riderId === "string" && courier.riderId) ||
          (typeof courier.rider_id === "string" && courier.rider_id) ||
          "";
        if (riderId) return "claimed" as const;
        const cancelFields: DocData = {
          status: "cancelled",
          orderStatus: "cancelled",
          order_status: "cancelled",
          dispatchStatus: "cancelled",
          dispatch_status: "cancelled",
          rider_dispatch_status: "cancelled",
          riderDispatchStatus: "cancelled",
          tracking_status: "cancelled",
          trackingStatus: "cancelled",
          cancelledAt: ts,
          cancelled_at: ts,
          updatedAt: ts,
          updated_at: ts,
        };
        tx.set(courierRef, cancelFields, { merge: true });
        tx.set(queueRef, cancelFields, { merge: true });
        return "cancelled" as const;
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration (deps injectable for the harness)                     */
/* ------------------------------------------------------------------ */

export interface CourierBridgeDeps {
  store: CourierBridgeStore;
  loadOrder(orderId: string): Promise<Order | null>;
  loadBusiness(businessId: string): Promise<Business | null>;
  saveLink(orderId: string, link: CourierBookingLink): Promise<void>;
  now(): Date;
  serverTimestamp(): unknown;
}

export function defaultDeps(): CourierBridgeDeps {
  const unscoped = getUnscopedPrisma();
  return {
    store: createFirestoreStore(getAdminDb()),
    async loadOrder(orderId) {
      const order = await unscoped.order.findUnique({
        where: { id: orderId },
      });
      return (order as Order | null) ?? null;
    },
    async loadBusiness(businessId) {
      const business = await unscoped.business.findUnique({
        where: { id: businessId },
      });
      return (business as Business | null) ?? null;
    },
    async saveLink(orderId, link) {
      await unscoped.order.update({
        where: { id: orderId },
        data: { courierBooking: link as unknown as JsonValue },
      });
    },
    now: () => new Date(),
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  };
}

export type CourierBridgeOutcome =
  | { state: "booked"; courierOrderId: string; created: boolean }
  | { state: "needs_info"; missing: string[] }
  | { state: "disabled" }
  | { state: "skipped"; reason: string }
  | { state: "failed"; error: string };

/**
 * The confirm hook. NEVER throws: every failure is captured into the
 * order's link (`state: "failed"` + error) and the outcome, so a bridge
 * problem can never break the order flow itself — and is never silent.
 */
export async function handleOrderConfirmed(
  orderId: string,
  deps?: CourierBridgeDeps
): Promise<CourierBridgeOutcome> {
  let d: CourierBridgeDeps;
  try {
    d = deps ?? defaultDeps();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("[courier-bridge] not configured", err, { orderId });
    return { state: "failed", error };
  }

  try {
    const order = await d.loadOrder(orderId);
    if (!order) return { state: "skipped", reason: "order_not_found" };
    if (order.status !== "confirmed")
      return { state: "skipped", reason: "not_confirmed" };

    const business = await d.loadBusiness(order.businessId);
    if (!business) {
      await recordLink(d, orderId, {
        state: "failed",
        error: "business_not_found",
        updatedAt: d.now().toISOString(),
      });
      return { state: "failed", error: "business_not_found" };
    }
    if (!resolveCourierDeliveryEnabled(business)) return { state: "disabled" };

    // Order ids are server-minted UUIDs; anything else can never be a
    // legitimate platform order and must not shape a Firestore doc id.
    if (!isSafeAgentOrderId(orderId)) {
      await recordLink(d, orderId, {
        state: "failed",
        error: "unsafe_order_id",
        updatedAt: d.now().toISOString(),
      });
      return { state: "failed", error: "unsafe_order_id" };
    }

    const courierOrderId = courierOrderIdFor(orderId);
    const existingLink = readBookingLink(order);

    // Idempotency: a live booking for this order already exists → done.
    // The doc found at the deterministic id must be verified as THIS
    // order's bridge booking first — a foreign doc squatting at the id
    // is a collision to surface, never a booking to adopt.
    if (existingLink?.state === "booked") {
      const doc = await d.store.getDoc(
        COURIER_ORDERS_COLLECTION,
        courierOrderId
      );
      if (doc) {
        const info = classifyExistingBooking(doc, orderId, order.businessId);
        if (!info?.owned) {
          await recordLink(d, orderId, {
            state: "failed",
            error: "courier_id_collision",
            updatedAt: d.now().toISOString(),
          });
          return { state: "failed", error: "courier_id_collision" };
        }
        return { state: "booked", courierOrderId, created: false };
      }
      // Link says booked but the ops doc is gone — fall through and
      // recreate it under the same deterministic id (self-healing).
    }

    const extracted = extractDeliveryDetails(order, business);
    if (!extracted.ok) {
      await recordLink(d, orderId, {
        state: "needs_info",
        missing: extracted.missing,
        updatedAt: d.now().toISOString(),
      });
      logger.info("[courier-bridge] booking needs info", {
        orderId,
        missing: extracted.missing,
      });
      return { state: "needs_info", missing: extracted.missing };
    }

    const ts = d.serverTimestamp();
    const courierDoc = buildCourierOrderDoc(
      extracted.prepared,
      orderId,
      order.businessId,
      ts
    );
    const queueDoc = buildDispatchQueueDoc(extracted.prepared, orderId, ts);
    const adminDoc = buildAdminOrderDoc(courierDoc);
    const docs = {
      courier: courierDoc,
      queue: queueDoc,
      adminOrder: adminDoc,
    };
    const { created, existing } = await d.store.createBookingIfAbsent(
      courierOrderId,
      docs
    );

    if (!created) {
      // Something already lives at the deterministic id. Adopt it ONLY
      // when it is verifiably this order's own bridge booking in a live
      // state; revive the bridge-cancelled case; refuse everything else
      // instead of stamping the order "booked" over a foreign, terminal
      // or cancelled doc nobody will ever dispatch.
      const info =
        existing ??
        classifyExistingBooking(
          await d.store.getDoc(COURIER_ORDERS_COLLECTION, courierOrderId),
          orderId,
          order.businessId
        );
      if (!info) return { state: "failed", error: "booking_vanished" };
      if (!info.owned) {
        await recordLink(d, orderId, {
          state: "failed",
          error: "courier_id_collision",
          updatedAt: d.now().toISOString(),
        });
        logger.error("[courier-bridge] courier id collision", {
          orderId,
          courierOrderId,
        });
        return { state: "failed", error: "courier_id_collision" };
      }
      if (info.status === "cancelled") {
        const revived = await d.store.reviveCancelledBooking(
          courierOrderId,
          docs
        );
        if (revived !== "revived") {
          await recordLink(d, orderId, {
            state: "failed",
            error: `booking_not_revivable_${revived}`,
            updatedAt: d.now().toISOString(),
          });
          return {
            state: "failed",
            error: `booking_not_revivable_${revived}`,
          };
        }
        await recordLink(d, orderId, {
          state: "booked",
          courierOrderId,
          bookedAt: d.now().toISOString(),
          updatedAt: d.now().toISOString(),
        });
        logger.info("[courier-bridge] cancelled booking revived", {
          orderId,
          courierOrderId,
        });
        return { state: "booked", courierOrderId, created: false };
      }
      if (info.status && isTerminalOpsStatus(info.status)) {
        await recordLink(d, orderId, {
          state: "failed",
          error: "booking_terminal",
          opsStatus: info.status,
          updatedAt: d.now().toISOString(),
        });
        return { state: "failed", error: "booking_terminal" };
      }
      // Own live booking (e.g. the link was lost) — adopt it below.
    }

    await recordLink(d, orderId, {
      state: "booked",
      courierOrderId,
      bookedAt: existingLink?.bookedAt ?? d.now().toISOString(),
      updatedAt: d.now().toISOString(),
    });
    logger.info("[courier-bridge] courier booking ensured", {
      orderId,
      courierOrderId,
      created,
    });
    return { state: "booked", courierOrderId, created };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("[courier-bridge] confirm hook failed", err, { orderId });
    await recordLink(d, orderId, {
      state: "failed",
      error,
      updatedAt: d.now().toISOString(),
    });
    return { state: "failed", error };
  }
}

export type CourierCancelOutcome =
  | { state: "cancelled" }
  | { state: "cancel_requested" }
  | { state: "none" }
  | { state: "failed"; error: string };

/** The cancel hook: mirror an agent-order cancellation into the booking
 *  while it is still unclaimed; once a rider holds it, ops owns the
 *  outcome and the link is only flagged `cancel_requested`. */
export async function handleOrderCancelled(
  orderId: string,
  deps?: CourierBridgeDeps
): Promise<CourierCancelOutcome> {
  let d: CourierBridgeDeps;
  try {
    d = deps ?? defaultDeps();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("[courier-bridge] not configured (cancel)", err, { orderId });
    return { state: "failed", error };
  }

  try {
    const order = await d.loadOrder(orderId);
    if (!order) return { state: "none" };
    const link = readBookingLink(order);
    if (!link || link.state !== "booked") return { state: "none" };
    if (!isSafeAgentOrderId(orderId)) return { state: "none" };

    // NEVER trust the link's stored courierOrderId: it is data on a
    // document other writers can touch, while the booking id is a pure
    // function of THIS order's id. A forged link must not be able to
    // cancel (or point at) another business's booking.
    const courierOrderId = courierOrderIdFor(orderId);

    const result = await d.store.cancelBookingIfUnclaimed(
      courierOrderId,
      d.serverTimestamp()
    );

    if (result === "cancelled" || result === "missing") {
      await recordLink(d, orderId, {
        ...link,
        state: "cancelled",
        courierOrderId,
        ...(result === "missing" ? { opsStatus: "missing" } : {}),
        updatedAt: d.now().toISOString(),
      });
      return { state: "cancelled" };
    }

    // "claimed" | "closed": leave the ops docs untouched; ops owns them.
    const doc = await d.store.getDoc(
      COURIER_ORDERS_COLLECTION,
      courierOrderId
    );
    await recordLink(d, orderId, {
      ...link,
      state: "cancel_requested",
      courierOrderId,
      ...(doc && typeof doc.status === "string"
        ? { opsStatus: doc.status }
        : {}),
      updatedAt: d.now().toISOString(),
    });
    return { state: "cancel_requested" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("[courier-bridge] cancel hook failed", err, { orderId });
    return { state: "failed", error };
  }
}

/** Live delivery status for one agent order, read back from the ops
 *  docs — the single flow-back path for dashboard + agent callers. */
export async function getCourierDeliveryStatus(
  orderId: string,
  deps?: CourierBridgeDeps
): Promise<CourierDeliveryStatus | null> {
  let d: CourierBridgeDeps;
  try {
    d = deps ?? defaultDeps();
  } catch {
    return null;
  }
  const order = await d.loadOrder(orderId);
  if (!order) return null;
  const link = readBookingLink(order);
  // Read back ONLY this order's own deterministic booking id — never
  // the link's stored pointer, which a forged link could aim at
  // another business's courier doc (cross-tenant status leak).
  const courierOrderId =
    link && (link.state === "booked" || link.courierOrderId) && isSafeAgentOrderId(orderId)
      ? courierOrderIdFor(orderId)
      : null;
  if (!courierOrderId) {
    return {
      linkState: link?.state ?? "none",
      courierOrderId: null,
      opsStatus: null,
      dispatchStatus: null,
      riderAssigned: false,
      riderId: null,
      phase: "unknown",
    };
  }
  const courier = await d.store.getDoc(
    COURIER_ORDERS_COLLECTION,
    courierOrderId
  );
  const queue = await d.store.getDoc(
    DISPATCH_QUEUE_COLLECTION,
    courierOrderId
  );
  const opsStatus =
    courier && typeof courier.status === "string" ? courier.status : null;
  const dispatchStatus =
    (queue && typeof queue.dispatchStatus === "string"
      ? queue.dispatchStatus
      : null) ??
    (courier && typeof courier.dispatchStatus === "string"
      ? courier.dispatchStatus
      : null);
  const riderId =
    (queue && typeof queue.riderId === "string" && queue.riderId) ||
    (courier && typeof courier.riderId === "string" && courier.riderId) ||
    null;
  return {
    linkState: link?.state ?? "none",
    courierOrderId,
    opsStatus,
    dispatchStatus,
    riderAssigned: Boolean(riderId),
    riderId,
    phase: normalizeCourierPhase(opsStatus, Boolean(riderId)),
  };
}

async function recordLink(
  d: CourierBridgeDeps,
  orderId: string,
  link: CourierBookingLink
): Promise<void> {
  try {
    await d.saveLink(orderId, link);
  } catch (err) {
    logger.error("[courier-bridge] failed to record booking link", err, {
      orderId,
      state: link.state,
    });
  }
}
