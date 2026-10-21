/**
 * courier-bridge.test.ts — harness for the agent-order → Ride Bangla
 * courier bridge (owner directive 2026-10-21).
 *
 * Drives the REAL orchestration + payload builders from
 * src/lib/courier-bridge.ts against an in-memory store that implements
 * the same contract as the Firestore store (create-if-absent,
 * cancel-if-unclaimed). Scenarios:
 *   1. confirmed + enabled + complete info → exactly one booking with
 *      correct pickup/drop/items/amounts and a two-way link
 *   2. duplicate confirm events → still one booking
 *   3. unconfirmed / cancelled orders → no booking
 *   4. missing address/phone → flagged needs_info, no booking; fixing
 *      the info and re-confirming books it
 *   5. business without the setting → no booking (defaults: ON for the
 *      platform's own business, OFF for tenants; stored value wins)
 *   6. courier-side status is visible to the agent side via the link
 *   7. cancel mirror: unclaimed → cancelled; claimed → hands off
 *   8. hostile customFields can never reach ops money/status fields
 *   9. the order's own pickup field overrides the business address
 */

import { describe, it, expect } from "vitest";
import {
  COURIER_ORDERS_COLLECTION,
  DISPATCH_QUEUE_COLLECTION,
  ADMIN_ORDERS_COLLECTION,
  courierOrderIdFor,
  classifyExistingBooking,
  resolveCourierDeliveryEnabled,
  extractDeliveryDetails,
  buildCourierOrderDoc,
  handleOrderConfirmed,
  handleOrderCancelled,
  getCourierDeliveryStatus,
  type CourierBridgeDeps,
  type CourierBridgeStore,
  type CourierBookingLink,
} from "@/lib/courier-bridge";
import type { Business, Order } from "@/lib/models";

/* ------------------------------------------------------------------ */
/* Fake store — same decisions as createFirestoreStore, in memory      */
/* ------------------------------------------------------------------ */

class FakeStore implements CourierBridgeStore {
  docs = new Map<string, Record<string, unknown>>();
  createCalls = 0;

  private key(collection: string, id: string) {
    return `${collection}/${id}`;
  }

  async getDoc(collection: string, id: string) {
    return this.docs.get(this.key(collection, id)) ?? null;
  }

  async createBookingIfAbsent(
    courierOrderId: string,
    docs: {
      courier: Record<string, unknown>;
      queue: Record<string, unknown>;
      adminOrder: Record<string, unknown>;
    }
  ) {
    this.createCalls += 1;
    const key = this.key(COURIER_ORDERS_COLLECTION, courierOrderId);
    if (this.docs.has(key))
      return {
        created: false,
        existing: classifyExistingBooking(
          this.docs.get(key)!,
          String(docs.courier.agentOrderId ?? ""),
          String(docs.courier.agentBusinessId ?? "")
        ),
      };
    this.docs.set(key, docs.courier);
    this.docs.set(this.key(DISPATCH_QUEUE_COLLECTION, courierOrderId), docs.queue);
    this.docs.set(this.key(ADMIN_ORDERS_COLLECTION, courierOrderId), docs.adminOrder);
    return { created: true };
  }

  async reviveCancelledBooking(
    courierOrderId: string,
    docs: {
      courier: Record<string, unknown>;
      queue: Record<string, unknown>;
      adminOrder: Record<string, unknown>;
    }
  ) {
    const ck = this.key(COURIER_ORDERS_COLLECTION, courierOrderId);
    const courier = this.docs.get(ck);
    if (!courier) return "missing" as const;
    const info = classifyExistingBooking(
      courier,
      String(docs.courier.agentOrderId ?? ""),
      String(docs.courier.agentBusinessId ?? "")
    );
    if (!info?.owned) return "foreign" as const;
    if (courier.status !== "cancelled") return "closed" as const;
    const qk = this.key(DISPATCH_QUEUE_COLLECTION, courierOrderId);
    const queue = this.docs.get(qk) ?? {};
    const rider =
      (typeof queue.riderId === "string" && queue.riderId) ||
      (typeof courier.riderId === "string" && courier.riderId) ||
      "";
    if (rider) return "claimed" as const;
    this.docs.set(ck, docs.courier);
    this.docs.set(qk, docs.queue);
    this.docs.set(this.key(ADMIN_ORDERS_COLLECTION, courierOrderId), docs.adminOrder);
    return "revived" as const;
  }

