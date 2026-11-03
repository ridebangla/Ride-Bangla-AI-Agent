import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  resolveCustomer,
  findCustomerByChannelContact,
  normalizeChannelContact,
} from "@/lib/customer-resolver";
import { __resetWidgetSiteKeyCache } from "@/lib/widget-sitekey-cache";
import { createRequest, parseJsonResponse } from "../helpers/request";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

vi.mock("@/lib/tenant", () => ({
  getBusinessBySiteKey: vi.fn(async (key: string) =>
    key === "good-key" ? { id: "biz-1", name: "Biz" } : null
  ),
  enterBusinessContext: vi.fn(),
  runWithBusiness: vi.fn((_id: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/subscription", () => ({
  getSubscription: vi.fn(async () => ({ isActive: true })),
}));

vi.mock("@/lib/billing-usage", () => ({
  checkMessageLimitExceeded: vi.fn(async () => false),
}));

vi.mock("@/lib/ai/engine", () => ({
  chat: vi.fn(async () => ({
    response: "Hello from the widget",
    products: [],
    silent: false,
  })),
  isPureGreeting: vi.fn(() => false),
  buildGreetingReply: vi.fn(() => ""),
}));

vi.mock("@/lib/ai/activity", () => ({
  parseActivityToken: vi.fn(() => null),
  bindActivityToken: vi.fn(async () => {}),
}));

vi.mock("@/lib/social/accounts", () => ({
  getActiveAccounts: vi.fn(async () => [
    {
      id: "acc-1",
      platform: "facebook",
      accountRef: "page-1",
      label: "Page",
      autoReply: false,
    },
  ]),
  getDecryptedToken: vi.fn(() => "tok"),
}));

vi.mock("@/lib/social/ai", () => ({
  getOpenAI: vi.fn(async () => ({
    client: {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "Thanks for commenting!" } }],
          })),
        },
      },
    },
    settings: { businessName: "Biz", businessDesc: "" },
  })),
  getKnowledgeContext: vi.fn(async () => ""),
}));

/**
 * Team H — customer identity wiring gaps (Team C findings, verified
 * from code before fixing):
 *  (a) the widget route never called resolveCustomer, so website
 *      visitors were never unified with any other identity;
 *  (b) telegram/messenger/instagram contacts were dropped by
 *      createCustomer, so the same platform user got a NEW Customer
 *      row on every message;
 *  (c) SocialInteraction.customerRef was never resolved, so comment
 *      authors were never unified with chat customers.
 * The in-memory store below mimics the Firestore delegate's scalar
 * matching (exact equality, {equals, mode: insensitive}, {contains},
 * AND/OR) for the where shapes the resolver emits.
 */

type Row = { id: string; [k: string]: unknown };

let rows: Row[];
let seq: number;
let convRows: Row[];
let convSeq: number;
let interactionRows: Row[];

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  if (!where) return true;
  if (Array.isArray(where.AND)) {
    return (where.AND as Record<string, unknown>[]).every((w) =>
      matchesWhere(row, w)
    );
  }
  if (Array.isArray(where.OR)) {
    return (where.OR as Record<string, unknown>[]).some((w) =>
      matchesWhere(row, w)
    );
  }
  return Object.entries(where).every(([field, cond]) => {
    if (field === "AND" || field === "OR") return true;
    const val = String(row[field] ?? "");
    if (typeof cond === "string") return val === cond;
    if (cond && typeof cond === "object") {
      const c = cond as { contains?: string; equals?: string; mode?: string };
      if (c.contains !== undefined) return val.includes(c.contains);
      if (c.equals !== undefined) {
        return c.mode === "insensitive"
          ? val.toLowerCase() === c.equals.toLowerCase()
          : val === c.equals;
      }
    }
    return false;
  });
}

function installCustomerHarness() {
  mockPrisma.customer.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => matchesWhere(r, where)) ?? null
  );
  mockPrisma.customer.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null
  );
  mockPrisma.customer.create.mockImplementation(
    async ({ data }: { data: Row }) => {
      const row: Row = {
        email: "",
        phone: "",
        whatsapp: "",
        telegram: "",
        messenger: "",
        instagram: "",
        widgetVisitorId: "",
        ...data,
        id: `cust-${++seq}`,
      };
      rows.push(row);
      return row;
    }
  );
  mockPrisma.customer.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? {};
    }
  );
}

function installConversationHarness() {
  mockPrisma.conversation.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      convRows.find((c) => c.id === where.id) ?? null
  );
  mockPrisma.conversation.create.mockImplementation(
    async ({ data }: { data: Row }) => {
      const row: Row = { ...data, id: `conv-${++convSeq}` };
      convRows.push(row);
      return row;
    }
  );
  mockPrisma.conversation.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = convRows.find((c) => c.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? {};
    }
  );
}

