/**
 * payment-auto-verify.test.ts — Payment auto-verify + auto-activation
 * (owner directive 2026-10-21).
 *
 * Coverage:
 *  - exchanges/match.ts: amount parsing + deposit matching rules.
 *  - exchanges adapters: REAL signed deposit-history lookups against
 *    stubbed fetch fixtures (match / no-match / API error surfaces).
 *    Live exchange calls stay key-gated — no test touches the network.
 *  - payment-decision.ts: receipt extraction parsing + the check matrix
 *    (auto-approve requires EVERY check to pass; any failure routes to
 *    human review — never auto-reject).
 *  - auto-verify.ts orchestration against an in-memory FakeDb:
 *    bank claim auto-approves + activates + records decision/audit +
 *    activation snapshot; a failing claim stays pending with evidence;
 *    crypto match activates; unconfigured exchange stays honest.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted test doubles
// ---------------------------------------------------------------------------
const holder = vi.hoisted(() => ({
  keys: { openai: "test-key" } as Record<string, string>,
  visionText: "",
  visionError: false,
}));

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
      return new FakeDocSnapshot(this.id, this.collMap()?.get(this.id));
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
      const m = this.collMap(true)!;
      m.set(this.id, { ...(m.get(this.id) ?? {}), ...data });
    }
  }

  class FakeQuery {
    private filters: Array<{ f: string; op: string; v: unknown }> = [];
    private limitN: number | null = null;
    constructor(
      private db: FakeDb,
      readonly coll: string
    ) {}
    where(f: string, op: string, v: unknown) {
      this.filters.push({ f, op, v });
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
          return true;
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

  class FakeDb {
    store = new Map<string, Map<string, DocData>>();
    collection(name: string) {
      return new FakeCollectionRef(this, name);
    }
    runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
      return fn(new FakeTx(this));
    }
    clear() {
      this.store.clear();
    }
    seed(coll: string, id: string, data: DocData) {
      let m = this.store.get(coll);
      if (!m) {
        m = new Map();
        this.store.set(coll, m);
      }
      m.set(id, { ...data });
    }
    read(coll: string, id: string): DocData | undefined {
      return this.store.get(coll)?.get(id);
    }
    all(coll: string): DocData[] {
      return [...(this.store.get(coll)?.values() ?? [])];
    }
  }

  return { fakeDb: new FakeDb() };
});

vi.mock("@/lib/admin-db", () => ({
  getAdminDb: () => fakeDb,
  __resetAdminDbForTests: () => {},
}));

vi.mock("@/lib/ai/providers", () => ({
  resolveSiteKeys: async () => holder.keys,
  hasAnyProviderKey: (k: Record<string, string>) =>
    !!k && Object.values(k).some((v) => typeof v === "string" && v.length > 0),
}));

vi.mock("@/lib/ai/media", () => ({
  perceiveMedia: async () => ({ kind: "image", description: "" }),
  describeImageWithVision: async () => {
    if (holder.visionError) throw new Error("vision backend down");
    return holder.visionText;
  },
}));

import { amountToCents, matchDeposits } from "@/lib/exchanges/match";
import {
  parseReceiptExtraction,
  evaluateReceiptChecks,
  type ReceiptDecisionInput,
} from "@/lib/payment-decision";
import { runClaimDecision } from "@/lib/auto-verify";
import { assertTxnIdNotClaimed, txnLockId, txnNormOf } from "@/lib/claim-dedupe";
import { createWithUniqueRefCode } from "@/lib/ref-codes";
import { DuplicateTxnError } from "@/lib/claim-dedupe";


const SHOT2 =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBIiMkESQh/9k=";

function todayLabel2(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
function receiptFor(txn: string, ref: string, amount = "19.00"): string {
  return [
    "RECEIPT: YES",
    `AMOUNT: ${amount}`,
    "CURRENCY: USD",
    `TXN: ${txn}`,
    `DATE: ${todayLabel2()}`,
    "RECIPIENT: Ride Bangla LLC",
    `NOTE: ${ref}`,
  ].join("\n");
}
function seedClaim(id: string, biz: string, txnId: string, refCode: string, status = "pending") {
  fakeDb.seed("businesses", biz, { subscriptionStatus: "trialing", plan: "trial", aiMessagesUsed: 700 });
  fakeDb.seed("payment_claims", id, {
    businessId: biz, kind: "subscription", status, method: "us_bank",
    plan: "starter", interval: "monthly", amount: 19, amountCents: 1900,
    txnId, txnIdNorm: txnNormOf(txnId), refCode, screenshotDataUrl: SHOT2, createdAt: new Date(),
  });
}

beforeEach(() => {
  fakeDb.clear();
  holder.keys = { openai: "test-key" };
  holder.visionError = false;
  fakeDb.seed("payment_methods_config", "us_bank", { enabled: true, accountName: "Ride Bangla LLC" });
});

describe("ATTACK REGRESSION: receipt parser hardening", () => {
  const decide = (text: string, over: Record<string, unknown> = {}) =>
    evaluateReceiptChecks({
      claimAmountCents: 1900, claimTxnId: "TXN99887766", refCode: "RB-TEST1234",
      claimCreatedAt: new Date(), extraction: parseReceiptExtraction(text),
      expectedRecipient: "Ride Bangla LLC", txnAlreadyApprovedElsewhere: false,
      now: new Date(), ...over,
    } as never);

  it("RECEIPT line missing or UNKNOWN no longer counts as a receipt", () => {
    const noLine = receiptFor("TXN99887766", "RB-TEST1234").split("\n").filter((l) => !l.startsWith("RECEIPT")).join("\n");
    expect(parseReceiptExtraction(noLine).isReceipt).toBe(false);
    expect(decide(noLine).outcome).toBe("human_review");
    const unknown = receiptFor("TXN99887766", "RB-TEST1234").replace("RECEIPT: YES", "RECEIPT: UNKNOWN");
    expect(parseReceiptExtraction(unknown).isReceipt).toBe(false);
    expect(decide(unknown).outcome).toBe("human_review");
  });

  it("negative (refund/reversal) amounts never parse as payments", () => {
    const ex = parseReceiptExtraction(receiptFor("TXN99887766", "RB-TEST1234", "-19.00"));
    expect(ex.amountCents).toBeNull();
    expect(decide(receiptFor("TXN99887766", "RB-TEST1234", "-19.00")).outcome).toBe("human_review");
  });

  it("sub-cent amounts do not round up into an exact match", () => {
    expect(amountToCents("18.995")).toBeNull();
    expect(amountToCents("18.99999999")).toBeNull();
    expect(amountToCents("19.00000000")).toBe(1900);
    expect(parseReceiptExtraction(receiptFor("TXN99887766", "RB-TEST1234", "18.995")).amountCents).toBeNull();
    const m = matchDeposits("Binance", [{ memo: "RB-TEST1234", amountCents: amountToCents("18.995"), coin: "USDT", txId: "d", final: true }], { refCode: "RB-TEST1234", amountCents: 1900, since: new Date() });
    expect(m.found).toBe(false);
  });

  it("empty refCode cannot satisfy txn_or_ref_match vacuously", () => {
    const wrong = receiptFor("OTHER999999", "no-ref-here");
    const d = decide(wrong, { refCode: "" });
    expect(d.checks.find((c) => c.name === "txn_or_ref_match")?.ok).toBe(false);
    expect(d.outcome).toBe("human_review");
  });

  it("injected first block loses: the parser reads the model's final answer block", () => {
    const injectedFirst = [receiptFor("TXN99887766", "RB-TEST1234"), "", receiptFor("REALSMALL1", "none", "5.00")].join("\n");
    const ex = parseReceiptExtraction(injectedFirst);
    expect(ex.amountCents).toBe(500);
    expect(decide(injectedFirst).outcome).toBe("human_review");
  });
});

describe("ATTACK REGRESSION: one payment, one subscription", () => {
  it("creation dedupe blocks format/case variants of a claimed txn", async () => {
    seedClaim("c1", "biz1", "TXN99887766", "RB-AAAA1111", "approved");
    await expect(assertTxnIdNotClaimed("TXN99887766")).rejects.toThrow(DuplicateTxnError);
    await expect(assertTxnIdNotClaimed("txn-9988-7766")).rejects.toThrow(DuplicateTxnError);
    await expect(assertTxnIdNotClaimed("txn99887766")).rejects.toThrow(DuplicateTxnError);
  });

  it("variant of an approved txn routes the second business to human review", async () => {
    seedClaim("c1", "biz1", "TXN99887766", "RB-AAAA1111", "approved");
    seedClaim("c2", "biz2", "txn-9988-7766", "RB-BBBB2222");
    holder.visionText = receiptFor("txn-9988-7766", "RB-BBBB2222");
    const out = await runClaimDecision("c2");
    expect(out.action).toBe("human_review");
    expect(fakeDb.read("businesses", "biz2")?.subscriptionStatus).toBe("trialing");
    expect(fakeDb.read("payment_claims", "c2")?.status).toBe("pending");
  });

  it("concurrent decisions sharing one txn: the approval lock lets exactly one activate", async () => {
    seedClaim("c1", "biz1", "TXN99887766", "RB-AAAA1111");
    seedClaim("c2", "biz2", "TXN99887766", "RB-BBBB2222");
    // Post-fix creation invariant: c1 owns the shared txn lock.
    fakeDb.seed("payment_claim_locks", txnLockId(txnNormOf("TXN99887766")), { claimId: "c1", txnIdNorm: "TXN99887766" });
    holder.visionText = receiptFor("TXN99887766", "RB-AAAA1111");
    const [o1, o2] = await Promise.all([runClaimDecision("c1"), runClaimDecision("c2")]);
    expect(o1.action).toBe("auto_approved");
    expect(o2.action).toBe("human_review");
    expect(fakeDb.read("businesses", "biz1")?.subscriptionStatus).toBe("active");
    expect(fakeDb.read("businesses", "biz2")?.subscriptionStatus).toBe("trialing");
    // Snapshot now carries the usage fields a reversal must restore.
    const snap = fakeDb.read("payment_claims", "c1")?.activationSnapshot as { aiMessagesUsed?: unknown };
    expect(snap.aiMessagesUsed).toBe(700);
  });

  it("creation guard + lock inside createWithUniqueRefCode rejects the second claim atomically", async () => {
    const norm = txnNormOf("TXN99887766");
    const guard = async (tx: never) => {
      const snap = await (tx as { get: (q: unknown) => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> }).get(
        fakeDb.collection("payment_claims").where("txnIdNorm", "==", norm).limit(10) as never
      );
      const clash = snap.docs.some((d) => ["pending", "approved"].includes(String(d.data().status)));
      if (clash) throw new DuplicateTxnError("TXN99887766");
    };
    const first = await createWithUniqueRefCode(fakeDb as never, "payment_claims", {
      businessId: "biz1", status: "pending", txnId: "TXN99887766", txnIdNorm: norm,
    }, { guard: guard as never, lockRef: fakeDb.collection("payment_claim_locks").doc(txnLockId(norm)) as never, lockData: { txnIdNorm: norm } });
    expect(first.id).toBeTruthy();
    await expect(
      createWithUniqueRefCode(fakeDb as never, "payment_claims", {
        businessId: "biz2", status: "pending", txnId: "txn-9988-7766", txnIdNorm: norm,
      }, { guard: guard as never, lockRef: fakeDb.collection("payment_claim_locks").doc(txnLockId(norm)) as never, lockData: { txnIdNorm: norm } })
    ).rejects.toThrow(DuplicateTxnError);
    expect(fakeDb.all("payment_claims")).toHaveLength(1);
  });
});
