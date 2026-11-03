/**
 * TEAM J wiring tests (2026-11-03). Pure modules + the stock-movement
 * wiring contract only. Nothing here touches Firestore, the network,
 * or a live browser — the prisma-backed stock adapter itself is
 * therefore NOT covered here (it needs a Firestore emulator/staging
 * run; see the Team J report) and is labelled UNVERIFIED live.
 */
import { describe, it, expect } from "vitest";
import {
  decideFollowUpOwnerGate,
  followUpControlScope,
  ownerRecordFromFollowUp,
} from "@/lib/followup-owner-gate";
import {
  decideCourierSuggestion,
  courierSuggestionForOrder,
} from "@/lib/courier-suggestion";
import {
  ledgerTypeFor,
  directionFor,
} from "@/lib/inventory/stock-store-adapter";
import {
  applyCancelMovement,
  applyConfirmMovement,
  type StockLevel,
  type StockMovement,
  type StockMovementMarker,
  type StockStore,
  type StockTx,
} from "@/lib/inventory/stock-movements";

const NOW = Date.now();
const BIZ = "biz-1";

function controls(patch: Record<string, unknown>) {
  // Raw settings-doc shape; the gate normalises it.
  return patch as never;
}

function record(over: Record<string, unknown> = {}) {
  return {
    id: "fu-1",
    message: "Hello",
    ownerPaused: null,
    ownerPausedUntil: null,
    slot: null,
    ...over,
  };
}

function gateInput(over: Record<string, unknown> = {}) {
  return {
    businessId: BIZ,
    controlBusinessId: BIZ,
    controls: null,
    channelControls: {},
    channel: "whatsapp",
    docError: false,
    record: record(),
    kind: "warm_followup",
    slot: null,
    nowMs: NOW,
    ...over,
  } as Parameters<typeof decideFollowUpOwnerGate>[0];
}

describe("followUpControlScope", () => {
  it("maps follow-up kinds, reminder slots, and review asks", () => {
    expect(followUpControlScope("warm_followup", null)).toEqual({
      family: "followups",
      scope: "warm_followup",
    });
    expect(followUpControlScope("order_checkin", null)).toEqual({
      family: "followups",
      scope: "order_checkin",
    });
    expect(followUpControlScope("booking_reminder", "day_before")).toEqual({
      family: "reminders",
      scope: "day_before",
    });
    expect(followUpControlScope("order_rating_request", null)).toEqual({
      family: "reviewAsks",
      scope: "rating",
    });
    expect(followUpControlScope("order_review_request", null)).toEqual({
      family: "reviewAsks",
      scope: "delivered",
    });
  });
  it("returns null for kinds no family covers (channel gate only)", () => {
    expect(followUpControlScope("broadcast", null)).toBeNull();
    expect(followUpControlScope("broadcast_test", null)).toBeNull();
    expect(followUpControlScope("order_status_update", null)).toBeNull();
    expect(followUpControlScope(null, null)).toBeNull();
    expect(followUpControlScope("booking_reminder", "bogus_slot")).toBeNull();
  });
});