beforeEach(() => {
  rows = [];
  seq = 0;
  convRows = [];
  convSeq = 0;
  interactionRows = [];
  vi.clearAllMocks();
  __resetWidgetSiteKeyCache();
  installCustomerHarness();
  installConversationHarness();
  mockPrisma.settings.findFirst.mockResolvedValue(null);
  mockPrisma.socialInteraction.findMany.mockResolvedValue([]);
  mockPrisma.socialInteraction.create.mockImplementation(
    async ({ data }: { data: Row }) => {
      const row: Row = { ...data, id: `si-${interactionRows.length + 1}` };
      interactionRows.push(row);
      return row;
    }
  );
  mockPrisma.socialAccount.update.mockResolvedValue({});
});

describe("normalizeChannelContact", () => {
  it("lowercases telegram handles, leaves numeric chat ids alone", () => {
    expect(normalizeChannelContact("telegram", "@Alice")).toBe("@alice");
    expect(normalizeChannelContact("telegram", "123456789")).toBe("123456789");
  });
  it("matches PSIDs and visitor ids exactly", () => {
    expect(normalizeChannelContact("messenger", "PSID-9")).toBe("PSID-9");
    expect(normalizeChannelContact("widget", "visitor-1")).toBe("visitor-1");
  });
});

describe("(b) channel-identifier resolution — one platform user, one row", () => {
  it("same telegram user, different handle case → ONE row, stored lowercase", async () => {
    const a = await resolveCustomer("telegram", "@Alice", "Alice");
    const b = await resolveCustomer("telegram", "@ALICE", "Alice");
    expect(b).toBe(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].telegram).toBe("@alice");
  });

  it("distinct telegram contacts stay distinct even with the same name", async () => {
    const a = await resolveCustomer("telegram", "@alice", "Alice");
    const b = await resolveCustomer("telegram", "@alice2", "Alice");
    expect(b).not.toBe(a);
    expect(rows).toHaveLength(2);
  });

  it("same Meta PSID twice → ONE row per channel; different PSID → distinct", async () => {
    const a = await resolveCustomer("messenger", "psid-9", "Meta User");
    const b = await resolveCustomer("messenger", "psid-9", "Meta User");
    const c = await resolveCustomer("messenger", "psid-10", "Meta User");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(rows).toHaveLength(2);
    expect(rows[0].messenger).toBe("psid-9");
  });

  it("same instagram id twice → ONE row", async () => {
    const a = await resolveCustomer("instagram", "ig-7", "Meta User");
    const b = await resolveCustomer("instagram", "ig-7", "Meta User");
    expect(b).toBe(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].instagram).toBe("ig-7");
  });

  it("same widget visitorId twice → ONE row, stored as widgetVisitorId", async () => {
    const a = await resolveCustomer("widget", "visitor-1", "Website Visitor");
    const b = await resolveCustomer("widget", "visitor-1", "Website Visitor");
    const c = await resolveCustomer("widget", "visitor-2", "Website Visitor");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(rows).toHaveLength(2);
    expect(rows[0].widgetVisitorId).toBe("visitor-1");
  });

  it("no cross-channel merge on weak signals: a phone customer + an unrelated telegram handle stay separate", async () => {
    const phone = await resolveCustomer("phone", "+15551234567", "Sam");
    const tg = await resolveCustomer("telegram", "@sam", "Sam");
    expect(tg).not.toBe(phone);
    expect(rows).toHaveLength(2);
  });

  it("a telegram id and a messenger id with similar text are different fields, different rows", async () => {
    const a = await resolveCustomer("telegram", "12345", "User");
    const b = await resolveCustomer("messenger", "12345", "User");
    expect(b).not.toBe(a);
    expect(rows).toHaveLength(2);
  });
});

describe("(c) lookup-only resolution for comment authors", () => {
  it("returns the existing id on an exact match and never creates", async () => {
    const id = await resolveCustomer("messenger", "psid-9", "Meta User");
    mockPrisma.customer.create.mockClear();
    expect(await findCustomerByChannelContact("messenger", "psid-9")).toBe(id);
    expect(mockPrisma.customer.create).not.toHaveBeenCalled();
  });

  it("returns null on a miss and still never creates", async () => {
    await resolveCustomer("messenger", "psid-9", "Meta User");
    mockPrisma.customer.create.mockClear();
    expect(await findCustomerByChannelContact("messenger", "psid-99")).toBeNull();
    expect(await findCustomerByChannelContact("instagram", "psid-9")).toBeNull();
    expect(mockPrisma.customer.create).not.toHaveBeenCalled();
  });

  it("returns null for channels with no identifier field and for empty contacts", async () => {
    expect(await findCustomerByChannelContact("x", "author-1")).toBeNull();
    expect(await findCustomerByChannelContact("messenger", "")).toBeNull();
    expect(mockPrisma.customer.create).not.toHaveBeenCalled();
  });
});

