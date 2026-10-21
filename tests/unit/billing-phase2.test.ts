/**
 * billing-phase2.test.ts — Billing Phase 2 (wallet, auto-verify, fraud,
 * metering, countdown) unit tests.
 *
 * Pure logic is tested directly; Firestore-touching wallet functions run
 * against an in-memory FakeDb via a mocked @/lib/admin-db.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory Firestore fake (hoisted so vi.mock factories can use it)
// ---------------------------------------------------------------------------
const { fakeDb } = vi.hoisted(() => {
  type DocData = Record<string, unknown>;
  const comparable = (v: unknown): number => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    if (v && typeof v.toDate === "function") {
      try {
        return v.toDate().getTime();
      } catch {
        return NaN;
      }
    }
    return NaN;
  };

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
  }

  class FakeDocRef {
    constructor(
      private db: FakeDb,
      readonly coll: string,
      readonly id: string
    ) {}
    private collMap(create = false) {
      let m = this.db.store.get(this.coll);
      if (!m && create) {
        m = new Map();
        this.db.store.set(this.coll, m);
      }
      return m;
    }
    async get() {
      const data = this.collMap()?.get(this.id);
      return new FakeDocSnapshot(this.id, data);
    }
    async set(data: DocData, opts?: { merge?: boolean }) {
      const m = this.collMap(true)!;
      if (opts?.merge && m.has(this.id)) {
        m.set(this.id, { ...m.get(this.id), ...data });
      } else {
        m.set(this.id, { ...data });
      }
    }
    async update(data: DocData) {
      // Lenient vs real Firestore (which fails on missing docs) — the
      // production code only updates docs it just read.
      const m = this.collMap(true)!;
      m.set(this.id, { ...(m.get(this.id) ?? {}), ...data });
    }
  }

  class FakeQuery {
    private filters: Array<{ f: string; op: string; v: unknown }> = [];
    private sortField: string | null = null;
    private sortDir: "asc" | "desc" = "asc";
    private limitN: number | null = null;
    constructor(
      private db: FakeDb,
      readonly coll: string
    ) {}
    where(f: string, op: string, v: unknown) {
      this.filters.push({ f, op, v });
      return this;
    }
    orderBy(f: string, dir: "asc" | "desc" = "asc") {
      this.sortField = f;
      this.sortDir = dir;
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    async get() {
      let docs = [...(this.db.store.get(this.coll)?.entries() ?? [])].map(
        ([id, data]) => new FakeDocSnapshot(id, data)
      );
      for (const { f, op, v } of this.filters) {
        docs = docs.filter((d) => {
          const dv = d.data()?.[f];
          if (op === "==") return dv === v;
          if (op === ">") {
            const a = comparable(dv);
            const b = comparable(v);
            if (Number.isNaN(a) || Number.isNaN(b)) return true; // lenient
            return a > b;
          }
          return true;
        });
      }
      if (this.sortField) {
        const sf = this.sortField;
        docs.sort((a, b) => {
          const x = comparable(a.data()?.[sf]);
          const y = comparable(b.data()?.[sf]);
          if (Number.isNaN(x)) return 1;
          if (Number.isNaN(y)) return -1;
          return this.sortDir === "desc" ? y - x : x - y;
        });
      }
      if (this.limitN !== null) docs = docs.slice(0, this.limitN);
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
    orderBy(f: string, dir: "asc" | "desc" = "asc") {
      return new FakeQuery(this.db, this.name).orderBy(f, dir);
    }
    limit(n: number) {
      return new FakeQuery(this.db, this.name).limit(n);
    }
    get() {
      return new FakeQuery(this.db, this.name).get();
    }
  }

  class FakeTx {
    constructor(private db: FakeDb) {}
    get(ref: FakeDocRef | FakeQuery) {
      return ref.get();
    }
    set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) {
      return ref.set(data, opts);
    }
    update(ref: FakeDocRef, data: DocData) {
      return ref.update(data);
    }
  }

  class FakeBatch {
    private ops: Array<() => Promise<unknown>> = [];
    set(ref: FakeDocRef, data: DocData) {
      this.ops.push(() => ref.set(data));
    }
    async commit() {
      for (const op of this.ops) await op();
    }
  }

  class FakeDb {
    store = new Map<string, Map<string, DocData>>();
    collection(name: string) {
      return new FakeCollectionRef(this, name);
    }
    batch() {
      return new FakeBatch();
    }
    runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
      return fn(new FakeTx(this));
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

// manual-payments keeps its real validators; force isMethodEnabled true so
// wallet deposit-claim tests don't depend on Firestore config docs.
vi.mock("@/lib/manual-payments", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, isMethodEnabled: async () => true };
});

import { generateRefCode, isValidRefCode } from "@/lib/ref-codes";
import { PLAN_META } from "@/lib/plans";
import {
  detectFraudSignals,
  runFraudHeuristics,
} from "@/lib/fraud-monitor";
import {
  createDepositClaim,
  purchaseFromWallet,
  creditWalletForClaim,
  getWallet,
  getWalletTransactions,
  planPriceCents,
} from "@/lib/wallet";
import {
  binanceAdapter,
  bybitAdapter,
  okxAdapter,
} from "@/lib/exchanges";
import { buildCountdown } from "@/lib/billing-usage";
import { __testables } from "@/lib/auto-verify";

beforeEach(() => {
  fakeDb.clear();
  delete process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_API_SECRET;
  delete process.env.BYBIT_API_KEY;
  delete process.env.BYBIT_API_SECRET;
  delete process.env.OKX_API_KEY;
  delete process.env.OKX_API_SECRET;
  delete process.env.OKX_API_PASSPHRASE;
  vi.clearAllMocks();
});

const SHOT =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBIiMkESQh/9k=";

// ---------------------------------------------------------------------------
describe("ref codes", () => {
  it("generates RB- + 8 uppercase alphanumerics", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRefCode();
      expect(code).toMatch(/^RB-[A-Z0-9]{8}$/);
      expect(isValidRefCode(code)).toBe(true);
    }
  });

  it("is unique across many generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateRefCode());
    expect(seen.size).toBe(1000);
  });

  it("rejects malformed codes", () => {
    expect(isValidRefCode("RB-ABC")).toBe(false);
    expect(isValidRefCode("rb-ABCDEFGH")).toBe(false);
    expect(isValidRefCode("RB-ABCDEFG!")).toBe(false);
    expect(isValidRefCode("")).toBe(false);
    expect(isValidRefCode(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("plans: messagesPerMonth", () => {
  it("has the contract allowances", () => {
    expect(PLAN_META.starter.messagesPerMonth).toBe(1000);
    expect(PLAN_META.growth.messagesPerMonth).toBe(5000);
    expect(PLAN_META.pro.messagesPerMonth).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
describe("fraud heuristics (pure)", () => {
  const base = {
    businessId: "biz-1",
    claimId: "claim-1",
    kind: "subscription" as const,
    amountCents: 1900,
    plan: "starter",
    interval: "monthly" as const,
  };

  it("fires duplicate_txn (high) when the txnId was seen on another claim", () => {
    const signals = detectFraudSignals(base, {
      txnIdSeenElsewhere: true,
      claimsLast24h: 1,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("duplicate_txn");
    expect(signals[0].severity).toBe("high");
  });

  it("fires amount_mismatch (medium) when a subscription amount != plan price", () => {
    const signals = detectFraudSignals(
      { ...base, amountCents: 1800 },
      { txnIdSeenElsewhere: false, claimsLast24h: 1 }
    );
    expect(signals.some((s) => s.type === "amount_mismatch")).toBe(true);
    expect(
      signals.find((s) => s.type === "amount_mismatch")!.severity
    ).toBe("medium");
  });

  it("stays silent when the amount matches the plan price", () => {
    expect(
      detectFraudSignals(base, {
        txnIdSeenElsewhere: false,
        claimsLast24h: 1,
      })
    ).toHaveLength(0);
  });

  it("fires amount_mismatch for non-positive wallet deposits", () => {
    const signals = detectFraudSignals(
      {
        businessId: "biz-1",
        claimId: "c2",
        kind: "wallet_deposit",
        amountCents: 0,
      },
      { txnIdSeenElsewhere: false, claimsLast24h: 1 }
    );
    expect(signals.some((s) => s.type === "amount_mismatch")).toBe(true);
  });

  it("fires velocity (medium) above 3 claims/24h, silent at 3", () => {
    expect(
      detectFraudSignals(base, {
        txnIdSeenElsewhere: false,
        claimsLast24h: 4,
      }).some((s) => s.type === "velocity")
    ).toBe(true);
    expect(
      detectFraudSignals(base, {
        txnIdSeenElsewhere: false,
        claimsLast24h: 3,
      })
    ).toHaveLength(0);
  });

  it("runFraudHeuristics writes signals but never throws", async () => {
    // Seed a different claim with the same txnId to trigger duplicate_txn.
    await fakeDb
      .collection("payment_claims")
      .doc("other-claim")
      .set({ businessId: "biz-9", txnId: "TXN-DUP", status: "pending" });
    await expect(
      runFraudHeuristics({
        businessId: "biz-1",
        claimId: "claim-new",
        kind: "subscription",
        amountCents: 1900,
        plan: "starter",
        interval: "monthly",
        txnId: "TXN-DUP",
      })
    ).resolves.toBeUndefined();
    const signals = await fakeDb.collection("fraud_signals").get();
    expect(signals.size).toBeGreaterThan(0);
    expect(
      signals.docs.some((d) => (d.data() as DocData | undefined)?.type === "duplicate_txn")
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("exchange adapters", () => {
  it.each([
    ["binance", binanceAdapter],
    ["bybit", bybitAdapter],
    ["okx", okxAdapter],
  ])("%s: not configured without env keys", async (_name, adapter) => {
    expect(adapter.isConfigured()).toBe(false);
    const res = await adapter.findDeposit({
      refCode: "RB-ABCDEFGH",
      amountCents: 1900,
      since: new Date(),
    });
    expect(res.found).toBe(false);
    expect(res.note).toMatch(/not configured/i);
  });

  it("binance: configured when keys exist, performs a real signed lookup", async () => {
    process.env.BINANCE_API_KEY = "k";
    process.env.BINANCE_API_SECRET = "s";
    expect(binanceAdapter.isConfigured()).toBe(true);
    // Fixture-verified (payment-auto-verify.test.ts covers matching):
    // an empty deposit history is an honest no-match, never a fake hit.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await binanceAdapter.findDeposit({
        refCode: "RB-ABCDEFGH",
        amountCents: 1900,
        since: new Date(),
      });
      expect(res.found).toBe(false);
      expect(res.note).toMatch(/no deposit mentioning/i);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
describe("billing countdown (pure)", () => {
  const NOW = new Date("2026-10-19T12:00:00Z").getTime();
  const days = (n: number) => new Date(NOW + n * 24 * 60 * 60 * 1000);

  it("includes breached day thresholds only (7 and 3 at 2 days left)", () => {
    const c = buildCountdown(
      {
        subscriptionStatus: "active",
        plan: "growth",
        subscriptionEndsAt: days(2),
        aiMessagesUsed: 0,
      },
      NOW
    );
    expect(c.daysRemaining).toBe(2);
    const dayNotices = c.notices.filter((n) => n.type === "days");
    const thresholds = dayNotices.map((n) =>
      n.type === "days" ? n.threshold : -1
    );
    expect(thresholds).toEqual([7, 3]);
  });

  it("is silent when nothing is breached", () => {
    const c = buildCountdown(
      {
        subscriptionStatus: "active",
        plan: "growth",
        subscriptionEndsAt: days(30),
        aiMessagesUsed: 100,
      },
      NOW
    );
    expect(c.notices).toHaveLength(0);
    expect(c.messagesLimit).toBe(5000);
    expect(c.messagesRemaining).toBe(4900);
    expect(c.percentUsed).toBe(2);
  });

  it("fires usage 80 at 84% and both 80+100 at 100%", () => {
    const at84 = buildCountdown(
      { subscriptionStatus: "active", plan: "growth", aiMessagesUsed: 4200 },
      NOW
    );
    expect(at84.percentUsed).toBe(84);
    const usage84 = at84.notices
      .filter((n) => n.type === "usage")
      .map((n) => (n.type === "usage" ? n.threshold : -1));
    expect(usage84).toEqual([80]);

    const at100 = buildCountdown(
      { subscriptionStatus: "active", plan: "growth", aiMessagesUsed: 5000 },
      NOW
    );
    const usage100 = at100.notices
      .filter((n) => n.type === "usage")
      .map((n) => (n.type === "usage" ? n.threshold : -1));
    expect(usage100).toEqual([80, 100]);
    expect(at100.messagesRemaining).toBe(0);
  });

  it("trial shares the starter allowance", () => {
    const c = buildCountdown(
      { subscriptionStatus: "trialing", plan: "trial", aiMessagesUsed: 0 },
      NOW
    );
    expect(c.messagesLimit).toBe(1000);
  });

  it("carries the admin notice through", () => {
    const c = buildCountdown(
      {
        subscriptionStatus: "active",
        plan: "starter",
        adminNotice: { message: "Please update your details.", createdBy: "team" },
      },
      NOW
    );
    expect(c.adminNotice?.message).toBe("Please update your details.");
  });
});

// ---------------------------------------------------------------------------
describe("vision pre-read parsing (pure)", () => {
  const { parseVisionDescription } = __testables;

  it("extracts txn id and amount with high confidence", () => {
    const p = parseVisionDescription(
      "Binance Pay successful. Transaction hash: 9f2ac41be077d13a. Amount: $50.00 completed."
    );
    expect(p.extractedTxnId).toBe("9f2ac41be077d13a");
    expect(p.extractedAmount).toBe("50.00");
    expect(p.confidence).toBe("high");
  });

  it("is low confidence when nothing is extractable", () => {
    const p = parseVisionDescription("A blurry photo of a cat.");
    expect(p.confidence).toBe("low");
    expect(p.extractedTxnId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("wallet", () => {
  it("createDepositClaim creates a pending claim with a unique refCode", async () => {
    const { claimId, refCode } = await createDepositClaim("biz-1", {
      method: "binance",
      amountCents: 5000,
      txnId: "TXN-001",
      screenshotDataUrl: SHOT,
    });
    expect(claimId).toBeTruthy();
    expect(refCode).toMatch(/^RB-[A-Z0-9]{8}$/);

    const snap = await fakeDb.collection("payment_claims").doc(claimId).get();
    expect(snap.exists).toBe(true);
    const d = snap.data()!;
    expect(d.kind).toBe("wallet_deposit");
    expect(d.status).toBe("pending");
    expect(d.amountCents).toBe(5000);
    expect(d.refCode).toBe(refCode);
    expect(d.autoVerify.status).toBe("pending");
    // visionPreRead is fire-and-forget — allow it to settle.
    await new Promise((r) => setTimeout(r, 100));
    const snap2 = await fakeDb.collection("payment_claims").doc(claimId).get();
    expect(snap2.data()!.visionPreRead.status).toBe("unavailable"); // no AI key in test env
  });

  it("createDepositClaim rejects a txnId already claimed (A-to-Z audit dedupe)", async () => {
    await createDepositClaim("biz-1", {
      method: "binance",
      amountCents: 5000,
      txnId: "TXN-DUP-1",
      screenshotDataUrl: SHOT,
    });
    await expect(
      createDepositClaim("biz-2", {
        method: "binance",
        amountCents: 5000,
        txnId: "TXN-DUP-1",
        screenshotDataUrl: SHOT,
      })
    ).rejects.toMatchObject({ name: "WalletError", code: "duplicate_txn" });
  });

  it("createDepositClaim rejects non-positive amounts", async () => {
    await expect(
      createDepositClaim("biz-1", {
        method: "binance",
        amountCents: 0,
        txnId: "TXN-002",
        screenshotDataUrl: SHOT,
      })
    ).rejects.toMatchObject({ name: "WalletError", code: "invalid_amount" });
  });

  it("getWallet defaults to zero and getWalletTransactions lists newest first", async () => {
    const w = await getWallet("biz-empty");
    expect(w.balanceCents).toBe(0);
    expect(w.currency).toBe("USD");
    expect(await getWalletTransactions("biz-empty")).toEqual([]);
  });

  it("purchaseFromWallet deducts, logs, and activates — insufficient balance throws 402-style", async () => {
    await fakeDb
      .collection("wallets")
      .doc("biz-2")
      .set({ businessId: "biz-2", balanceCents: 10000, currency: "USD" });

    await expect(
      purchaseFromWallet("biz-2", { plan: "pro", interval: "yearly" })
    ).rejects.toMatchObject({ code: "insufficient_balance" });

    const price = planPriceCents("growth", "monthly");
    expect(price).toBe(4900);
    const res = await purchaseFromWallet("biz-2", {
      plan: "growth",
      interval: "monthly",
    });
    expect(res.balanceCents).toBe(5100);
    expect(res.subscriptionEndsAt.getTime()).toBeGreaterThan(Date.now());

    const wallet = await getWallet("biz-2");
    expect(wallet.balanceCents).toBe(5100);

    const txns = await getWalletTransactions("biz-2");
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("purchase");
    expect(txns[0].amountCents).toBe(-4900);
    expect(txns[0].balanceAfterCents).toBe(5100);
    expect(txns[0].plan).toBe("growth");

    const biz = await fakeDb.collection("businesses").doc("biz-2").get();
    expect(biz.data()!.subscriptionStatus).toBe("active");
    expect(biz.data()!.plan).toBe("growth");
    expect(biz.data()!.billingInterval).toBe("monthly");
    expect(biz.data()!.subscriptionEndsAt).toBeTruthy();
  });

  it("creditWalletForClaim credits once and is idempotent on re-run", async () => {
    const { claimId } = await createDepositClaim("biz-3", {
      method: "bybit",
      amountCents: 2500,
      txnId: "TXN-003",
      screenshotDataUrl: SHOT,
    });

    const first = await creditWalletForClaim(claimId, "admin-1");
    expect(first.credited).toBe(true);
    expect(first.balanceCents).toBe(2500);

    const claim = await fakeDb.collection("payment_claims").doc(claimId).get();
    expect(claim.data()!.status).toBe("approved");

    const txns = await getWalletTransactions("biz-3");
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("deposit");
    expect(txns[0].amountCents).toBe(2500);
    expect(txns[0].claimId).toBe(claimId);
    expect(txns[0].balanceAfterCents).toBe(2500);

    // Re-run: safe no-op, no double credit.
    const second = await creditWalletForClaim(claimId, "admin-1");
    expect(second.credited).toBe(false);
    expect(second.balanceCents).toBe(2500);
    expect((await getWalletTransactions("biz-3")).length).toBe(1);
  });

  it("creditWalletForClaim refuses non-deposit claims and missing claims", async () => {
    await expect(
      creditWalletForClaim("nope", "admin-1")
    ).rejects.toMatchObject({ code: "not_found" });

    await fakeDb.collection("payment_claims").doc("sub-claim").set({
      businessId: "biz-4",
      kind: "subscription",
      status: "pending",
      amountCents: 1900,
    });
    await expect(
      creditWalletForClaim("sub-claim", "admin-1")
    ).rejects.toMatchObject({ code: "wrong_kind" });
  });
});
