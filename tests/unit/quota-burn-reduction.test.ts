/**
 * quota-burn-reduction.test.ts — Q-QUOTA (Round 4, 2026-10-23).
 *
 * Covers the read-burn fixes for audit ranks 1–4, 7, 8:
 *  - pure prefilter helpers (selective FK/token fields beat businessId;
 *    equality flattening rejects anything non-equality),
 *  - the REAL Firestore data layer against an in-memory fake Admin SDK
 *    (immutable queries, like the real SDK): selective prefiltering,
 *    server-side order+limit pushdown + missing-index fallback,
 *    count() aggregation, settings/knowledge hot caches with write
 *    invalidation, include/_count fetch dedupe, taxonomy doc cache,
 *  - the tenant siteKey cache (positive-only, 60 s),
 *  - the batched /api/conversations list enrichment (same shape),
 *  - the reviews GET payload cache (non-empty only, POST-invalidated),
 *  - the catalog brief cache,
 *  - the widget embed's adaptive polling (source-shape assertions).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import {
  pickSelectivePrefilter,
  flattenEqualityConditions,
} from "@/lib/firestore-query";

// ---------------------------------------------------------------------------
// In-memory firebase-admin fake (hoisted) — immutable queries, read metering
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  type DocData = Record<string, unknown>;

  class FakeTimestamp {
    constructor(private ms: number) {}
    toDate() {
      return new Date(this.ms);
    }
    toMillis() {
      return this.ms;
    }
    static fromDate(d: Date) {
      return new FakeTimestamp(d.getTime());
    }
  }

  const norm = (x: unknown) =>
    x instanceof FakeTimestamp ? x.toMillis() : x instanceof Date ? x.getTime() : x;

  class FakeSnapshot {
    constructor(
      readonly id: string,
      private _data: DocData | undefined
    ) {}
    get exists() {
      return this._data !== undefined;
    }
    data() {
      return this._data ? { ...this._data } : undefined;
    }
  }

  class FakeQuerySnapshot {
    constructor(readonly docs: FakeSnapshot[]) {}
    get empty() {
      return this.docs.length === 0;
    }
    get size() {
      return this.docs.length;
    }
    forEach(fn: (d: FakeSnapshot) => void) {
      this.docs.forEach(fn);
    }
  }

  const store = new Map<string, Map<string, DocData>>();
  let autoId = 0;

  const meter = {
    queryGets: [] as Array<{
      coll: string;
      filters: Array<{ f: string; v: unknown }>;
      orderBy: { f: string; dir: string } | null;
      limit: number | null;
      returned: number;
    }>,
    docGets: [] as Array<{ coll: string; id: string }>,
    aggCounts: [] as Array<{ coll: string; filters: Array<{ f: string; v: unknown }> }>,
    failOrdered: false,
    reset() {
      this.queryGets = [];
      this.docGets = [];
      this.aggCounts = [];
      this.failOrdered = false;
    },
  };

  class FakeDocRef {
    constructor(
      readonly coll: string,
      readonly id: string
    ) {}
    private map(create = false) {
      let m = store.get(this.coll);
      if (!m && create) {
        m = new Map();
        store.set(this.coll, m);
      }
      return m;
    }
    async get() {
      meter.docGets.push({ coll: this.coll, id: this.id });
      return new FakeSnapshot(this.id, this.map()?.get(this.id));
    }
    _set(data: DocData) {
      this.map(true)!.set(this.id, { ...data });
    }
    _update(data: DocData) {
      const m = this.map(true)!;
      m.set(this.id, { ...(m.get(this.id) ?? {}), ...data });
    }
    _delete() {
      this.map()?.delete(this.id);
    }
  }

  class FakeQuery {
    constructor(
      readonly coll: string,
      protected filters: Array<{ f: string; v: unknown }> = [],
      protected order: { f: string; dir: string } | null = null,
      protected lim: number | null = null
    ) {}
    where(f: string, _op: string, v: unknown) {
      return new FakeQuery(this.coll, [...this.filters, { f, v }], this.order, this.lim);
    }
    orderBy(f: string, dir: string) {
      return new FakeQuery(this.coll, this.filters, { f, dir }, this.lim);
    }
    limit(n: number) {
      return new FakeQuery(this.coll, this.filters, this.order, n);
    }
    protected filteredDocs(): FakeSnapshot[] {
      const m = store.get(this.coll);
      let docs = [...(m?.entries() ?? [])].map(
        ([id, data]) => new FakeSnapshot(id, data)
      );
      for (const { f, v } of this.filters) {
        docs = docs.filter((d) => norm((d.data() as DocData | undefined)?.[f]) === norm(v));
      }
      return docs;
    }
    async get() {
      if (this.order && meter.failOrdered) {
        throw new Error("FAILED_PRECONDITION: The query requires an index.");
      }
      let docs = this.filteredDocs();
      if (this.order) {
        const { f, dir } = this.order;
        docs = [...docs].sort((a, b) => {
          const av = norm((a.data() as DocData)[f]) as number;
          const bv = norm((b.data() as DocData)[f]) as number;
          return dir === "desc" ? bv - av : av - bv;
        });
      }
      if (this.lim !== null) docs = docs.slice(0, this.lim);
      meter.queryGets.push({
        coll: this.coll,
        filters: this.filters,
        orderBy: this.order,
        limit: this.lim,
        returned: docs.length,
      });
      return new FakeQuerySnapshot(docs);
    }
    count() {
      const { coll, filters } = this;
      const docs = () => this.filteredDocs();
      return {
        get: async () => {
          meter.aggCounts.push({ coll, filters });
          return { data: () => ({ count: docs().length }) };
        },
      };
    }
  }

  class FakeCollection extends FakeQuery {
    doc(id?: string) {
      return new FakeDocRef(this.coll, id ?? `auto-${++autoId}`);
    }
    async add(data: DocData) {
      const ref = this.doc();
      ref._set(data);
      return ref;
    }
  }

  const fakeTx = {
    get: (ref: FakeDocRef | FakeQuery) => ref.get(),
    set: (ref: FakeDocRef, data: DocData) => ref._set(data),
    update: (ref: FakeDocRef, data: DocData) => ref._update(data),
    delete: (ref: FakeDocRef) => ref._delete(),
  };

  const fakeDb = {
    collection: (name: string) => new FakeCollection(name),
    runTransaction: async <T>(fn: (tx: typeof fakeTx) => Promise<T>) => fn(fakeTx),
  };

  const verifyIdToken = vi.fn();

  const firestoreFn = Object.assign((_app: unknown) => fakeDb, {
    FieldValue: {
      serverTimestamp: () => new Date(),
      delete: () => ({ __deleteField: true }),
    },
    Timestamp: FakeTimestamp,
  });

  return {
    fakeFirestore: firestoreFn,
    verifyIdToken,
    meter,
    resetFake: () => {
      store.clear();
      autoId = 0;
      meter.reset();
    },
  };
});

vi.mock("firebase-admin", () => ({
  apps: [] as unknown[],
  initializeApp: () => ({}),
  credential: { cert: () => ({}) },
  firestore: hoisted.fakeFirestore,
  auth: () => ({ verifyIdToken: hoisted.verifyIdToken }),
}));

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------
describe("pickSelectivePrefilter / flattenEqualityConditions", () => {
  it("prefers an FK equality over the tenant businessId", () => {
    const where = {
      AND: [{ conversationId: "c-1" }, { businessId: "biz-1" }],
    };
    expect(pickSelectivePrefilter(where)).toEqual({
      field: "conversationId",
      value: "c-1",
    });
  });

  it("prefers uid over site, and activityToken over conversationId", () => {
    expect(pickSelectivePrefilter({ site: "ai", uid: "u-1" })?.field).toBe("uid");
    expect(
      pickSelectivePrefilter({ conversationId: "c-1", activityToken: "at-x" })?.field
    ).toBe("activityToken");
  });

  it("never picks enum/boolean fields (status / isActive are not selective)", () => {
    expect(pickSelectivePrefilter({ status: "active" })).toBeNull();
    expect(pickSelectivePrefilter({ isActive: true })).toBeNull();
    expect(pickSelectivePrefilter({ channel: "widget" })).toBeNull();
  });

  it("flattens equality-only wheres (incl. AND + bare equals)", () => {
    expect(
      flattenEqualityConditions({
        AND: [{ status: "active" }, { businessId: "b" }],
      })
    ).toEqual([
      { field: "status", value: "active" },
      { field: "businessId", value: "b" },
    ]);
    expect(flattenEqualityConditions({ id: { equals: "x" } })).toEqual([
      { field: "id", value: "x" },
    ]);
    expect(flattenEqualityConditions({})).toEqual([]);
    expect(flattenEqualityConditions(undefined)).toEqual([]);
  });

  it("rejects non-equality wheres for server pushdown", () => {
    expect(
      flattenEqualityConditions({ customerName: { contains: "jo", mode: "insensitive" } })
    ).toBeNull();
    expect(flattenEqualityConditions({ OR: [{ status: "a" }] })).toBeNull();
    expect(flattenEqualityConditions({ id: { in: ["a", "b"] } })).toBeNull();
    expect(flattenEqualityConditions({ customerId: null })).toBeNull();
    expect(flattenEqualityConditions({ name: { equals: "x", mode: "insensitive" } })).toBeNull();
    expect(
      flattenEqualityConditions({ messages: { some: { role: "x" } } })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Real data layer against the fake (ranks 1, 2, 3, 4 mechanisms)
// ---------------------------------------------------------------------------
describe("firestore data layer — Q-QUOTA mechanisms", () => {
  const meter = hoisted.meter;

  beforeEach(() => {
    hoisted.resetFake();
    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "fake-key";
  });

  async function seedMessages() {
    const { getUnscopedPrisma } = await import("@/lib/firestore");
    const raw = getUnscopedPrisma();
    // Two businesses; biz-1 has two conversations (5 + 3 messages),
    // biz-2 has one conversation (4 messages) sharing nothing.
    for (let i = 0; i < 5; i++) {
      await raw.message.create({
        data: {
          businessId: "biz-1",
          conversationId: "conv-1",
          role: "customer",
          content: `c1-m${i}`,
          createdAt: new Date(2026, 0, 1, 0, i),
        },
      });
    }
    for (let i = 0; i < 3; i++) {
      await raw.message.create({
        data: {
          businessId: "biz-1",
          conversationId: "conv-2",
          role: "customer",
          content: `c2-m${i}`,
          createdAt: new Date(2026, 0, 2, 0, i),
        },
      });
    }
    for (let i = 0; i < 4; i++) {
      await raw.message.create({
        data: {
          businessId: "biz-2",
          conversationId: "conv-9",
          role: "customer",
          content: `c9-m${i}`,
          createdAt: new Date(2026, 0, 3, 0, i),
        },
      });
    }
    meter.reset();
    return raw;
  }

  it("rank 1/4: a conversationId query prefilters on the FK, not the business", async () => {
    await seedMessages();
    const { runWithBusiness, prisma } = await import("@/lib/firestore");
    const rows = await runWithBusiness("biz-1", () =>
      prisma.message.findMany({ where: { conversationId: "conv-1" } })
    );
    expect(rows).toHaveLength(5);
    const q = meter.queryGets.find((g) => g.coll === "messages");
    expect(q?.filters).toEqual([{ f: "conversationId", v: "conv-1" }]);
    expect(q?.returned).toBe(5); // not biz-1's 8, not all 12
  });

  it("rank 1: thread shape (desc + take 100) is ordered + limited server-side", async () => {
    const raw = await seedMessages();
    void raw;
    const { runWithBusiness, prisma } = await import("@/lib/firestore");
    const rows = await runWithBusiness("biz-1", () =>
      prisma.message.findMany({
        where: { conversationId: "conv-1" },
        orderBy: { createdAt: "desc" },
        take: 2,
      })
    );
    expect(rows.map((r) => r.content)).toEqual(["c1-m4", "c1-m3"]);
    const q = meter.queryGets.find((g) => g.coll === "messages");
    expect(q?.orderBy).toEqual({ f: "createdAt", dir: "desc" });
    expect(q?.limit).toBe(2);
    expect(q?.returned).toBe(2);
  });

  it("rank 1: a missing composite index falls back to the unbounded fetch, same results", async () => {
    await seedMessages();
    const { runWithBusiness, prisma } = await import("@/lib/firestore");
    meter.failOrdered = true;
    const rows = await runWithBusiness("biz-1", () =>
      prisma.message.findMany({
        where: { conversationId: "conv-1" },
        orderBy: { createdAt: "desc" },
        take: 2,
      })
    );
    expect(rows.map((r) => r.content)).toEqual(["c1-m4", "c1-m3"]);
    // The fallback fetch returned the whole conversation (5), then the
    // in-memory sort+slice produced the same top-2.
    const q = meter.queryGets.find((g) => g.coll === "messages");
    expect(q?.returned).toBe(5);
  });

  it("rank 2/3: count() uses aggregation for equality wheres, scan otherwise", async () => {
    await seedMessages();
    const { runWithBusiness, prisma } = await import("@/lib/firestore");
    const active = await runWithBusiness("biz-1", () =>
      prisma.message.count({ where: { conversationId: "conv-1" } })
    );
    expect(active).toBe(5);
    expect(meter.aggCounts).toHaveLength(1);
    expect(meter.queryGets.filter((g) => g.coll === "messages")).toHaveLength(0);

    // A non-equality where cannot aggregate: exact scan fallback.
    const scanned = await runWithBusiness("biz-1", () =>
      prisma.message.count({ where: { content: { contains: "c1-" } } })
    );
    expect(scanned).toBe(5);
    expect(meter.aggCounts).toHaveLength(1); // unchanged
  });

  it("rank 4: settings candidates are fetched once per turn and invalidated on write", async () => {
    const { getUnscopedPrisma, __resetReadCaches } = await import("@/lib/firestore");
    const raw = getUnscopedPrisma();
    await raw.settings.create({
      data: { businessId: "biz-s", businessName: "Shop One" },
    });
    __resetReadCaches();
    meter.reset();

    // The engine's two prep reads (getAIConfig + resolveSiteKeys)
    // run concurrently: the promise cache shares ONE fetch.
    const [a, b] = await Promise.all([
      raw.settings.findFirst({ where: { businessId: "biz-s" } }),
      raw.settings.findFirst({ where: { businessId: "biz-s" } }),
    ]);
    expect(a?.businessName).toBe("Shop One");
    expect(b?.businessName).toBe("Shop One");
    expect(
      meter.queryGets.filter((g) => g.coll === "settings")
    ).toHaveLength(1);

    // A dashboard write through the data layer invalidates at once.
    await raw.settings.update({
      where: { id: a!.id },
      data: { businessName: "Shop Two" },
    });
    meter.reset();
    const c = await raw.settings.findFirst({ where: { businessId: "biz-s" } });
    expect(c?.businessName).toBe("Shop Two");
  });

  it("rank 2: an updatedAt-ordered list (dashboard recent / inbox) is limited server-side", async () => {
    const raw = await seedMessages();
    await raw.conversation.create({
      data: {
        id: "conv-1",
        businessId: "biz-1",
        channel: "widget",
        customerName: "A",
        customerContact: "v-1",
        updatedAt: new Date(2026, 0, 5),
      },
    });
    await raw.conversation.create({
      data: {
        id: "conv-2",
        businessId: "biz-1",
        channel: "widget",
        customerName: "B",
        customerContact: "v-2",
        updatedAt: new Date(2026, 0, 6),
      },
    });
    meter.reset();
    const { runWithBusiness, prisma } = await import("@/lib/firestore");
    const rows = await runWithBusiness("biz-1", () =>
      prisma.conversation.findMany({
        orderBy: { updatedAt: "desc" },
        take: 1,
      })
    );
    expect(rows.map((r) => r.id)).toEqual(["conv-2"]);
    const q = meter.queryGets.find((g) => g.coll === "conversations");
    expect(q?.orderBy).toEqual({ f: "updatedAt", dir: "desc" });
    expect(q?.limit).toBe(1);
    expect(q?.returned).toBe(1);
  });

  it("rank 2/3: include is bounded and _count is aggregated for one parent", async () => {
    const raw = await seedMessages();
    await raw.conversation.create({
      data: {
        id: "conv-1",
        businessId: "biz-1",
        channel: "widget",
        customerName: "A",
        customerContact: "v-1",
      },
    });
    meter.reset();
    const conv = await raw.conversation.findUnique({
      where: { id: "conv-1" },
      include: {
        _count: { select: { messages: true } },
        messages: { take: 2, orderBy: { createdAt: "desc" } },
      },
    });
    const convT = conv as unknown as {
      _count?: { messages: number };
      messages?: Array<{ content: string }>;
    } | null;
    expect(convT?._count?.messages).toBe(5);
    expect(convT?.messages?.map((m) => m.content)).toEqual(["c1-m4", "c1-m3"]);
    // _count answered by ONE aggregation (no child fetch at all);
    // the include fetched only its bounded top-2.
    expect(
      meter.aggCounts.filter((g) => g.coll === "messages")
    ).toHaveLength(1);
    const qs = meter.queryGets.filter((g) => g.coll === "messages");
    expect(qs).toHaveLength(1);
    expect(qs[0].returned).toBe(2);
    expect(qs[0].limit).toBe(2);
  });

  it("rank 4: knowledge entries share ONE category doc get (taxonomy cache)", async () => {
    const { getUnscopedPrisma, __resetReadCaches } = await import("@/lib/firestore");
    const raw = getUnscopedPrisma();
    const cat = await raw.category.create({
      data: { businessId: "biz-k", name: "Delivery" },
    });
    for (let i = 0; i < 3; i++) {
      await raw.knowledgeEntry.create({
        data: {
          businessId: "biz-k",
          categoryId: cat.id,
          title: `Entry ${i}`,
          content: `Body ${i}`,
          isActive: true,
        },
      });
    }
    __resetReadCaches();
    meter.reset();
    const entries = await raw.knowledgeEntry.findMany({
      where: { businessId: "biz-k", isActive: true },
      include: { category: true },
    });
    expect(entries).toHaveLength(3);
    const entriesT = entries as unknown as Array<{ category?: { name: string } | null }>;
    expect(entriesT[0].category?.name).toBe("Delivery");
    expect(
      meter.docGets.filter((g) => g.coll === "categories")
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Tenant siteKey cache (ranks 1, 7, 8) — mocked prisma (tests/setup.ts)
// ---------------------------------------------------------------------------
describe("tenant siteKey cache", () => {
  it("resolves once per 60 s for a known key; misses are never cached", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { getBusinessBySiteKey, __resetSiteKeyCache } = await import(
      "@/lib/tenant"
    );
    const db = prisma as unknown as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >;
    __resetSiteKeyCache();
    db.business.findUnique.mockImplementation(
      async (args: { where?: { siteKey?: string } }) =>
        args?.where?.siteKey === "key-1"
          ? { id: "biz-1", name: "Biz One", isInternalAccount: false }
          : null
    );
    const a = await getBusinessBySiteKey("key-1");
    const b = await getBusinessBySiteKey("key-1");
    expect(a?.id).toBe("biz-1");
    expect(b?.id).toBe("biz-1");
    expect(db.business.findUnique).toHaveBeenCalledTimes(1);

    // Unknown keys are re-checked every call (positive-only caching):
    // a business created a second ago resolves immediately.
    await getBusinessBySiteKey("nope");
    await getBusinessBySiteKey("nope");
    expect(db.business.findUnique).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 4. /api/conversations batched enrichment (rank 3) — mocked prisma
// ---------------------------------------------------------------------------
describe("GET /api/conversations — batched enrichment", () => {
  it("assembles latest message, count and tags with bounded queries", async () => {
    const { prisma } = await import("@/lib/prisma");
    const db = prisma as unknown as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >;
    db.conversation.findMany.mockResolvedValue([
      { id: "c-1", channel: "widget", customerName: "A", status: "active" },
      { id: "c-2", channel: "widget", customerName: "B", status: "active" },
    ]);
    db.conversation.count.mockResolvedValue(2);
    db.message.findMany.mockImplementation(
      async (args: { where: { conversationId: string } }) => [
        {
          id: `m-${args.where.conversationId}`,
          conversationId: args.where.conversationId,
          role: "customer",
          content: `latest of ${args.where.conversationId}`,
        },
      ]
    );
    db.message.count.mockImplementation(
      async (args: { where: { conversationId: string } }) =>
        args.where.conversationId === "c-1" ? 3 : 5
    );
    db.conversationTag.findMany.mockResolvedValue([
      { id: "ct-1", conversationId: "c-1", tagId: "t-1" },
      { id: "ct-2", conversationId: "c-1", tagId: "t-2" },
    ]);
    db.tag.findMany.mockResolvedValue([
      { id: "t-1", name: "VIP", color: "#111" },
      { id: "t-2", name: "Urgent", color: "#222" },
    ]);

    const { GET } = await import("@/app/api/conversations/route");
    const { createRequest, parseJsonResponse } = await import(
      "../helpers/request"
    );
    const res = await GET(createRequest("/api/conversations"));
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.pagination.total).toBe(2);
    expect(data.data[0].messages).toHaveLength(1);
    expect(data.data[0].messages[0].content).toBe("latest of c-1");
    expect(data.data[0]._count).toEqual({ messages: 3 });
    expect(data.data[1]._count).toEqual({ messages: 5 });
    expect(data.data[0].tags).toHaveLength(2);
    expect(data.data[0].tags[0].tag.name).toBe("VIP");
    expect(data.data[1].tags).toEqual([]);

    // The list query itself carries NO includes anymore…
    const listArgs = db.conversation.findMany.mock.calls[0][0];
    expect(listArgs.include).toBeUndefined();
    // …messages are fetched per conversation, FK + take 1…
    expect(db.message.findMany).toHaveBeenCalledTimes(2);
    for (const call of db.message.findMany.mock.calls) {
      expect(call[0].take).toBe(1);
      expect(call[0].where.conversationId).toBeTruthy();
    }
    // …and tags come from ONE batched pass, not one scan per row.
    expect(db.conversationTag.findMany).toHaveBeenCalledTimes(1);
    expect(db.tag.findMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Reviews GET cache (rank 7) — mocked prisma, fake admin auth
// ---------------------------------------------------------------------------
describe("GET /api/public/reviews — payload cache", () => {
  const KEY = "rbsite-quota-key";
  let ipCounter = 500;
  const nextIp = () => `198.51.100.${(ipCounter += 1) % 250}`;
  const R1 = {
    id: "r1",
    site: "ai",
    uid: "u2",
    name: "Karim",
    photoURL: "",
    rating: 5,
    text: "Great.",
    status: "published",
    verifiedGoogle: false,
    createdAt: new Date("2026-10-19T10:00:00Z"),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetReviewsCache } = await import(
      "@/app/api/public/reviews/route"
    );
    __resetReviewsCache();
    const { __resetSiteKeyCache } = await import("@/lib/tenant");
    __resetSiteKeyCache();
    const { prisma } = await import("@/lib/prisma");
    const db = prisma as unknown as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >;
    db.business.findUnique.mockImplementation(
      async (args: { where?: { siteKey?: string } }) =>
        args?.where?.siteKey === KEY
          ? { id: "test-business", name: "Ride Bangla" }
          : null
    );
    db.siteReview.findMany.mockResolvedValue([R1]);
    db.siteReview.findFirst.mockResolvedValue(null);
    db.siteReview.create.mockResolvedValue({ id: "r-new" });
    hoisted.verifyIdToken.mockResolvedValue({
      uid: "user-1",
      email: "user@example.com",
      name: "Real User",
      picture: "",
      firebase: { sign_in_provider: "google.com" },
    });
  });

  function get(path: string): NextRequest {
    return new NextRequest(`http://localhost${path}`, {
      method: "GET",
      headers: { "x-forwarded-for": nextIp() },
    });
  }

  it("serves the second landing view from cache; a POST invalidates it", async () => {
    const { GET, POST } = await import("@/app/api/public/reviews/route");
    const { prisma } = await import("@/lib/prisma");
    const db = prisma as unknown as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >;
    const url = `/api/public/reviews?site=ai&siteKey=${KEY}`;
    const first = await (await GET(get(url))).json();
    expect(first.count).toBe(1);
    expect(db.siteReview.findMany).toHaveBeenCalledTimes(1);

    db.siteReview.findMany.mockResolvedValue([
      R1,
      { ...R1, id: "r2", uid: "u3", rating: 3 },
    ]);
    const second = await (await GET(get(url))).json();
    expect(second.count).toBe(1); // cached payload, no re-scan
    expect(db.siteReview.findMany).toHaveBeenCalledTimes(1);

    const postRes = await POST(
      new NextRequest("http://localhost/api/public/reviews", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": nextIp(),
        },
        body: JSON.stringify({
          siteKey: KEY,
          site: "ai",
          idToken: "tok",
          rating: 4,
          text: "Works well.",
        }),
      })
    );
    expect(postRes.status).toBe(200);
    const third = await (await GET(get(url))).json();
    expect(third.count).toBe(2); // invalidated by the POST
    expect(db.siteReview.findMany).toHaveBeenCalledTimes(2);
  });

  it("never caches an empty payload (a first review shows at once)", async () => {
    const { GET } = await import("@/app/api/public/reviews/route");
    const { prisma } = await import("@/lib/prisma");
    const db = prisma as unknown as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >;
    db.siteReview.findMany.mockResolvedValue([]);
    const url = `/api/public/reviews?site=ai&siteKey=${KEY}`;
    const empty = await (await GET(get(url))).json();
    expect(empty.count).toBe(0);
    db.siteReview.findMany.mockResolvedValue([R1]);
    const filled = await (await GET(get(url))).json();
    expect(filled.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Catalog brief cache (rank 4) — mocked prisma
// ---------------------------------------------------------------------------
describe("getCatalogBrief cache", () => {
  it("builds once per TTL per business and rebuilds after invalidation", async () => {
    const { prisma } = await import("@/lib/prisma");
    const db = prisma as unknown as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >;
    db.productCategory.findMany.mockResolvedValue([
      {
        name: "Cakes",
        products: [{ name: "Choco Cake", price: 500, currency: "BDT" }],
      },
    ]);
    const { getCatalogBrief, invalidateCatalogBrief, __resetCatalogBriefCache } =
      await import("@/lib/catalog");
    __resetCatalogBriefCache();
    const first = await getCatalogBrief();
    const second = await getCatalogBrief();
    expect(first).toContain("Choco Cake");
    expect(second).toBe(first);
    expect(db.productCategory.findMany).toHaveBeenCalledTimes(1);
    invalidateCatalogBrief("test-business");
    await getCatalogBrief();
    expect(db.productCategory.findMany).toHaveBeenCalledTimes(2);
  });

  it("onboarding confirm invalidates a brief cached before onboarding", async () => {
    const { prisma } = await import("@/lib/prisma");
    const db = prisma as unknown as Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    >;
    db.productCategory.findMany.mockClear();
    db.productCategory.findMany.mockResolvedValue([
      {
        name: "Cakes",
        products: [{ name: "Choco Cake", price: 500, currency: "BDT" }],
      },
    ]);
    db.productCategory.findFirst.mockResolvedValue(null);
    db.productCategory.create.mockResolvedValue({
      id: "cat-new",
      name: "Cakes",
    });
    db.product.create.mockResolvedValue({ id: "prod-new" });
    const { getCatalogBrief, __resetCatalogBriefCache } =
      await import("@/lib/catalog");
    __resetCatalogBriefCache();
    const before = await getCatalogBrief();
    expect(before).toContain("Choco Cake");
    expect(db.productCategory.findMany).toHaveBeenCalledTimes(1);

    const { POST } = await import("@/app/api/onboarding/confirm/route");
    const res = await POST(
      new NextRequest("http://localhost/api/onboarding/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products: [{ name: "New Cake", price: 700, category: "Cakes" }],
        }),
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).productsCreated).toBe(1);

    // Without the onboarding invalidation this would return the cached
    // pre-onboarding brief (and findMany would still be at 1 call).
    db.productCategory.findMany.mockResolvedValue([
      {
        name: "Cakes",
        products: [{ name: "New Cake", price: 700, currency: "BDT" }],
      },
    ]);
    const after = await getCatalogBrief();
    expect(after).toContain("New Cake");
    expect(db.productCategory.findMany).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Widget embed polling (rank 1, client side) — source shape
// ---------------------------------------------------------------------------
describe("widget embed adaptive polling", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../../public/widget/ride-bangla-chat.js"),
    "utf8"
  );
  it("no longer polls the thread on a fixed 4 s interval", () => {
    expect(src).not.toContain("setInterval(syncThread, 4000)");
    expect(src).toContain("THREAD_SYNC_MAX_MS = 30000");
    expect(src).toContain("THREAD_SYNC_FAST_MS = 5000");
  });
  it("pauses thread polling while the tab is hidden", () => {
    expect(src).toContain("visibilitychange");
    expect(src).toContain("document.hidden");
  });
  it("relaxes the in-flight activity poll to 2 s", () => {
    expect(src).toContain("setInterval(pollActivity, 2000)");
    expect(src).not.toContain("setInterval(pollActivity, 1200)");
  });
  it("syncs immediately when a local turn settles", () => {
    expect(src).toContain("pokeThreadSync()");
  });
});