  async cancelBookingIfUnclaimed(courierOrderId: string, ts: unknown) {
    const ck = this.key(COURIER_ORDERS_COLLECTION, courierOrderId);
    const courier = this.docs.get(ck);
    if (!courier) return "missing" as const;
    const status = String(courier.status ?? "");
    if (["delivered", "cancelled", "rejected", "completed", "refunded"].includes(status))
      return "closed" as const;
    const qk = this.key(DISPATCH_QUEUE_COLLECTION, courierOrderId);
    const queue = this.docs.get(qk) ?? {};
    const rider =
      (typeof queue.riderId === "string" && queue.riderId) ||
      (typeof courier.riderId === "string" && courier.riderId) ||
      "";
    if (rider) return "claimed" as const;
    const cancel: Record<string, unknown> = {
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
    this.docs.set(ck, { ...courier, ...cancel });
    this.docs.set(qk, { ...queue, ...cancel });
    return "cancelled" as const;
  }

  courierDoc(id: string) {
    return this.docs.get(this.key(COURIER_ORDERS_COLLECTION, id));
  }
  queueDoc(id: string) {
    return this.docs.get(this.key(DISPATCH_QUEUE_COLLECTION, id));
  }
  adminDoc(id: string) {
    return this.docs.get(this.key(ADMIN_ORDERS_COLLECTION, id));
  }
  get size() {
    return this.docs.size;
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RB_BUSINESS = {
  id: "biz-rb",
  name: "Ride Bangla",
  siteKey: "rbsite-00f37b79c72f4e678febbd82d43bb46c",
  isInternalAccount: true,
  contactName: "Ride Bangla",
  contactPhone: "+8801309587749",
  contactAddress: "Ride Bangla Office, Faridpur Sadar",
} as unknown as Business;

const TENANT_ON = {
  id: "biz-cake",
  name: "Cake House",
  siteKey: "rbsite-cakehouse",
  contactName: "Cake House",
  contactPhone: "+8801700000000",
  contactAddress: "Shop 4, Baker Road, Dhanmondi, Dhaka",
  courierDeliveryEnabled: true,
} as unknown as Business;

const TENANT_DEFAULT = {
  ...TENANT_ON,
  id: "biz-plain",
  siteKey: "rbsite-plainshop",
  courierDeliveryEnabled: undefined,
} as unknown as Business;

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    businessId: "biz-rb",
    conversationId: "conv-1",
    customerId: "cust-1",
    status: "confirmed",
    items: [
      { productId: "p1", name: "Chocolate Cake", qty: 2, price: 450 },
      { productId: "p2", name: "Candle Pack", qty: 1, price: 0 },
    ],
    customFields: {
      customer_name: "Rahim Uddin",
      phone: "01712345678",
      delivery_address: "House 12, Road 3, Faridpur Sadar",
      notes: "Ring the bell twice",
    },
    total: 900,
    summary: "food_delivery: cakes",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Order;
}

function makeHarness(
  orders: Order[],
  businesses: Business[]
): { deps: CourierBridgeDeps; store: FakeStore; links: CourierBookingLink[] } {
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const bizMap = new Map(businesses.map((b) => [b.id, b]));
  const store = new FakeStore();
  const links: CourierBookingLink[] = [];
  const deps: CourierBridgeDeps = {
    store,
    loadOrder: async (id) => orderMap.get(id) ?? null,
    loadBusiness: async (id) => bizMap.get(id) ?? null,
    saveLink: async (orderId, link) => {
      links.push(link);
      const o = orderMap.get(orderId);
      if (o) o.courierBooking = link as unknown as Order["courierBooking"];
    },
    now: () => new Date("2026-10-21T07:00:00.000Z"),
    serverTimestamp: () => "SERVER_TS",
  };
  return { deps, store, links };
}

const CID = courierOrderIdFor("order-1");
const FORBIDDEN_KEYS = [
  "deliveryFee",
  "delivery_fee",
  "estimatedFare",
  "estimated_fare",
  "platformCommissionRate",
  "platform_commission_rate",
  "platformCommission",
  "platform_commission",
  "riderCommissionRate",
  "rider_commission_rate",
  "riderCommission",
  "rider_commission",
  "vatRate",
  "vat_rate",
  "vatAmount",
  "vat_amount",
  "distanceKm",
  "distance_km",
];

/* ------------------------------------------------------------------ */
/* Setting resolution                                                  */
/* ------------------------------------------------------------------ */

describe("resolveCourierDeliveryEnabled", () => {
  it("stored boolean always wins", () => {
    expect(
      resolveCourierDeliveryEnabled({ courierDeliveryEnabled: false, isInternalAccount: true })
    ).toBe(false);
    expect(resolveCourierDeliveryEnabled({ courierDeliveryEnabled: true })).toBe(true);
  });

  it("defaults ON for the platform's own business (flag or site key)", () => {
    expect(resolveCourierDeliveryEnabled({ isInternalAccount: true })).toBe(true);
    expect(
      resolveCourierDeliveryEnabled({
        siteKey: "rbsite-00f37b79c72f4e678febbd82d43bb46c",
      })
    ).toBe(true);
  });

  it("defaults OFF for tenants", () => {
    expect(resolveCourierDeliveryEnabled({ siteKey: "rbsite-someone-else" })).toBe(false);
    expect(resolveCourierDeliveryEnabled({})).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 1 + 9. Happy path                                                   */
/* ------------------------------------------------------------------ */

describe("handleOrderConfirmed — booking creation", () => {
  it("creates exactly one courier booking with correct pickup/drop/items/amounts + link", async () => {
    const order = makeOrder();
    const { deps, store, links } = makeHarness([order], [RB_BUSINESS]);

    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "booked", courierOrderId: CID, created: true });
    expect(store.size).toBe(3); // courier + queue + admin mirror

    const doc = store.courierDoc(CID)!;
    expect(doc.pickupAddress).toBe("Ride Bangla Office, Faridpur Sadar");
    expect(doc.pickup_address).toBe("Ride Bangla Office, Faridpur Sadar");
    expect(doc.dropoffAddress).toBe("House 12, Road 3, Faridpur Sadar");
    expect(doc.destinationAddress).toBe("House 12, Road 3, Faridpur Sadar");
    expect(doc.customerName).toBe("Rahim Uddin");
    expect(doc.customerPhone).toBe("01712345678");
    expect(doc.customerId).toBe("cust-1");
    expect(doc.items).toEqual([
      { name: "Chocolate Cake", qty: 2, price: 450 },
      { name: "Candle Pack", qty: 1, price: 0 },
    ]);
    expect(doc.total_amount).toBe(900);
    expect(doc.totalAmount).toBe(900);
    expect(doc.totalPayable).toBe(900);
    expect(doc.status).toBe("pending_rider_assignment");
    expect(doc.dispatchStatus).toBe("ready_for_dispatch");
    expect(doc.rider_dispatch_status).toBe("ready_for_dispatch");
    expect(doc.paymentMethod).toBe("cash_on_delivery");
    expect(doc.paymentStatus).toBe("cash_on_delivery");
    expect(doc.source).toBe("ai_agent");
    expect(doc.agentOrderId).toBe("order-1");
    expect(doc.agentBusinessId).toBe("biz-rb");
    expect(doc.riderId).toBeNull();

    // Money safety: the ORDER doc carries NO fee/commission/vat/distance —
    // ops pricing alone may ever set those.
    for (const k of FORBIDDEN_KEYS) expect(doc).not.toHaveProperty(k);

    const queue = store.queueDoc(CID)!;
    expect(queue.dispatchStatus).toBe("ready_for_dispatch");
    expect(queue.status).toBe("ready_for_dispatch");
    expect(queue.orderCollection).toBe("courier_orders");
    expect(queue.orderType).toBe("courier");
    expect(queue.pickupAddress).toBe("Ride Bangla Office, Faridpur Sadar");
    expect(queue.dropoffAddress).toBe("House 12, Road 3, Faridpur Sadar");
    expect(queue.riderId).toBeNull();
    expect(queue.eligibleVehicleTypes).toEqual([]);

    const admin = store.adminDoc(CID)!;
    expect(admin.admin_role).toBe("monitoring_only");

    expect(links).toHaveLength(1);
    expect(links[0].state).toBe("booked");
    expect(links[0].courierOrderId).toBe(CID);
    expect(readLinkState(order)).toBe("booked");
  });

  it("uses the order's own pickup field when the customer gave one", async () => {
    const order = makeOrder({
      customFields: {
        customer_name: "Karim",
        phone: "01812345678",
        delivery_address: "Flat 9B, Gulshan Avenue, Dhaka",
        pickup: "Sender home, Uttara Sector 7, Dhaka",
      },
    });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome.state).toBe("booked");
    expect(store.courierDoc(CID)!.pickupAddress).toBe("Sender home, Uttara Sector 7, Dhaka");
  });

  it("books for a tenant whose setting is ON, with the tenant as pickup", async () => {
    const order = makeOrder({ id: "order-t", businessId: "biz-cake" });
    const { deps, store } = makeHarness([order], [TENANT_ON]);
    const outcome = await handleOrderConfirmed("order-t", deps);
    expect(outcome.state).toBe("booked");
    const doc = store.courierDoc(courierOrderIdFor("order-t"))!;
    expect(doc.pickupAddress).toBe("Shop 4, Baker Road, Dhanmondi, Dhaka");
    expect(doc.businessName).toBe("Cake House");
  });

  it("falls back to a namespaced guest customer id when the order has no customer", async () => {
    const order = makeOrder({ customerId: null });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    await handleOrderConfirmed("order-1", deps);
    expect(store.courierDoc(CID)!.customerId).toBe("agent_guest_conv-1");
    expect(store.queueDoc(CID)!.customerId).toBe("agent_guest_conv-1");
  });

  it("omits totals (never invents them) when the order total is unknown", async () => {
    const order = makeOrder({ total: null });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    await handleOrderConfirmed("order-1", deps);
    const doc = store.courierDoc(CID)!;
    expect(doc).not.toHaveProperty("total_amount");
    expect(doc).not.toHaveProperty("totalAmount");
    expect(doc.paymentStatus).toBe("pending");
  });
});

function readLinkState(order: Order): string | undefined {
  return (order.courierBooking as CourierBookingLink | undefined)?.state;
}

/* ------------------------------------------------------------------ */
/* 2. Idempotency                                                      */
/* ------------------------------------------------------------------ */

describe("idempotency", () => {
  it("duplicate confirm events → still exactly one booking", async () => {
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);

    const first = await handleOrderConfirmed("order-1", deps);
    const second = await handleOrderConfirmed("order-1", deps);
    const third = await handleOrderConfirmed("order-1", deps);

    expect(first).toEqual({ state: "booked", courierOrderId: CID, created: true });
    expect(second).toEqual({ state: "booked", courierOrderId: CID, created: false });
    expect(third).toEqual({ state: "booked", courierOrderId: CID, created: false });
    expect(store.size).toBe(3);
  });

  it("recreates the booking under the same id if the ops doc was deleted", async () => {
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    await handleOrderConfirmed("order-1", deps);
    store.docs.delete(`${COURIER_ORDERS_COLLECTION}/${CID}`);

    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "booked", courierOrderId: CID, created: true });
    expect(store.courierDoc(CID)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 3 + 5. No booking cases                                             */
/* ------------------------------------------------------------------ */

describe("no-booking cases", () => {
  it("unconfirmed (pending) order → skipped, nothing written", async () => {
    const order = makeOrder({ status: "pending" });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "skipped", reason: "not_confirmed" });
    expect(store.size).toBe(0);
  });

  it("cancelled order → skipped by the confirm hook", async () => {
    const order = makeOrder({ status: "cancelled" });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome.state).toBe("skipped");
    expect(store.size).toBe(0);
  });

  it("tenant without the setting (default OFF) → disabled, nothing written, no link", async () => {
    const order = makeOrder({ businessId: "biz-plain" });
    const { deps, store, links } = makeHarness([order], [TENANT_DEFAULT]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "disabled" });
    expect(store.size).toBe(0);
    expect(links).toHaveLength(0);
  });

  it("own business with the setting explicitly OFF → disabled", async () => {
    const off = { ...RB_BUSINESS, courierDeliveryEnabled: false } as unknown as Business;
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [off]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "disabled" });
    expect(store.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Needs-info                                                       */
/* ------------------------------------------------------------------ */

describe("needs-info (never fabricate)", () => {
  it("missing delivery address → flagged, no booking", async () => {
    const order = makeOrder({
      customFields: { customer_name: "Rahim", phone: "01712345678" },
    });
    const { deps, store, links } = makeHarness([order], [RB_BUSINESS]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "needs_info", missing: ["delivery_address"] });
    expect(store.size).toBe(0);
    expect(links[0].state).toBe("needs_info");
    expect(links[0].missing).toEqual(["delivery_address"]);
  });

  it("unreachable phone → flagged, no booking", async () => {
    const order = makeOrder({
      customFields: {
        customer_name: "Rahim",
        phone: "123",
        delivery_address: "House 12, Road 3, Faridpur Sadar",
      },
    });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "needs_info", missing: ["phone"] });
    expect(store.size).toBe(0);
  });

  it("no order pickup and no business address → pickup_address flagged", async () => {
    const noAddr = {
      ...TENANT_ON,
      contactAddress: "",
    } as unknown as Business;
    const order = makeOrder({ businessId: "biz-cake" });
    const { deps, store } = makeHarness([order], [noAddr]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome).toEqual({ state: "needs_info", missing: ["pickup_address"] });
    expect(store.size).toBe(0);
  });

  it("needs_info is not terminal: completing the info and re-confirming books it", async () => {
    const order = makeOrder({
      customFields: { customer_name: "Rahim", phone: "01712345678" },
    });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const first = await handleOrderConfirmed("order-1", deps);
    expect(first.state).toBe("needs_info");

    order.customFields = {
      ...(order.customFields as Record<string, unknown>),
      delivery_address: "House 12, Road 3, Faridpur Sadar",
    };
    const second = await handleOrderConfirmed("order-1", deps);
    expect(second).toEqual({ state: "booked", courierOrderId: CID, created: true });
    expect(store.size).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Status flow-back                                                 */
/* ------------------------------------------------------------------ */

describe("status flow-back", () => {
  it("agent side sees courier-side progress through the link", async () => {
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    await handleOrderConfirmed("order-1", deps);

    let status = await getCourierDeliveryStatus("order-1", deps);
    expect(status).toMatchObject({
      linkState: "booked",
      courierOrderId: CID,
      opsStatus: "pending_rider_assignment",
      riderAssigned: false,
      phase: "awaiting_rider",
    });

    // Rider claims via the queue doc only.
    const queue = store.queueDoc(CID)!;
    store.docs.set(`${DISPATCH_QUEUE_COLLECTION}/${CID}`, {
      ...queue,
      riderId: "rider-9",
      status: "accepted",
      dispatchStatus: "accepted",
    });
    status = await getCourierDeliveryStatus("order-1", deps);
    expect(status?.riderAssigned).toBe(true);
    expect(status?.riderId).toBe("rider-9");
    expect(status?.phase).toBe("rider_assigned");

    // Delivery progresses on the courier doc.
    const doc = store.courierDoc(CID)!;
    store.docs.set(`${COURIER_ORDERS_COLLECTION}/${CID}`, {
      ...doc,
      status: "picked_up",
      riderId: "rider-9",
    });
    status = await getCourierDeliveryStatus("order-1", deps);
    expect(status?.phase).toBe("picked_up");

    store.docs.set(`${COURIER_ORDERS_COLLECTION}/${CID}`, {
      ...doc,
      status: "delivered",
      riderId: "rider-9",
    });
    status = await getCourierDeliveryStatus("order-1", deps);
    expect(status?.phase).toBe("delivered");
  });

  it("order without a booking reports linkState none / phase unknown", async () => {
    const order = makeOrder({ status: "pending" });
    const { deps } = makeHarness([order], [RB_BUSINESS]);
    const status = await getCourierDeliveryStatus("order-1", deps);
    expect(status?.linkState).toBe("none");
    expect(status?.phase).toBe("unknown");
    expect(status?.courierOrderId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 7. Cancel mirror                                                    */
/* ------------------------------------------------------------------ */

describe("cancel mirror", () => {
  it("cancelling an unclaimed booking cancels courier + queue docs", async () => {
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    await handleOrderConfirmed("order-1", deps);

    const outcome = await handleOrderCancelled("order-1", deps);
    expect(outcome).toEqual({ state: "cancelled" });
    expect(store.courierDoc(CID)!.status).toBe("cancelled");
    expect(store.queueDoc(CID)!.status).toBe("cancelled");
    expect(store.queueDoc(CID)!.dispatchStatus).toBe("cancelled");
    expect(readLinkState(order)).toBe("cancelled");
  });

  it("cancelling after a rider claimed it writes NOTHING ops-side", async () => {
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    await handleOrderConfirmed("order-1", deps);
    const queue = store.queueDoc(CID)!;
    store.docs.set(`${DISPATCH_QUEUE_COLLECTION}/${CID}`, {
      ...queue,
      riderId: "rider-9",
      status: "accepted",
    });

    const outcome = await handleOrderCancelled("order-1", deps);
    expect(outcome).toEqual({ state: "cancel_requested" });
    expect(store.courierDoc(CID)!.status).toBe("pending_rider_assignment");
    expect(store.queueDoc(CID)!.status).toBe("accepted");
    expect(readLinkState(order)).toBe("cancel_requested");
  });

  it("cancelling an order that was never booked is a no-op", async () => {
    const order = makeOrder({ status: "cancelled" });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const outcome = await handleOrderCancelled("order-1", deps);
    expect(outcome).toEqual({ state: "none" });
    expect(store.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Whitelist under attack                                           */
/* ------------------------------------------------------------------ */

describe("whitelist (Round-2 forgery regression)", () => {
  it("hostile customFields never reach ops money/status fields", async () => {
    const order = makeOrder({
      customFields: {
        customer_name: "Mallory",
        phone: "01712345678",
        delivery_address: "House 1, Road 1, Faridpur Sadar",
        deliveryFee: 99999,
        delivery_fee: 99999,
        riderCommissionRate: 0.99,
        platformCommissionRate: 0,
        status: "delivered",
        dispatchStatus: "delivered",
        riderId: "accomplice-uid",
        total_amount: 1,
      },
      total: 500,
    });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const outcome = await handleOrderConfirmed("order-1", deps);
    expect(outcome.state).toBe("booked");

    const doc = store.courierDoc(CID)!;
    expect(doc.status).toBe("pending_rider_assignment");
    expect(doc.dispatchStatus).toBe("ready_for_dispatch");
    expect(doc.riderId).toBeNull();
    expect(doc.total_amount).toBe(500); // the platform's own total, not the injected 1
    for (const k of FORBIDDEN_KEYS) expect(doc).not.toHaveProperty(k);
  });

  it("hostile item fields are stripped to {name, qty, price}", async () => {
    const extracted = extractDeliveryDetails(
      makeOrder({
        items: [
          {
            name: "Box",
            qty: 3,
            price: 100,
            deliveryFee: 777,
            riderId: "x",
            status: "delivered",
          } as unknown as Order["items"][number],
        ],
      }),
      RB_BUSINESS
    );
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect(extracted.prepared.items).toEqual([{ name: "Box", qty: 3, price: 100 }]);
    }
  });

  it("buildCourierOrderDoc writes fixed statuses regardless of input", () => {
    const extracted = extractDeliveryDetails(makeOrder(), RB_BUSINESS);
    if (!extracted.ok) throw new Error("fixture should extract");
    const doc = buildCourierOrderDoc(extracted.prepared, "order-1", "biz-rb", "TS");
    expect(doc.status).toBe("pending_rider_assignment");
    expect(doc.source).toBe("ai_agent");
    expect(doc.created_by).toBe("ai_agent");
  });
});

/* ------------------------------------------------------------------ */
/* 10. Attack regressions (Team-3 attack test, 2026-10-21)               */
/* ------------------------------------------------------------------ */

describe("attack regressions", () => {
  it("forged link on order A cannot cancel business B's booking", async () => {
    const b = makeOrder({ id: "order-b", businessId: "biz-cake" });
    const a = makeOrder({ id: "order-a", businessId: "biz-rb" });
    const { deps, store } = makeHarness([a, b], [RB_BUSINESS, TENANT_ON]);
    await handleOrderConfirmed("order-b", deps);
    a.courierBooking = {
      state: "booked",
      courierOrderId: courierOrderIdFor("order-b"),
      updatedAt: "x",
    } as unknown as Order["courierBooking"];
    a.status = "cancelled";
    await handleOrderCancelled("order-a", deps);
    expect(
      store.courierDoc(courierOrderIdFor("order-b"))!.status
    ).toBe("pending_rider_assignment");
  });

  it("forged link on order A cannot read business B's delivery status", async () => {
    const b = makeOrder({ id: "order-b", businessId: "biz-cake" });
    const a = makeOrder({ id: "order-a", businessId: "biz-rb" });
    const { deps, store } = makeHarness([a, b], [RB_BUSINESS, TENANT_ON]);
    await handleOrderConfirmed("order-b", deps);
    const doc = store.courierDoc(courierOrderIdFor("order-b"))!;
    store.docs.set(`${COURIER_ORDERS_COLLECTION}/${courierOrderIdFor("order-b")}`, {
      ...doc,
      status: "delivered",
      riderId: "rider-secret",
    });
    a.courierBooking = {
      state: "booked",
      courierOrderId: courierOrderIdFor("order-b"),
      updatedAt: "x",
    } as unknown as Order["courierBooking"];
    const st = await getCourierDeliveryStatus("order-a", deps);
    expect(st?.courierOrderId).not.toBe(courierOrderIdFor("order-b"));
    expect(st?.opsStatus).not.toBe("delivered");
  });

  it("cancel then re-confirm REVIVES the booking in place (never booked-over-cancelled)", async () => {
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    await handleOrderConfirmed("order-1", deps);
    await handleOrderCancelled("order-1", deps);
    expect(store.courierDoc(CID)!.status).toBe("cancelled");
    order.status = "confirmed";
    const out = await handleOrderConfirmed("order-1", deps);
    expect(out.state).toBe("booked");
    expect(store.courierDoc(CID)!.status).toBe("pending_rider_assignment");
    expect(store.queueDoc(CID)!.dispatchStatus).toBe("ready_for_dispatch");
    expect(readLinkState(order)).toBe("booked");
  });

  it("a foreign doc squatting at agent_<id> is a collision, never adopted", async () => {
    const order = makeOrder();
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    store.docs.set(`${COURIER_ORDERS_COLLECTION}/${CID}`, {
      status: "pending_rider_assignment",
      customerId: "attacker-ops-uid",
      total_amount: 1,
      source: "customer_app",
    });
    const out = await handleOrderConfirmed("order-1", deps);
    expect(out.state).toBe("failed");
    expect(readLinkState(order)).toBe("failed");
    expect(store.queueDoc(CID)).toBeUndefined();
  });

  it("an order id with a path separator fails closed", async () => {
    const order = makeOrder({ id: "a/b" });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const out = await handleOrderConfirmed("a/b", deps);
    expect(out.state).toBe("failed");
    expect(store.size).toBe(0);
  });

  it("zero-width padding cannot inflate a short address past the needs-info gate", async () => {
    const order = makeOrder({
      customFields: {
        customer_name: "Rahim",
        phone: "01712345678",
        delivery_address: "ab" + "\u200B".repeat(10),
      },
    });
    const { deps, store } = makeHarness([order], [RB_BUSINESS]);
    const out = await handleOrderConfirmed("order-1", deps);
    expect(out.state).toBe("needs_info");
    expect(store.size).toBe(0);
  });
});