describe("decideFollowUpOwnerGate", () => {
  it("sends when no controls exist (existing tenants unchanged)", () => {
    expect(decideFollowUpOwnerGate(gateInput())).toEqual({ send: true });
  });
  it("defers on adapter failure, cross-tenant doc, and channel hold", () => {
    expect(
      decideFollowUpOwnerGate(gateInput({ docError: true }))
    ).toMatchObject({ send: false, reason: "owner_controls_store_unavailable" });
    expect(
      decideFollowUpOwnerGate(gateInput({ controlBusinessId: "biz-2" }))
    ).toMatchObject({ send: false, reason: "cross_tenant" });
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          channelControls: {
            whatsapp: {
              businessId: BIZ,
              channel: "whatsapp",
              mode: "owner",
              changedAtMs: NOW,
              changedBy: null,
              reason: null,
            },
          },
        })
      )
    ).toMatchObject({ send: false, reason: "channel_owner_controlled" });
  });
  it("defers on family disabled, master pause, scope pause, record pause", () => {
    expect(
      decideFollowUpOwnerGate(
        gateInput({ controls: controls({ followups: { enabled: false } }) })
      )
    ).toMatchObject({ send: false, reason: "family_disabled" });
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          controls: controls({
            followups: {
              masterPause: {
                paused: true,
                pausedAt: null,
                pausedUntil: null,
                note: null,
              },
            },
          }),
        })
      )
    ).toMatchObject({ send: false, reason: "master_paused" });
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          controls: controls({
            followups: {
              kinds: {
                warm_followup: {
                  paused: true,
                  pausedAt: null,
                  pausedUntil: null,
                  note: null,
                },
              },
            },
          }),
        })
      )
    ).toMatchObject({ send: false, reason: "scope_paused" });
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          record: record({ ownerPaused: true, ownerPausedUntil: null }),
        })
      )
    ).toMatchObject({ send: false, reason: "record_paused" });
  });
  it("a lapsed timed pause auto-resumes (record sends again)", () => {
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          record: record({
            ownerPaused: true,
            ownerPausedUntil: new Date(NOW - 1000).toISOString(),
          }),
        })
      )
    ).toEqual({ send: true });
  });
  it("a future timed pause still holds", () => {
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          record: record({
            ownerPaused: true,
            ownerPausedUntil: new Date(NOW + 3600_000).toISOString(),
          }),
        })
      )
    ).toMatchObject({ send: false, reason: "record_paused" });
  });
  it("uncovered kinds send on the channel gate alone", () => {
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          kind: "broadcast",
          controls: controls({ followups: { enabled: false } }),
        })
      )
    ).toEqual({ send: true });
  });
  it("templated scopes do not block on a set-but-unrenderable override (block-only)", () => {
    expect(
      decideFollowUpOwnerGate(
        gateInput({
          kind: "booking_reminder",
          slot: "day_before",
          record: record({ slot: "day_before" }),
          controls: controls({
            reminders: { texts: { day_before: "Hi {{bookingDateTime}}" } },
          }),
        })
      )
    ).toEqual({ send: true });
  });
});

describe("ownerRecordFromFollowUp", () => {
  it("reads legacy rows without owner fields as unpaused", () => {
    const view = ownerRecordFromFollowUp({
      id: "fu-9",
      message: "m",
    } as never);
    expect(view.record.ownerPaused).toBe(false);
    expect(view.kind).toBeNull();
    expect(view.slot).toBeNull();
  });
});

describe("decideCourierSuggestion", () => {
  it("served district suggests own courier first + highlighted", () => {
    const s = decideCourierSuggestion({ districtText: "Faridpur" });
    expect(s.path).toBe("own_first");
    expect(s.served).toBe(true);
    expect(s.highlightOwnFirst).toBe(true);
    expect(s.displayMarker).toBeNull();
    expect(s.booksThirdParty).toBe(false);
  });
  it("matches inside longer address text (whole-token rule)", () => {
    expect(
      decideCourierSuggestion({
        deliveryAddress: "House 12, Road 3, Faridpur Sadar",
      }).path
    ).toBe("own_first");
    expect(decideCourierSuggestion({ districtText: "Faridpuria" }).path).toBe(
      "coming_soon_partner"
    );
  });
  it("unserved district is Coming Soon + partner ordering allowed", () => {
    const s = decideCourierSuggestion({ districtText: "Dhaka" });
    expect(s.path).toBe("coming_soon_partner");
    expect(s.displayMarker).toBe("Coming Soon");
    expect(s.partnerOrderingAllowed).toBe(true);
    expect(s.booksThirdParty).toBe(false);
  });
  it("no district means pending for the shop", () => {
    const s = decideCourierSuggestion({ districtText: "" });
    expect(s.path).toBe("pending_for_shop");
    expect(s.needsDistrict).toBe(true);
    expect(s.partnerOrderingAllowed).toBe(false);
  });
  it("a served customer choice of partner is honoured, never forced", () => {
    const s = decideCourierSuggestion({
      districtText: "Faridpur",
      customerChoice: "partner",
    });
    expect(s.path).toBe("customer_choice_partner");
    expect(s.customerChoiceHonoured).toBe(true);
  });
  it("an unserved choice of own cannot be honoured into a booking", () => {
    const s = decideCourierSuggestion({
      districtText: "Dhaka",
      customerChoice: "own",
    });
    expect(s.path).toBe("coming_soon_partner");
    expect(s.customerChoiceHonoured).toBe(false);
    expect(s.booksThirdParty).toBe(false);
  });
  it("order records use the bridge's district extraction", () => {
    expect(
      courierSuggestionForOrder({
        customFields: { delivery_address: "Faridpur Sadar" },
      }).path
    ).toBe("own_first");
    expect(
      courierSuggestionForOrder({ customFields: { notes: "no district" } })
        .path
    ).toBe("pending_for_shop");
  });
});

