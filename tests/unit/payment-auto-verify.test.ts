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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    forEach(cb: (doc: FakeDocSnapshot) => void) {
      this.docs.forEach(cb);
    }
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

import { amountToCents, matchDeposits, USD_STABLECOINS } from "@/lib/exchanges/match";
import { binanceAdapter, bybitAdapter, okxAdapter } from "@/lib/exchanges";
import {
  parseReceiptExtraction,
  evaluateReceiptChecks,
  type ReceiptDecisionInput,
} from "@/lib/payment-decision";
import { runClaimDecision, runAutoVerify } from "@/lib/auto-verify";

const SHOT =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBIiMkESQh/9k=";

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function receiptText(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    RECEIPT: "YES",
    AMOUNT: "19.00",
    CURRENCY: "USD",
    TXN: "TXN99887766",
    DATE: todayLabel(),
    RECIPIENT: "Ride Bangla LLC",
    NOTE: "RB-TEST1234",
    ...overrides,
  };
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

beforeEach(() => {
  fakeDb.clear();
  holder.keys = { openai: "test-key" };
  holder.visionText = receiptText();
  holder.visionError = false;
  delete process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_API_SECRET;
  delete process.env.BYBIT_API_KEY;
  delete process.env.BYBIT_API_SECRET;
  delete process.env.OKX_API_KEY;
  delete process.env.OKX_API_SECRET;
  delete process.env.OKX_API_PASSPHRASE;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
describe("amountToCents", () => {
  it("parses decimal strings and numbers to integer cents", () => {
    expect(amountToCents("19.00000000")).toBe(1900);
    expect(amountToCents("0.5")).toBe(50);
    expect(amountToCents(19.99)).toBe(1999);
    expect(amountToCents("1,234.56")).toBe(123456);
  });
  it("returns null for unparsable or non-positive values", () => {
    expect(amountToCents("abc")).toBeNull();
    expect(amountToCents("")).toBeNull();
    expect(amountToCents("-5")).toBeNull();
    expect(amountToCents("0")).toBeNull();
    expect(amountToCents(null)).toBeNull();
    expect(amountToCents(undefined)).toBeNull();
  });
});

describe("matchDeposits", () => {
  const opts = { refCode: "RB-TEST1234", amountCents: 1900, since: new Date() };
  const good = {
    memo: "payment RB-TEST1234 thanks",
    amountCents: 1900,
    coin: "USDT",
    txId: "dep-1",
    final: true,
  };
  it("matches ref + stablecoin + exact amount + final", () => {
    const res = matchDeposits("Binance", [good], opts);
    expect(res.found).toBe(true);
    expect(USD_STABLECOINS.has("USDT")).toBe(true);
  });
  it("rejects wrong amount, non-stable coin, non-final, missing ref", () => {
    expect(matchDeposits("Binance", [{ ...good, amountCents: 1800 }], opts).found).toBe(false);
    expect(matchDeposits("Binance", [{ ...good, coin: "BTC" }], opts).found).toBe(false);
    expect(matchDeposits("Binance", [{ ...good, final: false }], opts).found).toBe(false);
    const noRef = matchDeposits("Binance", [{ ...good, memo: "other" }], opts);
    expect(noRef.found).toBe(false);
    expect(noRef.note).toMatch(/no deposit mentioning/i);
  });
  it("ref seen but unusable → note routes to human review", () => {
    const res = matchDeposits("Binance", [{ ...good, amountCents: 1 }], opts);
    expect(res.found).toBe(false);
    expect(res.note).toMatch(/human review/i);
  });
});

// ---------------------------------------------------------------------------
describe("exchange adapters (stubbed fetch fixtures)", () => {
  const opts = { refCode: "RB-TEST1234", amountCents: 1900, since: new Date(Date.now() - 3600_000) };

  it("binance: signed request, fixture deposit matches", async () => {
    process.env.BINANCE_API_KEY = "bk";
    process.env.BINANCE_API_SECRET = "bs";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { amount: "19.00000000", coin: "USDT", status: 1, addressTag: "RB-TEST1234", txId: "dep-9" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await binanceAdapter.findDeposit(opts);
    expect(res.found).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain("/sapi/v1/capital/deposit/hisrec");
    expect(url).toContain("signature=");
    expect(init.headers["X-MBX-APIKEY"]).toBe("bk");
  });

  it("binance: HTTP error surfaces as a throw (sweep records 'failed')", async () => {
    process.env.BINANCE_API_KEY = "bk";
    process.env.BINANCE_API_SECRET = "bs";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(binanceAdapter.findDeposit(opts)).rejects.toThrow(/HTTP 500/);
  });

  it("bybit: fixture deposit matches; retCode error throws", async () => {
    process.env.BYBIT_API_KEY = "yk";
    process.env.BYBIT_API_SECRET = "ys";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          retCode: 0,
          result: { rows: [{ coin: "USDC", amount: "19.00", txID: "dep-2", tag: "RB-TEST1234", status: 2 }] },
        }),
      }))
    );
    expect((await bybitAdapter.findDeposit(opts)).found).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ retCode: 10001, retMsg: "params error", result: {} }) }))
    );
    await expect(bybitAdapter.findDeposit(opts)).rejects.toThrow(/retCode 10001/);
  });

  it("okx: only state '2' (successful) deposits match", async () => {
    process.env.OKX_API_KEY = "ok";
    process.env.OKX_API_SECRET = "os";
    process.env.OKX_API_PASSPHRASE = "op";
    const row = { amt: "19.00", ccy: "USDT", txId: "dep-3", memo: "RB-TEST1234", state: "2" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: "0", data: [row] }) })));
    expect((await okxAdapter.findDeposit(opts)).found).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ code: "0", data: [{ ...row, state: "1" }] }) }))
    );
    expect((await okxAdapter.findDeposit(opts)).found).toBe(false);
  });

  it("all adapters: unconfigured without env keys", async () => {
    for (const adapter of [binanceAdapter, bybitAdapter, okxAdapter]) {
      expect(adapter.isConfigured()).toBe(false);
      const res = await adapter.findDeposit(opts);
      expect(res.found).toBe(false);
      expect(res.note).toMatch(/not configured/i);
    }
  });
});