describe("(a) widget route sets customerId", () => {
  async function post(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/chat/widget/route");
    const res = await POST(
      createRequest("/api/chat/widget", { method: "POST", body })
    );
    return { res, data: await parseJsonResponse(res) };
  }

  it("first supplied visit creates a conversation WITH customerId", async () => {
    const { res, data } = await post({
      siteKey: "good-key",
      message: "hello",
      visitorId: "visitor-1",
    });
    expect(res.status).toBe(200);
    expect(data.conversationId).toBe("conv-1");
    expect(convRows[0].customerId).toBe("cust-1");
    expect(convRows[0].customerContact).toBe("visitor-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].widgetVisitorId).toBe("visitor-1");
  });

  it("returning visitor resolves to the SAME customer row on a new conversation", async () => {
    await post({ siteKey: "good-key", message: "hi", visitorId: "visitor-1" });
    const { res, data } = await post({
      siteKey: "good-key",
      message: "hi again",
      visitorId: "visitor-1",
    });
    expect(res.status).toBe(200);
    expect(data.conversationId).toBe("conv-2");
    expect(convRows[1].customerId).toBe("cust-1");
    expect(rows).toHaveLength(1);
  });

  it("backfills customerId onto a pre-fix thread on return visit, never overwrites an existing one", async () => {
    convRows.push({
      id: "conv-old",
      channel: "widget",
      customerContact: "visitor-1",
      customerId: null,
    } as Row);
    convRows.push({
      id: "conv-owned",
      channel: "widget",
      customerContact: "visitor-1",
      customerId: "cust-other",
    } as Row);
    await post({
      siteKey: "good-key",
      message: "back",
      visitorId: "visitor-1",
      conversationId: "conv-old",
    });
    expect(convRows[0].customerId).toBe("cust-1");
    await post({
      siteKey: "good-key",
      message: "back",
      visitorId: "visitor-1",
      conversationId: "conv-owned",
    });
    expect(convRows[1].customerId).toBe("cust-other");
    expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
  });

  it("missing visitorId creates NO customer row and no customerId (anon skip)", async () => {
    const { res, data } = await post({ siteKey: "good-key", message: "hello" });
    expect(res.status).toBe(200);
    expect(data.conversationId).toBe("conv-1");
    expect(convRows[0].customerId).toBeUndefined();
    expect(rows).toHaveLength(0);
  });

  it("a resolution failure is fail-soft: the turn still completes without customerId", async () => {
    mockPrisma.customer.findFirst.mockRejectedValueOnce(
      new Error("data layer down")
    );
    const { res, data } = await post({
      siteKey: "good-key",
      message: "hello",
      visitorId: "visitor-9",
    });
    expect(res.status).toBe(200);
    expect(data.response).toBe("Hello from the widget");
    expect(data.conversationId).toBe("conv-1");
    expect(convRows[0].customerId).toBeUndefined();
  });
});

describe("(c) engagement sync links comment authors by exact id only", () => {
  function installFetch() {
    const fetchMock = vi.fn(async (url: string) => {
      let payload: unknown = { data: [] };
      if (url.includes("/posts?")) {
        payload = { data: [{ id: "post-1", message: "Post", like_count: 0 }] };
      } else if (url.includes("/comments?")) {
        payload = {
          data: [
            {
              id: "c-1",
              from: { id: "psid-9", name: "Ana" },
              message: "Lovely!",
              like_count: 0,
            },
            {
              id: "c-2",
              from: { id: "psid-unknown", name: "Ana" },
              message: "Nice!",
              like_count: 0,
            },
          ],
        };
      }
      return { ok: true, text: async () => JSON.stringify(payload) };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("links the known PSID author, leaves the unknown and name-lookalike unlinked", async () => {
    await resolveCustomer("messenger", "psid-9", "Meta User");
    installFetch();
    const { syncEngagement } = await import("@/lib/social/engagement");
    const result = await syncEngagement();
    expect(result.found).toBe(3); // 1 post + 2 comments
    const comments = interactionRows.filter((r) => r.kind === "comment");
    expect(comments).toHaveLength(2);
    expect(comments.find((r) => r.externalId === "c-1")?.customerId).toBe(
      "cust-1"
    );
    // Same display name, different PSID: no merge on name similarity.
    expect(
      comments.find((r) => r.externalId === "c-2")?.customerId
    ).toBeUndefined();
    // The comment sync created no new customer rows.
    expect(rows).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