describe("stock adapter ledger mapping", () => {
  it("maps kinds and directions to Leg A vocabulary", () => {
    expect(ledgerTypeFor("confirm")).toBe("sales_out");
    expect(ledgerTypeFor("cancel")).toBe("adjustment");
    expect(ledgerTypeFor("return")).toBe("return_in");
    expect(ledgerTypeFor("adjustment")).toBe("adjustment");
    const base = {
      ledgerId: "x",
      orderId: "o",
      businessId: BIZ,
      key: "p1",
      productId: "p1",
      variantId: null,
      deltaDamaged: 0,
      deltaMissing: 0,
      at: new Date().toISOString(),
    };
    expect(directionFor({ ...base, kind: "confirm", deltaOnHand: -2 })).toBe(
      "out"
    );
    expect(directionFor({ ...base, kind: "cancel", deltaOnHand: 2 })).toBe(
      "in"
    );
    expect(directionFor({ ...base, kind: "return", deltaOnHand: 1 })).toBe(
      "in"
    );
  });
});

/** In-memory StockStore: the exact contract setOrderStatus now calls. */
function memoryStore(order: {
  id: string;
  businessId: string;
  status: string;
  items: Array<{ productId?: string | null; name: string; qty: number }>;
  marker?: StockMovementMarker;
}): { store: StockStore; levels: Map<string, StockLevel>; movements: StockMovement[]; marker: () => StockMovementMarker } {
  const levels = new Map<string, StockLevel>();
  const movements: StockMovement[] = [];
  let marker: StockMovementMarker = order.marker ?? {};
  const live = { ...order };
  const store: StockStore = {
    async runTransaction<T>(fn: (tx: StockTx) => T | Promise<T>): Promise<T> {
      const tx: StockTx = {
        async getOrder() {
          return {
            id: live.id,
            businessId: live.businessId,
            status: live.status,
            items: live.items,
            stockMovements: marker,
          };
        },
        async getStock(key: string) {
          return levels.get(key);
        },
        async setStock(level: StockLevel) {
          levels.set(
            `${level.productId}${level.variantId ? `:${level.variantId}` : ""}`,
            level
          );
        },
        async setOrderMarker(m: StockMovementMarker) {
          marker = m;
        },
        async writeMovement(m: StockMovement) {
          movements.push(m);
        },
        async ledgerExists(ledgerId: string) {
          return movements.some((m) => m.ledgerId === ledgerId);
        },
      };
      return fn(tx);
    },
  };
  return { store, levels, movements, marker: () => marker };
}

