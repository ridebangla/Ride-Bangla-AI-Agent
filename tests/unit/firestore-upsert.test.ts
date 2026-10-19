/**
 * firestore-upsert.test.ts — regression test for the Firestore shim's
 * `upsert` update branch.
 *
 * Bug: the delegate's `upsert` passed `data: args.data` to `updateRaw` on
 * the existing-row branch. Every production caller uses the Prisma
 * convention `upsert({ where, update, create })`, so `args.data` was always
 * `undefined` and updates were silently dropped (only `updatedAt` was
 * written). Dashboard Settings / Business Hours / Channels saves never
 * persisted.
 *
 * Fix: `data: args.data ?? args.update` in the upsert update branch.
 *
 * The firebase-admin module is faked in-memory; the REAL delegate code in
 * src/lib/firestore.ts runs against it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory firebase-admin fake (hoisted so the vi.mock factory can use it)
// ---------------------------------------------------------------------------
const { fakeFirestore, resetFake } = vi.hoisted(() => {
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

  const norm = (x: unknown) =>
    x instanceof FakeTimestamp ? (x as FakeTimestamp).toDate().getTime() : x;

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
    protected filters: Array<{ f: string; v: unknown }> = [];
    constructor(readonly coll: string) {}
    where(f: string, _op: string, v: unknown) {
      this.filters.push({ f, v });
      return this;
    }
    orderBy() {
      return this;
    }
    limit() {
      return this;
    }
    async get() {
      const m = store.get(this.coll);
      let docs = [...(m?.entries() ?? [])].map(
        ([id, data]) => new FakeSnapshot(id, data)
      );
      for (const { f, v } of this.filters) {
        docs = docs.filter(
          (d) => norm((d.data() as DocData | undefined)?.[f]) === norm(v)
        );
      }
      return new FakeQuerySnapshot(docs);
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
    runTransaction: async <T>(fn: (tx: typeof fakeTx) => Promise<T>) =>
      fn(fakeTx),
  };

  const firestoreFn = Object.assign((_app: unknown) => fakeDb, {
    FieldValue: {
      serverTimestamp: () => new Date(),
      delete: () => ({ __deleteField: true }),
    },
    Timestamp: FakeTimestamp,
  });

  return {
    fakeFirestore: firestoreFn,
    resetFake: () => {
      store.clear();
      autoId = 0;
    },
  };
});

vi.mock("firebase-admin", () => ({
  apps: [] as unknown[],
  initializeApp: () => ({}),
  credential: { cert: () => ({}) },
  firestore: fakeFirestore,
}));

// ---------------------------------------------------------------------------
// Tests — import the REAL module under test AFTER the mock is registered
// ---------------------------------------------------------------------------

describe("firestore shim upsert (regression)", () => {
  beforeEach(() => {
    resetFake();
    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "fake-key";
  });

  it("creates on the missing-row branch", async () => {
    const { runWithBusiness, prisma } = await import("@/lib/firestore");
    const row = await runWithBusiness("biz-1", () =>
      prisma.settings.upsert({
        where: { businessId: "biz-1" },
        update: { businessName: "Should not apply" },
        create: { businessId: "biz-1", businessName: "Fresh Biz" },
      })
    );
    expect(row.businessName).toBe("Fresh Biz");
  });

  it("persists the Prisma-style `update:` payload on the existing-row branch", async () => {
    const { runWithBusiness, prisma } = await import("@/lib/firestore");

    // Seed one settings row via the create branch.
    await runWithBusiness("biz-1", () =>
      prisma.settings.upsert({
        where: { businessId: "biz-1" },
        update: {},
        create: { businessId: "biz-1", businessName: "Old Name" },
      })
    );

    // Now upsert again with an update payload (the Prisma convention used
    // by PUT /api/settings, /api/business-hours, /api/channels, ...).
    const updated = await runWithBusiness("biz-1", () =>
      prisma.settings.upsert({
        where: { businessId: "biz-1" },
        update: { businessName: "New Name", tone: "formal" },
        create: { businessId: "biz-1", businessName: "New Name" },
      })
    );

    expect(updated.businessName).toBe("New Name");
    expect(updated.tone).toBe("formal");

    // And it really landed in the store (read it back fresh).
    const reread = await runWithBusiness("biz-1", () =>
      prisma.settings.findFirst({ where: { businessId: "biz-1" } })
    );
    expect(reread?.businessName).toBe("New Name");
    expect(reread?.tone).toBe("formal");
  });

  it("raw delegate: explicit `data:` wins over `update:` when both are given", async () => {
    // NOTE: the tenant-scoped `prisma` proxy reimplements upsert with the
    // Prisma convention (`update:` wins; `data:` is not a Prisma upsert
    // key). This test targets the RAW delegate directly, where the
    // historical `data:` key is still honored for backward compatibility.
    const { runWithBusiness, getUnscopedPrisma } = await import(
      "@/lib/firestore"
    );
    const raw = getUnscopedPrisma();
    await runWithBusiness("biz-1", () =>
      raw.settings.upsert({
        where: { businessId: "biz-1" },
        update: {},
        create: { businessId: "biz-1", businessName: "Old Name" },
      })
    );
    const updated = await runWithBusiness("biz-1", () =>
      (
        raw.settings.upsert as (
          args: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      )({
        where: { businessId: "biz-1" },
        data: { businessName: "Via Data" },
        update: { businessName: "Via Update" },
        create: { businessId: "biz-1", businessName: "Old Name" },
      })
    );
    expect(updated.businessName).toBe("Via Data");
  });
});