// ---------------------------------------------------------------------------
describe("parseReceiptExtraction", () => {
  it("parses the labeled vision answer", () => {
    const ex = parseReceiptExtraction(receiptText());
    expect(ex.isReceipt).toBe(true);
    expect(ex.amountCents).toBe(1900);
    expect(ex.currency).toBe("USD");
    expect(ex.txnId).toBe("TXN99887766");
    expect(ex.date).toBeInstanceOf(Date);
    expect(ex.recipient).toBe("Ride Bangla LLC");
    expect(ex.noteText).toBe("RB-TEST1234");
  });
  it("UNKNOWN values become nulls", () => {
    const ex = parseReceiptExtraction(receiptText({ AMOUNT: "UNKNOWN", TXN: "UNKNOWN" }));
    expect(ex.amountCents).toBeNull();
    expect(ex.txnId).toBeNull();
  });
});

describe("evaluateReceiptChecks", () => {
  const base = (): ReceiptDecisionInput => ({
    claimAmountCents: 1900,
    claimTxnId: "TXN99887766",
    refCode: "RB-TEST1234",
    claimCreatedAt: new Date(),
    extraction: parseReceiptExtraction(receiptText()),
    expectedRecipient: "Ride Bangla LLC",
    txnAlreadyApprovedElsewhere: false,
    now: new Date(),
  });

  it("all checks pass → auto_approve", () => {
    const d = evaluateReceiptChecks(base());
    expect(d.outcome).toBe("auto_approve");
    expect(d.checks.every((c) => c.ok)).toBe(true);
  });

  it("vision unavailable → human_review", () => {
    const d = evaluateReceiptChecks({
      ...base(),
      extraction: null,
      visionUnavailableReason: "AI backend not configured.",
    });
    expect(d.outcome).toBe("human_review");
    expect(d.checks.find((c) => c.name === "vision_available")?.ok).toBe(false);
  });

  it("amount mismatch → human_review", () => {
    const d = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(receiptText({ AMOUNT: "25.00" })),
    });
    expect(d.outcome).toBe("human_review");
    expect(d.checks.find((c) => c.name === "amount_exact")?.ok).toBe(false);
  });

  it("explicit non-USD currency → human_review; unread currency tolerated", () => {
    const cny = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(receiptText({ CURRENCY: "CNY" })),
    });
    expect(cny.checks.find((c) => c.name === "currency_ok")?.ok).toBe(false);
    const unread = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(receiptText({ CURRENCY: "UNKNOWN" })),
    });
    expect(unread.checks.find((c) => c.name === "currency_ok")?.ok).toBe(true);
  });

  it("txn mismatch is rescued only by the refCode on the screenshot", () => {
    const noRef = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(receiptText({ TXN: "OTHER123456", NOTE: "rent" })),
    });
    expect(noRef.checks.find((c) => c.name === "txn_or_ref_match")?.ok).toBe(false);
    const withRef = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(receiptText({ TXN: "OTHER123456" })),
    });
    expect(withRef.checks.find((c) => c.name === "txn_or_ref_match")?.ok).toBe(true);
  });

  it("future or stale dates fail", () => {
    const future = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(
        receiptText({ DATE: new Date(Date.now() + 10 * 86400_000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) })
      ),
    });
    expect(future.checks.find((c) => c.name === "date_sane")?.ok).toBe(false);
    const stale = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(
        receiptText({ DATE: new Date(Date.now() - 60 * 86400_000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) })
      ),
    });
    expect(stale.checks.find((c) => c.name === "date_sane")?.ok).toBe(false);
  });

  it("recipient mismatch fails; unconfigured recipient skips", () => {
    const bad = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(receiptText({ RECIPIENT: "Someone Else" })),
    });
    expect(bad.checks.find((c) => c.name === "recipient_match")?.ok).toBe(false);
    const skipped = evaluateReceiptChecks({ ...base(), expectedRecipient: null });
    expect(skipped.checks.find((c) => c.name === "recipient_match")?.ok).toBe(true);
  });

  it("txn already approved elsewhere blocks auto-activation", () => {
    const d = evaluateReceiptChecks({ ...base(), txnAlreadyApprovedElsewhere: true });
    expect(d.outcome).toBe("human_review");
    expect(d.checks.find((c) => c.name === "txn_unique")?.ok).toBe(false);
  });

  it("non-receipt screenshot fails", () => {
    const d = evaluateReceiptChecks({
      ...base(),
      extraction: parseReceiptExtraction(receiptText({ RECEIPT: "NO" })),
    });
    expect(d.checks.find((c) => c.name === "is_receipt")?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("runClaimDecision (orchestration, FakeDb)", () => {
  function seedBankClaim(overrides: Record<string, unknown> = {}) {
    fakeDb.seed("payment_methods_config", "us_bank", {
      enabled: true,
      accountName: "Ride Bangla LLC",
    });
    fakeDb.seed("businesses", "biz1", {
      subscriptionStatus: "trialing",
      plan: "trial",
    });
    fakeDb.seed("payment_claims", "c1", {
      businessId: "biz1",
      kind: "subscription",
      status: "pending",
      method: "us_bank",
      plan: "starter",
      interval: "monthly",
      amount: 19,
      amountCents: 1900,
      txnId: "TXN99887766",
      refCode: "RB-TEST1234",
      screenshotDataUrl: SHOT,
      createdAt: new Date(),
      ...overrides,
    });
  }

  it("clean bank claim auto-activates with decision, snapshot and audit", async () => {
    seedBankClaim();
    const out = await runClaimDecision("c1");
    expect(out.action).toBe("auto_approved");

    const claim = fakeDb.read("payment_claims", "c1")!;
    expect(claim.status).toBe("approved");
    expect(claim.approvedBy).toBe("auto-verify");
    const decision = claim.decision as { outcome: string; checks: Array<{ ok: boolean }> };
    expect(decision.outcome).toBe("auto_approve");
    expect(decision.checks.every((c) => c.ok)).toBe(true);
    const snapshot = claim.activationSnapshot as { subscriptionStatus: string; plan: string };
    expect(snapshot.subscriptionStatus).toBe("trialing");
    expect(snapshot.plan).toBe("trial");

    const biz = fakeDb.read("businesses", "biz1")!;
    expect(biz.subscriptionStatus).toBe("active");
    expect(biz.plan).toBe("starter");

    const audits = fakeDb.all("admin_audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0].actorName).toBe("Auto-Verify (AI)");
    expect(audits[0].actorRole).toBe("system");
    expect(audits[0].category).toBe("finance");
    expect(audits[0].status).toBe("success");
    // Full txn id must never appear in an audit note (masked only).
    expect(String(audits[0].note)).not.toContain("TXN99887766");
    expect(String(audits[0].note)).toContain("••••7766");
  });

  it("panel-created plan claim auto-activates (attack-test 2026-10-21)", async () => {
    seedBankClaim({ plan: "team", amount: 29, amountCents: 2900 });
    fakeDb.seed("ai_plans", "team", {
      name: "Team",
      priceUsd: 29,
      yearlyPriceUsd: 290,
      tagline: "",
      messagesPerMonth: 2000,
      active: true,
    });
    holder.visionText = receiptText({ AMOUNT: "29.00" });
    const out = await runClaimDecision("c1");
    expect(out.action).toBe("auto_approved");
    const claim = fakeDb.read("payment_claims", "c1")!;
    expect(claim.status).toBe("approved");
    expect(claim.activationSnapshot).toBeTruthy();
    const biz = fakeDb.read("businesses", "biz1")!;
    expect(biz.subscriptionStatus).toBe("active");
    expect(biz.plan).toBe("team");
  });

  it("claim for an unknown plan id does NOT auto-activate (attack-test 2026-10-21)", async () => {
    seedBankClaim({ plan: "bogus-plan", amount: 29, amountCents: 2900 });
    holder.visionText = receiptText({ AMOUNT: "29.00" });
    const out = await runClaimDecision("c1");
    expect(out.action).not.toBe("auto_approved");
    expect(fakeDb.read("payment_claims", "c1")!.status).toBe("pending");
    expect(fakeDb.read("businesses", "biz1")!.subscriptionStatus).toBe("trialing");
  });

  it("amount mismatch stays pending with evidence — never auto-rejected", async () => {
    seedBankClaim();
    holder.visionText = receiptText({ AMOUNT: "25.00" });
    const out = await runClaimDecision("c1");
    expect(out.action).toBe("human_review");
    const claim = fakeDb.read("payment_claims", "c1")!;
    expect(claim.status).toBe("pending");
    const decision = claim.decision as { outcome: string; checks: Array<{ name: string; ok: boolean }> };
    expect(decision.outcome).toBe("human_review");
    expect(decision.checks.find((c) => c.name === "amount_exact")?.ok).toBe(false);
    expect(fakeDb.read("businesses", "biz1")!.subscriptionStatus).toBe("trialing");
    const audits = fakeDb.all("admin_audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe("info");
  });

  it("no AI backend → human review with vision evidence", async () => {
    seedBankClaim();
    holder.keys = {};
    const out = await runClaimDecision("c1");
    expect(out.action).toBe("human_review");
    const decision = fakeDb.read("payment_claims", "c1")!.decision as {
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(decision.checks.find((c) => c.name === "vision_available")?.ok).toBe(false);
  });

  it("an already-decided claim is left to the human queue", async () => {
    seedBankClaim({
      decision: { by: "ai", outcome: "human_review", checks: [] },
    });
    const out = await runClaimDecision("c1");
    expect(out.action).toBe("skipped");
    expect(fakeDb.read("payment_claims", "c1")!.status).toBe("pending");
  });

  it("wallet deposit claims are not decided here", async () => {
    seedBankClaim({ kind: "wallet_deposit" });
    const out = await runClaimDecision("c1");
    expect(out.action).toBe("skipped");
  });

  it("crypto claim activates on a matched fixture deposit", async () => {
    process.env.BINANCE_API_KEY = "bk";
    process.env.BINANCE_API_SECRET = "bs";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { amount: "19.00000000", coin: "USDT", status: 1, addressTag: "RB-TEST1234", txId: "dep-9" },
        ],
      }))
    );
    fakeDb.seed("businesses", "biz1", { subscriptionStatus: "trialing", plan: "trial" });
    fakeDb.seed("payment_claims", "c9", {
      businessId: "biz1",
      kind: "subscription",
      status: "pending",
      method: "binance",
      plan: "starter",
      interval: "monthly",
      amount: 19,
      amountCents: 1900,
      txnId: "dep-9",
      refCode: "RB-TEST1234",
      screenshotDataUrl: SHOT,
      createdAt: new Date(),
    });
    const out = await runClaimDecision("c9");
    expect(out.action).toBe("matched_approved");
    expect(fakeDb.read("payment_claims", "c9")!.status).toBe("approved");
    expect(fakeDb.read("businesses", "biz1")!.subscriptionStatus).toBe("active");
    const audits = fakeDb.all("admin_audit_logs");
    expect(audits).toHaveLength(1);
    expect(String(audits[0].note)).not.toContain("dep-9");
  });

  it("crypto claim without exchange keys stays pending, honestly marked", async () => {
    fakeDb.seed("payment_claims", "c10", {
      businessId: "biz1",
      kind: "subscription",
      status: "pending",
      method: "binance",
      plan: "starter",
      interval: "monthly",
      amount: 19,
      amountCents: 1900,
      txnId: "dep-x",
      refCode: "RB-TEST1234",
      screenshotDataUrl: SHOT,
      createdAt: new Date(),
    });
    const out = await runClaimDecision("c10");
    expect(out.action).toBe("not_configured");
    const claim = fakeDb.read("payment_claims", "c10")!;
    expect(claim.status).toBe("pending");
    expect((claim.autoVerify as { status: string }).status).toBe("not_configured");
  });

  it("sweep decides an undecided bank claim (backstop path)", async () => {
    seedBankClaim();
    const outcomes = await runAutoVerify();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("auto_approved");
    expect(fakeDb.read("payment_claims", "c1")!.status).toBe("approved");
  });
});
