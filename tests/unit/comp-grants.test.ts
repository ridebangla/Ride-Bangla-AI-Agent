/**
 * comp-grants.test.ts — comp/grant build (B1-AI, B2-AI, B5-AI-backend,
 * B6-AI, B4-AI-entry):
 *
 *  B1  manualActiveOverride lifts the message cap.
 *  B2  an active comp makes the business active on the comp plan
 *      (period end = comp.endsAt, auto-expire by comparison), the
 *      message allowance is the COMP plan's, suspended never
 *      resurrects, internal still wins.
 *  B5  targeted offers apply only to listed businessIds and may be
 *      free (percentOff 100 / price 0) for them; global offers are
 *      byte-identical to before.
 *  B6  scopeAllows: a scope that excludes "chat" blocks; no scope
 *      passes; an inactive grant's scope governs nothing.
 *  B4  POST /api/comp-request creates one pending comp_requests doc,
 *      dedupes a second POST, validates plan + note, GET returns the
 *      business's own latest status.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory Firestore fake (hoisted) — backs BOTH the plan catalog reads
// (empty ai_plans/ai_offers → code catalog behaviour) and comp_requests.
// ---------------------------------------------------------------------------
const { fakeDb } = vi.hoisted(() => {
  type DocData = Record<string, unknown>;
  class FakeDocSnapshot {
    constructor(
      readonly id: string,
      private _data: DocData | undefined
    ) {}
    get exists() {
      return this._data !== undefined;
    }
    data() {
      return this._data;
    }
  }
  class FakeQuerySnapshot {
    constructor(readonly docs: FakeDocSnapshot[]) {}
    get empty() {
      return this.docs.length === 0;
    }
    get size() {
      return this.docs.length;
    }
    forEach(fn: (d: FakeDocSnapshot) => void) {
      this.docs.forEach(fn);
    }
  }
  class FakeDocRef {
    constructor(
      private db: FakeDb,
      readonly coll: string,
      readonly id: string
    ) {}
    async get() {
      return new FakeDocSnapshot(this.id, this.db.store.get(this.coll)?.get(this.id));
    }
    async set(data: DocData, opts?: { merge?: boolean }) {
      let m = this.db.store.get(this.coll);
      if (!m) {
        m = new Map();
        this.db.store.set(this.coll, m);
      }
      if (opts?.merge && m.has(this.id)) m.set(this.id, { ...m.get(this.id), ...data });
      else m.set(this.id, { ...data });
    }
  }
  class FakeQuery {
    private filters: Array<{ f: string; v: unknown }> = [];
    constructor(
      private db: FakeDb,
      readonly coll: string
    ) {}
    where(f: string, _op: string, v: unknown) {
      this.filters.push({ f, v });
      return this;
    }
    async get() {
      let docs = [...(this.db.store.get(this.coll)?.entries() ?? [])].map(
        ([id, data]) => new FakeDocSnapshot(id, data)
      );
      for (const { f, v } of this.filters) {
        docs = docs.filter((d) => d.data()?.[f] === v);
      }
      return new FakeQuerySnapshot(docs);
    }
  }
  class FakeCollectionRef {
    constructor(
      private db: FakeDb,
      readonly name: string
    ) {}
    doc(id?: string) {
      return new FakeDocRef(
        this.db,
        this.name,
        id ?? `auto-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      );
    }
    where(f: string, op: string, v: unknown) {
      return new FakeQuery(this.db, this.name).where(f, op, v);
    }
    get() {
      return new FakeQuery(this.db, this.name).get();
    }
  }
  class FakeDb {
    store = new Map<string, Map<string, DocData>>();
    collection(name: string) {
      return new FakeCollectionRef(this, name);
    }
    clear() {
      this.store.clear();
    }
  }
  return { fakeDb: new FakeDb() };
});

vi.mock("@/lib/admin-db", () => ({
  getAdminDb: () => fakeDb,
  __resetAdminDbForTests: () => {},
}));

import {
  isCompActive,
  activeCompPlanId,
  activeCompEndsAt,
  readComp,
  scopeAllows,
} from "@/lib/comp";
import { isSubscriptionActive, getSubscription } from "@/lib/subscription";
import {
  isMessageLimitExceeded,
  checkMessageLimitExceeded,
  buildCountdown,
  type BusinessUsageFields,
} from "@/lib/billing-usage";
import {
  parseOfferDoc,
  offerEffectivePrice,
  bestOfferHit,
  codeCatalog,
  type ParsedOffer,
} from "@/lib/plan-catalog";
import { getUnscopedPrisma } from "@/lib/prisma";
import type { Business } from "@/lib/models";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const past = (d: number) => new Date(NOW - d * DAY);
const future = (d: number) => new Date(NOW + d * DAY);
const PERIOD_START = new Date(NOW - 60 * 60 * 1000);

function comp(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    planId: "growth",
    startsAt: past(1),
    endsAt: future(30),
    reason: "moderator",
    grantedBy: "admin@ridebangla.bd",
    grantedAt: past(1),
    source: "panel",
    snapshot: { exists: true, plan: "trial", subscriptionStatus: "trialing", isActive: true },
    ...partial,
  };
}

function biz(partial: Record<string, unknown>): Business {
  return {
    id: "biz-test",
    name: "Test",
    slug: "test",
    isActive: true,
    ...partial,
  } as unknown as Business;
}

// ---------------------------------------------------------------------------
describe("B1 — manual override lifts the message cap", () => {
  it("override tenant at its plan allowance is NOT limited", () => {
    expect(
      isMessageLimitExceeded({
        subscriptionStatus: "active",
        plan: "starter",
        aiMessagesUsed: 1000, // exactly the starter allowance
        usagePeriodStart: PERIOD_START,
        manualActiveOverride: true,
      })
    ).toBe(false);
    expect(
      isMessageLimitExceeded({
        subscriptionStatus: "active",
        plan: "starter",
        aiMessagesUsed: 999999,
        usagePeriodStart: PERIOD_START,
        manualActiveOverride: true,
      })
    ).toBe(false);
  });

  it("the same tenant WITHOUT the override is still limited", () => {
    expect(
      isMessageLimitExceeded({
        subscriptionStatus: "active",
        plan: "starter",
        aiMessagesUsed: 1000,
        usagePeriodStart: PERIOD_START,
      })
    ).toBe(true);
  });

  it("a string 'true' override does not lift the cap (strict boolean)", () => {
    expect(
      isMessageLimitExceeded({
        subscriptionStatus: "active",
        plan: "starter",
        aiMessagesUsed: 1000,
        usagePeriodStart: PERIOD_START,
        manualActiveOverride: "true",
      })
    ).toBe(true);
  });

  it("checkMessageLimitExceeded honours the override through the DB path", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.business.findUnique.mockResolvedValue({
      id: "biz-test",
      plan: "starter",
      subscriptionStatus: "active",
      aiMessagesUsed: 5000,
      usagePeriodStart: PERIOD_START,
      manualActiveOverride: true,
    });
    expect(await checkMessageLimitExceeded("biz-test")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("B2 — comp activation window (pure)", () => {
  const rec = (c: Record<string, unknown>) => ({ comp: c });

  it("active inside the window, including exactly at startsAt", () => {
    expect(isCompActive(rec(comp()), NOW)).toBe(true);
    expect(isCompActive(rec(comp({ startsAt: new Date(NOW) })), NOW)).toBe(true);
  });

  it("not active before startsAt (not yet started)", () => {
    expect(isCompActive(rec(comp({ startsAt: future(1) })), NOW)).toBe(false);
    expect(activeCompPlanId(rec(comp({ startsAt: future(1) })), NOW)).toBeNull();
  });

  it("not active at or after endsAt (expired, end exclusive)", () => {
    expect(isCompActive(rec(comp({ endsAt: new Date(NOW) })), NOW)).toBe(false);
    expect(isCompActive(rec(comp({ endsAt: past(1) })), NOW)).toBe(false);
  });

  it("active:false, missing dates, or a string 'true' are never active", () => {
    expect(isCompActive(rec(comp({ active: false })), NOW)).toBe(false);
    expect(isCompActive(rec(comp({ active: "true" })), NOW)).toBe(false);
    expect(isCompActive(rec(comp({ startsAt: undefined })), NOW)).toBe(false);
    expect(isCompActive(rec(comp({ endsAt: null })), NOW)).toBe(false);
    expect(isCompActive({}, NOW)).toBe(false);
    expect(isCompActive(null, NOW)).toBe(false);
  });

  it("Firestore-Timestamp-shaped bounds are honoured", () => {
    const ts = (d: Date) => ({ toDate: () => d });
    expect(
      isCompActive(rec(comp({ startsAt: ts(past(2)), endsAt: ts(future(2)) })), NOW)
    ).toBe(true);
  });

  it("readComp / activeCompPlanId / activeCompEndsAt expose the grant", () => {
    const r = rec(comp());
    expect(activeCompPlanId(r, NOW)).toBe("growth");
    expect(activeCompEndsAt(r, NOW)?.getTime()).toBe(future(30).getTime());
    const parsed = readComp(r);
    expect(parsed?.planId).toBe("growth");
    expect(parsed?.source).toBe("panel");
    expect(parsed?.grantedBy).toBe("admin@ridebangla.bd");
  });
});

// ---------------------------------------------------------------------------
describe("B2 — comp in the subscription gate", () => {
  it("an active comp activates a past_due business", () => {
    expect(
      isSubscriptionActive(
        biz({ plan: "starter", subscriptionStatus: "past_due", comp: comp() })
      )
    ).toBe(true);
  });

  it("an active comp activates a canceled / expired business", () => {
    for (const subscriptionStatus of ["canceled", "expired"]) {
      expect(
        isSubscriptionActive(biz({ plan: "starter", subscriptionStatus, comp: comp() }))
      ).toBe(true);
    }
  });

  it("an expired comp does not activate", () => {
    expect(
      isSubscriptionActive(
        biz({
          plan: "starter",
          subscriptionStatus: "past_due",
          comp: comp({ endsAt: past(1) }),
        })
      )
    ).toBe(false);
  });

  it("a not-yet-started comp does not activate", () => {
    expect(
      isSubscriptionActive(
        biz({
          plan: "starter",
          subscriptionStatus: "past_due",
          comp: comp({ startsAt: future(2), endsAt: future(30) }),
        })
      )
    ).toBe(false);
  });

  it("a comp never resurrects a suspended account", () => {
    expect(
      isSubscriptionActive(
        biz({ plan: "growth", subscriptionStatus: "suspended", comp: comp() })
      )
    ).toBe(false);
  });

  it("a comp never resurrects a deactivated account (isActive kill-switch)", () => {
    expect(
      isSubscriptionActive(
        biz({ isActive: false, plan: "growth", subscriptionStatus: "active", comp: comp() })
      )
    ).toBe(false);
  });

  it("a comp is honoured even when the mirrored active period has lapsed (belt-and-braces)", () => {
    expect(
      isSubscriptionActive(
        biz({
          plan: "growth",
          subscriptionStatus: "active",
          subscriptionEndsAt: past(3),
          comp: comp(),
        })
      )
    ).toBe(true);
  });

  it("getSubscription reports the comp plan, period end = comp.endsAt, isComp", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    const ends = future(30);
    db.business.findUnique.mockResolvedValue(
      biz({
        plan: "trial",
        subscriptionStatus: "trialing",
        trialEndsAt: past(2),
        comp: comp({ endsAt: ends }),
      })
    );
    const sub = await getSubscription("biz-test");
    expect(sub.plan).toBe("growth");
    expect(sub.subscriptionStatus).toBe("active");
    expect(sub.isActive).toBe(true);
    expect(sub.isComp).toBe(true);
    expect(sub.isFreeTier).toBe(false);
    expect(sub.compEndsAt?.getTime()).toBe(ends.getTime());
    expect(sub.scopeAllowsChat).toBe(true);
  });

  it("internal still wins over comp in getSubscription", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.business.findUnique.mockResolvedValue(
      biz({ isInternalAccount: true, plan: "trial", subscriptionStatus: "trialing", comp: comp() })
    );
    const sub = await getSubscription("biz-test");
    expect(sub.plan).toBe("internal");
    expect(sub.isInternal).toBe(true);
    expect(sub.isComp).toBe(false);
  });

  it("getSubscription for a suspended business with a comp stays inactive", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.business.findUnique.mockResolvedValue(
      biz({ plan: "growth", subscriptionStatus: "suspended", comp: comp() })
    );
    const sub = await getSubscription("biz-test");
    expect(sub.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("B2 — comp plan allowance at the message cap", () => {
  const usage = (partial: Record<string, unknown>) => ({
    plan: "starter", // underlying plan allowance: 1000
    subscriptionStatus: "active",
    subscriptionEndsAt: future(10),
    usagePeriodStart: PERIOD_START,
    comp: comp(), // comp plan: growth, allowance 5000
    ...partial,
  });

  it("usage above the underlying plan but below the comp plan passes", () => {
    expect(isMessageLimitExceeded(usage({ aiMessagesUsed: 1500 }), NOW)).toBe(false);
    expect(isMessageLimitExceeded(usage({ aiMessagesUsed: 4999 }), NOW)).toBe(false);
  });

  it("usage at the comp plan allowance blocks", () => {
    expect(isMessageLimitExceeded(usage({ aiMessagesUsed: 5000 }), NOW)).toBe(true);
  });

  it("an expired comp falls back to the underlying plan allowance", () => {
    expect(
      isMessageLimitExceeded(
        usage({ aiMessagesUsed: 1500, comp: comp({ endsAt: past(1) }) }),
        NOW
      )
    ).toBe(true);
  });

  it("a catalog limitOverride for the comp plan is honoured", () => {
    // Panel raised growth to 9000: 5000 no longer blocks.
    expect(isMessageLimitExceeded(usage({ aiMessagesUsed: 5000 }), NOW, 9000)).toBe(false);
    expect(isMessageLimitExceeded(usage({ aiMessagesUsed: 9000 }), NOW, 9000)).toBe(true);
  });

  it("checkMessageLimitExceeded resolves the comp plan through the DB path", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.business.findUnique.mockResolvedValue({
      id: "biz-test",
      plan: "starter",
      subscriptionStatus: "active",
      aiMessagesUsed: 1500,
      usagePeriodStart: PERIOD_START,
      comp: comp(),
    });
    expect(await checkMessageLimitExceeded("biz-test")).toBe(false);
    db.business.findUnique.mockResolvedValue({
      id: "biz-test",
      plan: "starter",
      subscriptionStatus: "active",
      aiMessagesUsed: 5000,
      usagePeriodStart: PERIOD_START,
      comp: comp(),
    });
    expect(await checkMessageLimitExceeded("biz-test")).toBe(true);
  });

  it("countdown under a comp reports the comp plan + its allowance + comp end", () => {
    const cd = buildCountdown(
      usage({ aiMessagesUsed: 1500 }) as BusinessUsageFields & {
        usagePeriodStart?: unknown;
      },
      NOW
    );
    expect(cd.plan).toBe("growth");
    expect(cd.messagesLimit).toBe(5000);
    expect(cd.messagesRemaining).toBe(3500);
    expect(cd.subscriptionEndsAt?.getTime()).toBe(future(30).getTime());
  });
});

// ---------------------------------------------------------------------------
describe("B6 — feature scoping at the gate helper", () => {
  it("a scoped comp without 'chat' blocks chat", () => {
    expect(scopeAllows({ comp: comp({ scope: { features: ["tools"] } }) }, "chat", NOW)).toBe(false);
    expect(scopeAllows({ comp: comp({ scope: { features: [] } }) }, "chat", NOW)).toBe(false);
  });

  it("a scoped comp with 'chat' allows chat", () => {
    expect(
      scopeAllows({ comp: comp({ scope: { features: ["chat"] } }) }, "chat", NOW)
    ).toBe(true);
  });

  it("an unscoped comp allows chat", () => {
    expect(scopeAllows({ comp: comp() }, "chat", NOW)).toBe(true);
    expect(scopeAllows({ comp: comp({ scope: {} }) }, "chat", NOW)).toBe(true);
  });

  it("an expired comp's scope governs nothing", () => {
    expect(
      scopeAllows(
        { comp: comp({ endsAt: past(1), scope: { features: [] } }) },
        "chat",
        NOW
      )
    ).toBe(true);
  });

  it("an internal record's grantScope can exclude chat (both shapes)", () => {
    expect(
      scopeAllows({ isInternalAccount: true, grantScope: { features: [] } }, "chat", NOW)
    ).toBe(false);
    expect(
      scopeAllows({ isInternalAccount: true, grantScope: { chat: false } }, "chat", NOW)
    ).toBe(false);
    expect(
      scopeAllows({ isInternalAccount: true, grantScope: { chat: true } }, "chat", NOW)
    ).toBe(true);
    expect(scopeAllows({ isInternalAccount: true }, "chat", NOW)).toBe(true);
  });

  it("unscoped / ordinary records always allow chat", () => {
    expect(scopeAllows({}, "chat", NOW)).toBe(true);
    expect(scopeAllows(null, "chat", NOW)).toBe(true);
    expect(
      scopeAllows({ plan: "starter", subscriptionStatus: "active" }, "chat", NOW)
    ).toBe(true);
  });

  it("getSubscription surfaces scopeAllowsChat=false for a chat-less comp", async () => {
    const db = getUnscopedPrisma() as unknown as {
      business: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.business.findUnique.mockResolvedValue(
      biz({
        plan: "trial",
        subscriptionStatus: "trialing",
        trialEndsAt: past(2),
        comp: comp({ scope: { features: [] } }),
      })
    );
    const sub = await getSubscription("biz-test");
    expect(sub.isActive).toBe(true);
    expect(sub.isComp).toBe(true);
    expect(sub.scopeAllowsChat).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("B5 — targeted offers", () => {
  const starter = codeCatalog().find((p) => p.id === "starter")!;
  const now = new Date("2026-06-01T00:00:00Z");
  const baseDoc = {
    name: "Targeted",
    planId: "starter",
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-12-31T00:00:00.000Z",
  };

  it("a targeted percentOff=100 offer parses and yields 0 for the listed business only", () => {
    const offer = parseOfferDoc("t1", {
      ...baseDoc,
      percentOff: 100,
      targetAccountIds: ["biz-a"],
    });
    expect(offer).not.toBeNull();
    expect(offer!.percentOff).toBe(100);
    expect(offer!.targetAccountIds).toEqual(["biz-a"]);
    expect(offerEffectivePrice(starter, offer!, "monthly")).toBe(0);

    const hitA = bestOfferHit(starter, [offer!], "monthly", now, "biz-a");
    expect(hitA?.effectivePriceUsd).toBe(0);
    expect(bestOfferHit(starter, [offer!], "monthly", now, "biz-b")).toBeNull();
    expect(bestOfferHit(starter, [offer!], "monthly", now)).toBeNull();
    expect(bestOfferHit(starter, [offer!], "monthly", now, null)).toBeNull();
  });

  it("a targeted fixed price of 0 is honoured for the listed business only", () => {
    const offer = parseOfferDoc("t2", {
      ...baseDoc,
      offerPriceMonthlyUsd: 0,
      targetAccountIds: ["biz-a", "biz-c"],
    });
    expect(offer!.offerPriceMonthlyUsd).toBe(0);
    expect(bestOfferHit(starter, [offer!], "monthly", now, "biz-c")?.effectivePriceUsd).toBe(0);
    expect(bestOfferHit(starter, [offer!], "monthly", now, "biz-b")).toBeNull();
  });

  it("a targeted percent offer applies to the listed business and not others", () => {
    const offer = parseOfferDoc("t3", {
      ...baseDoc,
      percentOff: 50,
      targetAccountIds: ["biz-a"],
    }) as ParsedOffer;
    expect(bestOfferHit(starter, [offer], "monthly", now, "biz-a")?.effectivePriceUsd).toBe(9.5);
    expect(bestOfferHit(starter, [offer], "monthly", now, "biz-b")).toBeNull();
  });

  it("a targeted free offer beats a global discount for the listed business", () => {
    const global = parseOfferDoc("g1", { ...baseDoc, percentOff: 10 })!;
    const targeted = parseOfferDoc("t4", {
      ...baseDoc,
      percentOff: 100,
      targetAccountIds: ["biz-a"],
    })!;
    expect(
      bestOfferHit(starter, [global, targeted], "monthly", now, "biz-a")?.effectivePriceUsd
    ).toBe(0);
    expect(
      bestOfferHit(starter, [global, targeted], "monthly", now, "biz-b")?.effectivePriceUsd
    ).toBe(17.1);
  });

  it("global offers are unchanged: percentOff 100 / price 0 stay invalid, normal offers apply to everyone", () => {
    const badPercent = parseOfferDoc("g2", { ...baseDoc, percentOff: 100 });
    expect(badPercent!.percentOff).toBeNull();
    expect(bestOfferHit(starter, [badPercent!], "monthly", now, "biz-a")).toBeNull();

    const badPrice = parseOfferDoc("g3", { ...baseDoc, offerPriceMonthlyUsd: 0 });
    expect(badPrice!.offerPriceMonthlyUsd).toBeNull();

    const normal = parseOfferDoc("g4", { ...baseDoc, percentOff: 25 })!;
    expect(normal.targetAccountIds).toEqual([]);
    for (const id of [undefined, null, "biz-a", "biz-b"] as const) {
      expect(
        bestOfferHit(starter, [normal], "monthly", now, id)?.effectivePriceUsd
      ).toBe(14.25);
    }
    // An empty target list is global too.
    const emptyTargets = parseOfferDoc("g5", {
      ...baseDoc,
      percentOff: 25,
      targetAccountIds: [],
    })!;
    expect(
      bestOfferHit(starter, [emptyTargets], "monthly", now, "biz-b")?.effectivePriceUsd
    ).toBe(14.25);
  });
});

// ---------------------------------------------------------------------------
describe("B4 — comp-request entry point", () => {
  beforeEach(() => {
    fakeDb.clear();
    vi.clearAllMocks();
  });

  async function callRoute() {
    const mod = await import("@/app/api/comp-request/route");
    const { createRequest } = await import("../helpers/request");
    return { mod, createRequest };
  }

  it("POST creates one pending comp_requests doc with the canonical shape", async () => {
    const { mod, createRequest } = await callRoute();
    const res = await mod.POST(
      createRequest("http://localhost:3000/api/comp-request", {
        method: "POST",
        body: { requestedPlanId: "growth", note: "moderator team" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.request.status).toBe("pending");
    expect(json.request.requestedPlanId).toBe("growth");

    const snap = await fakeDb.collection("comp_requests").get();
    expect(snap.size).toBe(1);
    const data = snap.docs[0].data()!;
    expect(data.platform).toBe("ai");
    expect(data.accountId).toBe("test-business");
    expect(data.status).toBe("pending");
    expect(data.requestedPlanId).toBe("growth");
    expect(data.note).toBe("moderator team");
    expect(data.createdAt).toBeTruthy();
  });

  it("a second POST returns the pending request instead of creating another", async () => {
    const { mod, createRequest } = await callRoute();
    const first = await mod.POST(
      createRequest("http://localhost:3000/api/comp-request", {
        method: "POST",
        body: {},
      })
    );
    const firstJson = await first.json();
    const second = await mod.POST(
      createRequest("http://localhost:3000/api/comp-request", {
        method: "POST",
        body: { requestedPlanId: "pro" },
      })
    );
    const secondJson = await second.json();
    expect(secondJson.request.id).toBe(firstJson.request.id);
    const snap = await fakeDb.collection("comp_requests").get();
    expect(snap.size).toBe(1);
  });

  it("POST rejects an unknown plan and an over-long note", async () => {
    const { mod, createRequest } = await callRoute();
    const badPlan = await mod.POST(
      createRequest("http://localhost:3000/api/comp-request", {
        method: "POST",
        body: { requestedPlanId: "no-such-plan" },
      })
    );
    expect(badPlan.status).toBe(400);
    expect((await badPlan.json()).error).toBe("invalid_plan");

    const longNote = await mod.POST(
      createRequest("http://localhost:3000/api/comp-request", {
        method: "POST",
        body: { note: "x".repeat(501) },
      })
    );
    expect(longNote.status).toBe(400);
    expect((await longNote.json()).error).toBe("note_too_long");
    expect((await fakeDb.collection("comp_requests").get()).size).toBe(0);
  });

  it("GET returns the business's own latest request status, null when none", async () => {
    const { mod, createRequest } = await callRoute();
    const empty = await mod.GET(
      createRequest("http://localhost:3000/api/comp-request", { method: "GET" })
    );
    expect((await empty.json()).request).toBeNull();

    await fakeDb.collection("comp_requests").doc("req-1").set({
      platform: "ai",
      accountId: "test-business",
      accountEmail: "",
      accountName: "Test",
      status: "rejected",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    await fakeDb.collection("comp_requests").doc("req-other").set({
      platform: "ai",
      accountId: "someone-else",
      status: "pending",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    const res = await mod.GET(
      createRequest("http://localhost:3000/api/comp-request", { method: "GET" })
    );
    const json = await res.json();
    expect(json.request.id).toBe("req-1");
    expect(json.request.status).toBe("rejected");
  });
});