describe("setOrderStatus wiring contract (confirm/cancel)", () => {
  it("confirm decrements tracked lines and skips untracked ones", async () => {
    const { store, levels } = memoryStore({
      id: "o1",
      businessId: BIZ,
      status: "pending",
      items: [
        { productId: "cake", name: "Cake", qty: 2 },
        { productId: "ghost", name: "Ghost", qty: 1 },
      ],
    });
    levels.set("cake", {
      businessId: BIZ,
      productId: "cake",
      variantId: null,
      onHand: 5,
      damaged: 0,
      missing: 0,
    });
    const r = await applyConfirmMovement(store, {
      missingStock: "skip",
      transition: { from: "pending", to: "confirmed" },
    });
    expect(r.applied).toBe(true);
    expect(levels.get("cake")?.onHand).toBe(3);
    expect(r.skipped.map((s) => s.reason)).toContain("untracked_stock");
  });
  it("confirm is idempotent on re-affirm (marker blocks a second decrement)", async () => {
    const { store, levels, marker } = memoryStore({
      id: "o2",
      businessId: BIZ,
      status: "confirmed",
      items: [{ productId: "cake", name: "Cake", qty: 2 }],
      marker: { confirm: { at: new Date().toISOString() } },
    });
    levels.set("cake", {
      businessId: BIZ,
      productId: "cake",
      variantId: null,
      onHand: 3,
      damaged: 0,
      missing: 0,
    });
    const r = await applyConfirmMovement(store, {
      missingStock: "skip",
      transition: { from: "confirmed", to: "confirmed" },
    });
    expect(r.alreadyProcessed).toBe(true);
    expect(levels.get("cake")?.onHand).toBe(3);
    expect(marker().confirm).toBeDefined();
  });
  it("cancel after confirm restocks exactly what confirm decremented", async () => {
    const ctx = memoryStore({
      id: "o3",
      businessId: BIZ,
      status: "pending",
      items: [{ productId: "cake", name: "Cake", qty: 2 }],
    });
    ctx.levels.set("cake", {
      businessId: BIZ,
      productId: "cake",
      variantId: null,
      onHand: 5,
      damaged: 0,
      missing: 0,
    });
    await applyConfirmMovement(ctx.store, {
      missingStock: "skip",
      transition: { from: "pending", to: "confirmed" },
    });
    expect(ctx.levels.get("cake")?.onHand).toBe(3);
    // Status flips to confirmed in the real flow; mirror it here.
    const confirmed = memoryStore({
      id: "o3",
      businessId: BIZ,
      status: "confirmed",
      items: [{ productId: "cake", name: "Cake", qty: 2 }],
      marker: ctx.marker(),
    });
    confirmed.levels.set("cake", {
      businessId: BIZ,
      productId: "cake",
      variantId: null,
      onHand: 3,
      damaged: 0,
      missing: 0,
    });
    const r = await applyCancelMovement(confirmed.store, {
      missingStock: "skip",
      reason: "customer cancelled",
      transition: { from: "confirmed", to: "cancelled" },
    });
    expect(r.applied).toBe(true);
    expect(confirmed.levels.get("cake")?.onHand).toBe(5);
    expect(confirmed.marker().cancel).toEqual({
      at: expect.any(String),
      restocked: true,
    });
  });
  it("cancel of a pending order moves nothing but marks the cancel", async () => {
    const ctx = memoryStore({
      id: "o4",
      businessId: BIZ,
      status: "pending",
      items: [{ productId: "cake", name: "Cake", qty: 2 }],
    });
    ctx.levels.set("cake", {
      businessId: BIZ,
      productId: "cake",
      variantId: null,
      onHand: 5,
      damaged: 0,
      missing: 0,
    });
    const r = await applyCancelMovement(ctx.store, {
      missingStock: "skip",
      transition: { from: "pending", to: "cancelled" },
    });
    expect(r.applied).toBe(false);
    expect(ctx.levels.get("cake")?.onHand).toBe(5);
    expect(ctx.marker().cancel?.restocked).toBe(false);
  });
  it("cancel restock without a team reason refuses (never invented)", async () => {
    const ctx = memoryStore({
      id: "o5",
      businessId: BIZ,
      status: "confirmed",
      items: [{ productId: "cake", name: "Cake", qty: 1 }],
      marker: { confirm: { at: new Date().toISOString() } },
    });
    ctx.levels.set("cake", {
      businessId: BIZ,
      productId: "cake",
      variantId: null,
      onHand: 4,
      damaged: 0,
      missing: 0,
    });
    let caught: unknown = null;
    try {
      await applyCancelMovement(ctx.store, {
        missingStock: "skip",
        transition: { from: "confirmed", to: "cancelled" },
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | null)?.code).toBe("missing_reason");
    expect(ctx.levels.get("cake")?.onHand).toBe(4);
  });
});
