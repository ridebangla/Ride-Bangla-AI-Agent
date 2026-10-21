/**
 * Behaviour package (owner directive 2026-10-21) — scripted fixture
 * conversations + unit tests for the pure decision logic.
 *
 * Spec scenarios:
 *  (a) resolved issue → exactly one review ask, with the correct link
 *  (b) angry / unresolved thread → no ask, ever
 *  (c) same customer again within the cap → no second ask
 *  (d) factual price question → answer matches the KB fixture, and the
 *      system prompt carries the KB + the answer-discipline doctrine
 *  (e) follow-up rule fires once in the harness and is activity-visible
 *  (f) tenant isolation — business A's agent never uses B's link/KB
 *
 * The LLM is replaced by a deterministic provider stub; tools are
 * stubbed at executeToolCall so order signals come from the REAL tool
 * result JSON shape. Everything else (engine, behaviour module, follow-
 * up processor, data-layer mocks) is the production code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai/providers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/ai/providers")>();
  return {
    ...orig,
    resolveSiteKeys: vi.fn(async () => ({ openai: "sk-test-key" })),
    completeWithFallback: vi.fn(),
  };
});

vi.mock("@/lib/ai/tools", () => ({
  agentTools: [],
  executeToolCall: vi.fn(),
}));

vi.mock("@/lib/channels/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/channels/sms", () => ({ sendSms: vi.fn(async () => true) }));
vi.mock("@/lib/channels/email", () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/channels/telegram", () => ({
  sendTelegramMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { chat, buildSystemPrompt } from "@/lib/ai/engine";
import { completeWithFallback, type ChatCompletionRequest } from "@/lib/ai/providers";
import { executeToolCall } from "@/lib/ai/tools";
import { processDueFollowUps } from "@/lib/followups";
import { sendWhatsAppMessage } from "@/lib/channels/whatsapp";
import {
  AGENT_BEHAVIOUR_DOCTRINE,
  REVIEW_ASK_MIN_INTERVAL_DAYS,
  detectHandoff,
  evaluateReviewAsk,
  getBehaviourSettings,
  resolveReviewLink,
  detectPositiveClosing,
  isNegativeMessage,
  type ReviewAskSignals,
} from "@/lib/ai/behaviour";

type MockFn = ReturnType<typeof vi.fn>;
const m = (fn: unknown) => fn as MockFn;

const REVIEW_LINK_A = "https://reviews.example.com/business-a";
const WEBSITE_B = "https://shop-b.example.com";

interface Captured {
  providerRequests: ChatCompletionRequest[];
  reviewAsksCreated: Array<Record<string, unknown>>;
  followUpsCreated: Array<Record<string, unknown>>;
  messagesCreated: Array<Record<string, unknown>>;
  conversationUpdates: Array<Record<string, unknown>>;
}

let captured: Captured;

function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    businessName: "Acme Store",
    businessDesc: "A neighbourhood store in Faridpur.",
    welcomeMessage: "Welcome!",
    tone: "friendly",
    language: "auto",
    agentBehavior: "",
    aiProvider: "openai",
    aiModel: "gpt-4o-mini",
    aiApiKey: "sk-test",
    maxTokens: 1024,
    temperature: 0.7,
    aiEnabled: true,
    reviewRequestsEnabled: true,
    followUpsEnabled: true,
    reviewUrl: REVIEW_LINK_A,
    followUpOrderCheckInHours: 24,
    followUpDroppedHours: 48,
    ...overrides,
  };
}

function conversationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    businessId: "test-business",
    customerId: "cust-1",
    customerName: "Rahim",
    customerContact: "+8801700000000",
    channel: "widget",
    status: "open",
    aiEnabled: true,
    satisfaction: null,
    metadata: null,
    messages: [] as Array<Record<string, unknown>>,
    ...overrides,
  };
}

function wirePrisma(opts: {
  settings?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  business?: Record<string, unknown> | null;
  kb?: Array<Record<string, unknown>>;
  lastReviewAsk?: Record<string, unknown> | null;
}) {
  m(prisma.settings.findFirst).mockResolvedValue(opts.settings ?? baseSettings());
  m(prisma.conversation.findUnique).mockResolvedValue(
    opts.conversation ?? conversationFixture()
  );
  m(prisma.business.findUnique).mockResolvedValue(
    opts.business === undefined
      ? { id: "test-business", websiteUrl: "https://acme.example.com", websites: [] }
      : opts.business
  );
  m(prisma.knowledgeEntry.findMany).mockResolvedValue(opts.kb ?? []);
  m(prisma.reviewAsk.findFirst).mockResolvedValue(opts.lastReviewAsk ?? null);
  m(prisma.ticket.findFirst).mockResolvedValue(null);
  m(prisma.customer.findFirst).mockResolvedValue(null);
  m(prisma.product?.findMany)?.mockResolvedValue?.([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  captured = {
    providerRequests: [],
    reviewAsksCreated: [],
    followUpsCreated: [],
    messagesCreated: [],
    conversationUpdates: [],
  };

  m(prisma.message.create).mockImplementation(async (args: { data: Record<string, unknown> }) => {
    captured.messagesCreated.push(args.data);
    return { id: `msg-${captured.messagesCreated.length}`, ...args.data };
  });
  m(prisma.conversation.update).mockImplementation(
    async (args: Record<string, unknown>) => {
      captured.conversationUpdates.push(args);
      return {};
    }
  );
  m(prisma.reviewAsk.create).mockImplementation(async (args: { data: Record<string, unknown> }) => {
    captured.reviewAsksCreated.push(args.data);
    return { id: "ra-1", ...args.data };
  });
  m(prisma.followUp.create).mockImplementation(async (args: { data: Record<string, unknown> }) => {
    captured.followUpsCreated.push(args.data);
    return { id: `fu-${captured.followUpsCreated.length}`, ...args.data };
  });
  m(prisma.followUp.update).mockResolvedValue({});
  // Default provider: a plain, confident, non-escalating reply.
  m(completeWithFallback).mockImplementation(async (req: ChatCompletionRequest) => {
    captured.providerRequests.push(req);
    return {
      provider: "openai",
      model: "gpt-4o-mini",
      text: "Happy to help! Let me know if there is anything else you need.",
    };
  });
  wirePrisma({});
});

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

describe("evaluateReviewAsk — the hard rules", () => {
  const base: ReviewAskSignals = {
    enabled: true,
    reviewLink: REVIEW_LINK_A,
    orderTaken: false,
    positiveClosing: false,
    satisfaction: null,
    negative: false,
    escalated: false,
    lastAskedAt: null,
    now: new Date("2026-10-21T06:00:00Z"),
  };

  it("asks after a completed order", () => {
    expect(evaluateReviewAsk({ ...base, orderTaken: true })).toEqual({
      ask: true,
      trigger: "order_completed",
    });
  });

  it("asks after a clearly positive closing", () => {
    expect(evaluateReviewAsk({ ...base, positiveClosing: true })).toEqual({
      ask: true,
      trigger: "positive_closing",
    });
  });

  it("asks on a 4+ satisfaction rating, not on 3", () => {
    expect(evaluateReviewAsk({ ...base, satisfaction: 5 }).ask).toBe(true);
    expect(evaluateReviewAsk({ ...base, satisfaction: 3 })).toEqual({
      ask: false,
      reason: "no_trigger",
    });
  });

  it("NEVER asks after a negative interaction", () => {
    expect(
      evaluateReviewAsk({ ...base, orderTaken: true, positiveClosing: true, negative: true })
    ).toEqual({ ask: false, reason: "negative_or_escalated" });
  });

  it("NEVER asks on an escalated conversation", () => {
    expect(evaluateReviewAsk({ ...base, positiveClosing: true, escalated: true })).toEqual({
      ask: false,
      reason: "negative_or_escalated",
    });
  });

  it("never asks without a real link, and never when disabled", () => {
    expect(evaluateReviewAsk({ ...base, positiveClosing: true, reviewLink: null })).toEqual({
      ask: false,
      reason: "no_link",
    });
    expect(evaluateReviewAsk({ ...base, positiveClosing: true, enabled: false })).toEqual({
      ask: false,
      reason: "disabled",
    });
  });

  it(`caps at one ask per customer per ${REVIEW_ASK_MIN_INTERVAL_DAYS} days`, () => {
    const recent = new Date(base.now.getTime() - 2 * 24 * 3600 * 1000);
    expect(evaluateReviewAsk({ ...base, positiveClosing: true, lastAskedAt: recent })).toEqual({
      ask: false,
      reason: "capped",
    });
    const longAgo = new Date(
      base.now.getTime() - (REVIEW_ASK_MIN_INTERVAL_DAYS + 1) * 24 * 3600 * 1000
    );
    expect(evaluateReviewAsk({ ...base, positiveClosing: true, lastAskedAt: longAgo }).ask).toBe(
      true
    );
  });

  it("no success signal → no ask (polite chatter is not success)", () => {
    expect(evaluateReviewAsk(base)).toEqual({ ask: false, reason: "no_trigger" });
  });
});

describe("detectors + settings + link resolution", () => {
  it("detects positive closings in English and Bengali", () => {
    expect(detectPositiveClosing("Thank you so much, that solved it!")).toBe(true);
    expect(detectPositiveClosing("অনেক ধন্যবাদ, কাজ হয়েছে")).toBe(true);
    expect(detectPositiveClosing("ok")).toBe(false);
    expect(detectPositiveClosing("what are your hours?")).toBe(false);
  });

  it("detects negative turns", () => {
    expect(isNegativeMessage("This is terrible, worst service ever")).toBe(true);
    expect(isNegativeMessage("Thanks, all good now")).toBe(false);
  });

  it("getBehaviourSettings: defaults ON, conservative timing, clamps", () => {
    expect(getBehaviourSettings({})).toEqual({
      reviewRequestsEnabled: true,
      followUpsEnabled: true,
      reviewUrl: "",
      followUpOrderCheckInHours: 24,
      followUpDroppedHours: 48,
    });
    expect(getBehaviourSettings({ reviewRequestsEnabled: false }).reviewRequestsEnabled).toBe(
      false
    );
    expect(getBehaviourSettings({ followUpDroppedHours: 9999 }).followUpDroppedHours).toBe(336);
    expect(getBehaviourSettings({ followUpOrderCheckInHours: 0 }).followUpOrderCheckInHours).toBe(
      1
    );
  });

  it("resolveReviewLink: business's own review URL wins; else primary website; else null", () => {
    const behaviour = getBehaviourSettings({ reviewUrl: REVIEW_LINK_A });
    expect(
      resolveReviewLink({ websiteUrl: "https://x.example.com", websites: [] }, behaviour)
    ).toBe(REVIEW_LINK_A);
    const noReviewUrl = getBehaviourSettings({});
    expect(
      resolveReviewLink(
        { websites: [{ url: WEBSITE_B }], websiteUrl: "https://legacy.example.com" },
        noReviewUrl
      )
    ).toBe(WEBSITE_B);
    expect(resolveReviewLink({ websiteUrl: "https://legacy.example.com" }, noReviewUrl)).toBe(
      "https://legacy.example.com"
    );
    expect(resolveReviewLink(null, noReviewUrl)).toBeNull();
    expect(resolveReviewLink({}, noReviewUrl)).toBeNull();
  });
});

describe("buildSystemPrompt carries the behaviour doctrine", () => {
  it("includes the doctrine verbatim + business instructions", () => {
    const prompt = buildSystemPrompt({
      businessName: "Acme Store",
      businessDesc: "",
      welcomeMessage: "",
      tone: "friendly",
      language: "auto",
      agentBehavior: "Always greet with Assalamu Alaikum.",
      knowledgeBase: [],
      customerName: "Rahim",
      customerHistory: [],
      channel: "widget",
    } as never);
    expect(prompt).toContain(AGENT_BEHAVIOUR_DOCTRINE);
    expect(prompt).toContain("## Answer Discipline — understand first, then answer");
    expect(prompt).toContain("Never invent a service");
    expect(prompt).toContain("Always greet with Assalamu Alaikum.");
  });
});

// ---------------------------------------------------------------------------
// Scripted fixture conversations through the real engine
// ---------------------------------------------------------------------------

describe("(a) resolved issue → exactly one review ask with the correct link", () => {
  it("plain question turn: no ask; happy closing turn: one ask, recorded once", async () => {
    const first = await chat("conv-1", "Do you deliver to Faridpur Sadar?");
    expect(first.response).not.toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(0);

    const second = await chat("conv-1", "Thank you so much, that solved it!");
    expect(second.response).toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(1);
    expect(captured.reviewAsksCreated[0].trigger).toBe("positive_closing");
    expect(captured.reviewAsksCreated[0].customerKey).toBe("cust:cust-1");
    // The ask is part of the SAVED assistant message, not just the return.
    const savedAssistant = captured.messagesCreated.filter((x) => x.role === "assistant");
    expect(savedAssistant[savedAssistant.length - 1].content).toContain(REVIEW_LINK_A);
  });

  it("Bengali happy closing → Bengali ask with the same link", async () => {
    const res = await chat("conv-1", "অনেক ধন্যবাদ, কাজ হয়েছে");
    expect(res.response).toContain("ধন্যবাদ");
    expect(res.response).toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(1);
  });
});

describe("(b) angry / unresolved thread → no ask", () => {
  it("angry refund demand: hands off to a human (ticket + yield) — and no review ask", async () => {
    const res = await chat(
      "conv-1",
      "This is terrible, worst service ever, I want a refund right now"
    );
    // Owner addition 12:24: a refund demand is a serious problem — the
    // agent creates the ticket itself and yields instead of answering.
    expect(m(executeToolCall)).toHaveBeenCalledWith(
      "create_ticket",
      expect.objectContaining({ priority: "high" }),
      "conv-1"
    );
    const flip = captured.conversationUpdates.find(
      (u) => (u as { data?: Record<string, unknown> }).data?.aiEnabled === false
    );
    expect(flip).toBeTruthy();
    expect(res.response).toContain("human agent");
    expect(res.response).not.toContain(REVIEW_LINK_A);
    expect(res.response).not.toContain("review");
    expect(captured.reviewAsksCreated).toHaveLength(0);
  });

  it("frustrated customer who then says thanks sarcastically-free but escalated stays no-ask", async () => {
    wirePrisma({ conversation: conversationFixture({ status: "escalated" }) });
    const res = await chat("conv-1", "Thank you so much");
    expect(res.response).not.toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(0);
  });

  it("business switched review requests OFF → no ask on a happy closing", async () => {
    wirePrisma({ settings: baseSettings({ reviewRequestsEnabled: false }) });
    const res = await chat("conv-1", "Thank you so much, that solved it!");
    expect(res.response).not.toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(0);
  });

  it("no review link and no website on record → no ask (never an invented destination)", async () => {
    wirePrisma({
      settings: baseSettings({ reviewUrl: "" }),
      business: { id: "test-business", websiteUrl: "", websites: [] },
    });
    const res = await chat("conv-1", "Thank you so much, that solved it!");
    expect(res.response).not.toContain("review");
    expect(captured.reviewAsksCreated).toHaveLength(0);
  });
});

describe("(c) same customer again within the cap → no second ask", () => {
  it("asked 2 days ago in another conversation → capped, across conversations", async () => {
    wirePrisma({
      conversation: conversationFixture({ id: "conv-2" }),
      lastReviewAsk: { askedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) },
    });
    const res = await chat("conv-2", "Thank you so much, that solved it!");
    expect(res.response).not.toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(0);
    // The cap lookup is keyed on the CUSTOMER, not the conversation.
    const whereArg = m(prisma.reviewAsk.findFirst).mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(whereArg.where.customerKey).toBe("cust:cust-1");
  });

  it("asked 31 days ago → cap expired, ask allowed again", async () => {
    wirePrisma({
      lastReviewAsk: {
        askedAt: new Date(Date.now() - (REVIEW_ASK_MIN_INTERVAL_DAYS + 1) * 24 * 3600 * 1000),
      },
    });
    const res = await chat("conv-1", "Thank you so much, that solved it!");
    expect(res.response).toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(1);
  });
});

describe("(d) factual question → grounded in the KB fixture, no invented figures", () => {
  it("delivery-charge answer carries the KB figure; prompt carries KB + discipline", async () => {
    wirePrisma({
      kb: [
        {
          category: "Delivery",
          title: "Delivery charge",
          content: "Delivery charge inside Faridpur Sadar is ৳50 per order.",
          priority: 1,
        },
      ],
    });
    m(completeWithFallback).mockImplementation(async (req: ChatCompletionRequest) => {
      captured.providerRequests.push(req);
      return {
        provider: "openai",
        model: "gpt-4o-mini",
        text: "Delivery charge inside Faridpur Sadar is ৳50 per order.",
      };
    });

    const res = await chat("conv-1", "How much is the delivery charge inside Faridpur Sadar?");
    expect(res.response).toContain("৳50");
    // No figure other than the KB's ৳50 appears anywhere in the answer.
    expect(res.response.match(/৳\d+/g)).toEqual(["৳50"]);
    // The model was actually given the KB fact and the discipline text.
    const systemPrompt = captured.providerRequests[0].messages[0].content;
    expect(systemPrompt).toContain("Delivery charge inside Faridpur Sadar is ৳50 per order.");
    expect(systemPrompt).toContain("## Answer Discipline — understand first, then answer");
    expect(systemPrompt).toContain(
      "If you cannot verify something from your sources, say so honestly"
    );
  });
});

describe("order completed → check-in scheduled + review ask (order trigger)", () => {
  it("take_order success schedules the +24h check-in and asks once", async () => {
    let call = 0;
    m(completeWithFallback).mockImplementation(async (req: ChatCompletionRequest) => {
      captured.providerRequests.push(req);
      call += 1;
      if (call === 1) {
        return {
          provider: "openai",
          model: "gpt-4o-mini",
          text: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function" as const,
              function: { name: "take_order", arguments: "{}" },
            },
          ],
        };
      }
      return {
        provider: "openai",
        model: "gpt-4o-mini",
        text: "Your order is confirmed and will arrive tomorrow. Thank you for ordering with us!",
      };
    });
    m(executeToolCall).mockResolvedValue(
      JSON.stringify({ success: true, orderId: "order-abcdef123456", message: "ok" })
    );

    const res = await chat("conv-1", "I would like to order the red pan, please");
    // Review ask fired on the order_completed trigger.
    expect(res.response).toContain(REVIEW_LINK_A);
    expect(captured.reviewAsksCreated).toHaveLength(1);
    expect(captured.reviewAsksCreated[0].trigger).toBe("order_completed");
    // Post-order check-in scheduled through the follow-up machinery.
    expect(captured.followUpsCreated).toHaveLength(1);
    const checkIn = captured.followUpsCreated[0];
    expect(checkIn.kind).toBe("order_checkin");
    expect(checkIn.status).toBe("pending");
    expect(String(checkIn.message)).toContain("Acme Store");
    expect(String(checkIn.message)).toContain("order-ab"); // order reference
    const dueInMs = new Date(checkIn.dueAt as Date).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(23.9 * 3600 * 1000);
    expect(dueInMs).toBeLessThan(24.1 * 3600 * 1000);
  });

  it("follow-ups OFF → order still taken, no check-in scheduled", async () => {
    wirePrisma({ settings: baseSettings({ followUpsEnabled: false }) });
    let call = 0;
    m(completeWithFallback).mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          provider: "openai",
          model: "gpt-4o-mini",
          text: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function" as const,
              function: { name: "take_order", arguments: "{}" },
            },
          ],
        };
      }
      return { provider: "openai", model: "gpt-4o-mini", text: "Order confirmed." };
    });
    m(executeToolCall).mockResolvedValue(
      JSON.stringify({ success: true, orderId: "order-abcdef123456", message: "ok" })
    );
    await chat("conv-1", "Please order the red pan");
    expect(captured.followUpsCreated).toHaveLength(0);
  });
});

describe("(f) tenant isolation — B's agent never uses A's link or knowledge", () => {
  it("two businesses, two asks: each carries only its own destination", async () => {
    // Business A: explicit review URL.
    const resA = await chat("conv-1", "Thank you so much, that solved it!");
    expect(resA.response).toContain(REVIEW_LINK_A);
    expect(resA.response).not.toContain(WEBSITE_B);

    // Business B: no review URL — falls back to ITS OWN website only.
    wirePrisma({
      settings: baseSettings({ businessName: "Beta Traders", reviewUrl: "" }),
      business: { id: "test-business", websiteUrl: WEBSITE_B, websites: [{ url: WEBSITE_B }] },
      conversation: conversationFixture({
        id: "conv-9",
        customerId: "cust-9",
        customerContact: "+8801900000000",
      }),
    });
    const resB = await chat("conv-9", "Thank you so much, that solved it!");
    expect(resB.response).toContain(WEBSITE_B);
    expect(resB.response).not.toContain(REVIEW_LINK_A);
    expect(resB.response).toContain("Beta Traders");
  });
});

// ---------------------------------------------------------------------------
// (e) Follow-up processor: dropped-conversation revival fires once and
// the proactive send is activity-visible.
// ---------------------------------------------------------------------------

describe("(e) follow-up rule fires once + activity-visible", () => {
  const droppedConv = {
    id: "conv-drop",
    businessId: "test-business",
    customerId: null,
    customerName: "Rahim",
    customerContact: "+8801700000000",
    channel: "whatsapp",
    status: "open",
    aiEnabled: true,
    updatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000), // quiet 3 days
    messages: [
      { role: "customer", content: "Do you have the red pan?" },
      { role: "assistant", content: "Yes, we do! Would you like to order it?" },
    ],
  };

  function wireFollowUps(existingRevival: Record<string, unknown> | null) {
    m(prisma.business.findMany).mockResolvedValue([{ id: "test-business", isActive: true }]);
    m(prisma.settings.findFirst).mockResolvedValue(baseSettings());
    m(prisma.conversation.findMany).mockResolvedValue([droppedConv]);
    // Stateful conversation fake: reportActivity/clearActivity write and
    // read liveActivity through these two delegates, exactly like prod.
    const state: { liveActivity: unknown } = { liveActivity: null };
    m(prisma.conversation.findUnique).mockImplementation(async () => ({
      ...droppedConv,
      liveActivity: state.liveActivity,
    }));
    m(prisma.conversation.update).mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        captured.conversationUpdates.push(args);
        if ("liveActivity" in args.data) state.liveActivity = args.data.liveActivity;
        return {};
      }
    );
    m(prisma.followUp.findFirst).mockResolvedValue(existingRevival);
    const created: Array<Record<string, unknown>> = [];
    m(prisma.followUp.create).mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        const rec = { id: "fu-revival", ...args.data };
        created.push(rec);
        return rec;
      }
    );
    m(prisma.followUp.findMany).mockImplementation(async () =>
      created.map((c) => ({ ...c, status: "pending" }))
    );
    return created;
  }

  it("creates the revival, delivers it once via WhatsApp, marks it sent, reports activity", async () => {
    const created = wireFollowUps(null);
    const result = await processDueFollowUps();

    expect(result.processed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    // Exactly one revival follow-up, with the revival text.
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe("dropped_revival");
    expect(created[0].conversationId).toBe("conv-drop");
    expect(String(created[0].message)).toContain("Acme Store");
    expect(String(created[0].message)).toContain("paused");

    // Delivered through the conversation's own channel with that text.
    expect(m(sendWhatsAppMessage)).toHaveBeenCalledTimes(1);
    expect(m(sendWhatsAppMessage).mock.calls[0][0]).toBe("+8801700000000");
    expect(String(m(sendWhatsAppMessage).mock.calls[0][1])).toContain("Acme Store");

    // Stored as an assistant message (the conversation record shows it).
    const stored = captured.messagesCreated.find((x) => x.conversationId === "conv-drop");
    expect(stored).toBeTruthy();
    expect(String(stored?.content)).toContain("Acme Store");

    // Activity-visible: while the proactive send ran, the conversation's
    // liveActivity was set to the sending_reply activity object (the same
    // shape the widget/inbox render), and it was cleared afterwards.
    const activitySets = captured.conversationUpdates.filter((u) => {
      const data = (u as { data?: Record<string, unknown> }).data ?? {};
      const la = data.liveActivity as { kind?: string } | null | undefined;
      return !!la && typeof la === "object" && la.kind === "sending_reply";
    });
    expect(activitySets.length).toBeGreaterThanOrEqual(1);
    const setActivity = (
      activitySets[0] as { data: { liveActivity: { kind: string; channel: string } } }
    ).data.liveActivity;
    expect(setActivity.channel).toBe("whatsapp");
    const cleared = captured.conversationUpdates.some((u) => {
      const data = (u as { data?: Record<string, unknown> }).data ?? {};
      return "liveActivity" in data && data.liveActivity === null;
    });
    expect(cleared).toBe(true);
  });

  it("second run: revival already exists → nothing new created, nothing sent", async () => {
    const created = wireFollowUps({
      id: "fu-old",
      conversationId: "conv-drop",
      kind: "dropped_revival",
    });
    m(prisma.followUp.findMany).mockResolvedValue([]);
    const result = await processDueFollowUps();
    expect(created).toHaveLength(0);
    expect(result.processed).toBe(0);
    expect(m(sendWhatsAppMessage)).not.toHaveBeenCalled();
  });

  it("follow-ups OFF in settings → no revival is created", async () => {
    m(prisma.business.findMany).mockResolvedValue([{ id: "test-business", isActive: true }]);
    m(prisma.settings.findFirst).mockResolvedValue(
      baseSettings({ followUpsEnabled: false })
    );
    m(prisma.conversation.findMany).mockResolvedValue([droppedConv]);
    m(prisma.followUp.findMany).mockResolvedValue([]);
    const created: Array<Record<string, unknown>> = [];
    m(prisma.followUp.create).mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: "fu-x", ...args.data };
      }
    );
    await processDueFollowUps();
    expect(created).toHaveLength(0);
  });

  it("human-takeover conversation (aiEnabled false) is never revived", async () => {
    m(prisma.business.findMany).mockResolvedValue([{ id: "test-business", isActive: true }]);
    m(prisma.settings.findFirst).mockResolvedValue(baseSettings());
    m(prisma.conversation.findMany).mockResolvedValue([
      { ...droppedConv, id: "conv-human", aiEnabled: false },
    ]);
    m(prisma.followUp.findFirst).mockResolvedValue(null);
    m(prisma.followUp.findMany).mockResolvedValue([]);
    const created: Array<Record<string, unknown>> = [];
    m(prisma.followUp.create).mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: "fu-x", ...args.data };
      }
    );
    await processDueFollowUps();
    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Human handoff (owner addition 2026-10-21 12:24): serious problem or
// explicit human/ticket ask → the agent creates the ticket itself,
// tells the customer a human continues HERE, and yields the thread.
// ---------------------------------------------------------------------------

describe("detectHandoff — recognition matrix", () => {
  it("explicit human asks (EN + BN)", () => {
    expect(detectHandoff("I want to talk to a human, please").kind).toBe("explicit_human");
    expect(detectHandoff("Can I speak to a real person?").kind).toBe("explicit_human");
    expect(detectHandoff("আমি একজন মানুষের সাথে কথা বলতে চাই").kind).toBe("explicit_human");
  });

  it("explicit ticket asks", () => {
    expect(detectHandoff("Please open a support ticket for this").kind).toBe("ticket_request");
    expect(detectHandoff("I want to file a complaint").kind).toBe("ticket_request");
  });

  it("serious problems (approval keywords + serious patterns)", () => {
    expect(detectHandoff("I want a full refund").kind).toBe("serious_problem");
    expect(detectHandoff("Please cancel my order").kind).toBe("serious_problem");
    expect(detectHandoff("You charged me twice, this is fraud").kind).toBe("serious_problem");
    expect(detectHandoff("আমার টাকা কেটে নিয়েছে কিন্তু পণ্য পাইনি").kind).toBe(
      "serious_problem"
    );
  });

  it("casual and negotiation messages do NOT hand off", () => {
    expect(detectHandoff("What time do you open?").needed).toBe(false);
    expect(detectHandoff("Do you deliver to Faridpur Sadar?").needed).toBe(false);
    expect(detectHandoff("Can you give me a discount?").needed).toBe(false);
    expect(detectHandoff("Thank you so much, that solved it!").needed).toBe(false);
    expect(detectHandoff("").needed).toBe(false);
  });
});

describe("(g) explicit human ask → ticket created, handoff message, agent yields", () => {
  it("creates a high-priority ticket via the tool, flips handoff state, never asks the LLM, then goes silent", async () => {
    m(executeToolCall).mockResolvedValue(
      JSON.stringify({ success: true, ticketId: "ticket-1234567890", message: "ok" })
    );

    const res = await chat("conv-1", "I want to talk to a human, please");
    // (b) the ticket was created by the platform's ticket tool itself.
    expect(m(executeToolCall)).toHaveBeenCalledTimes(1);
    expect(m(executeToolCall)).toHaveBeenCalledWith(
      "create_ticket",
      expect.objectContaining({
        title: "Customer asked for a human agent",
        priority: "high",
      }),
      "conv-1"
    );
    // The bot did NOT compose an answer this turn.
    expect(captured.providerRequests).toHaveLength(0);
    // (c) plain statement: a human continues in THIS conversation, with
    // the ticket reference.
    expect(res.response).toContain("human agent");
    expect(res.response).toContain("this same conversation");
    expect(res.response).toContain("ticket-1"); // reference = first 8 chars
    expect(res.silent).toBe(false);
    // (d) handoff state flipped: aiEnabled=false + escalated + metadata.
    const flip = captured.conversationUpdates.find(
      (u) => (u as { data?: Record<string, unknown> }).data?.aiEnabled === false
    ) as { data: { status: string; metadata: Record<string, unknown> } } | undefined;
    expect(flip).toBeTruthy();
    expect(flip?.data.status).toBe("escalated");
    expect(flip?.data.metadata.handoff).toBe(true);
    expect(flip?.data.metadata.ticketId).toBe("ticket-1234567890");
    // The handoff statement is the saved assistant message.
    const savedAssistant = captured.messagesCreated.filter((x) => x.role === "assistant");
    expect(savedAssistant).toHaveLength(1);
    expect(savedAssistant[0].content).toContain("human agent");
    // No review ask in a handed-off thread, ever.
    expect(captured.reviewAsksCreated).toHaveLength(0);

    // Next customer message: the bot yields (takeover path) — silent,
    // no new ticket, no provider call.
    m(executeToolCall).mockClear();
    captured.providerRequests = [];
    wirePrisma({
      conversation: conversationFixture({
        aiEnabled: false,
        status: "escalated",
        metadata: { handoff: true },
      }),
    });
    const second = await chat("conv-1", "Hello? Anyone there?");
    expect(second.silent).toBe(true);
    expect(second.response).toBe("");
    expect(m(executeToolCall)).not.toHaveBeenCalled();
    expect(captured.providerRequests).toHaveLength(0);
  });

  it("Bengali human ask → Bengali handoff statement", async () => {
    m(executeToolCall).mockResolvedValue(
      JSON.stringify({ success: true, ticketId: "ticket-abcdef", message: "ok" })
    );
    const res = await chat("conv-1", "আমি একজন মানুষের সাথে কথা বলতে চাই");
    expect(res.response).toContain("মানব এজেন্ট");
    expect(res.response).toContain("সাপোর্ট টিকিট");
    expect(m(executeToolCall)).toHaveBeenCalledWith(
      "create_ticket",
      expect.objectContaining({ priority: "high" }),
      "conv-1"
    );
  });

  it("an existing open ticket is reused — never a duplicate", async () => {
    m(prisma.ticket.findFirst).mockResolvedValue({ id: "ticket-existing-99" });
    const res = await chat("conv-1", "Talk to a human please");
    expect(m(executeToolCall)).not.toHaveBeenCalledWith(
      "create_ticket",
      expect.anything(),
      expect.anything()
    );
    expect(res.response).toContain("ticket-e"); // existing ticket's reference
    const flip = captured.conversationUpdates.find(
      (u) => (u as { data?: Record<string, unknown> }).data?.aiEnabled === false
    ) as { data: { metadata: Record<string, unknown> } } | undefined;
    expect(flip?.data.metadata.ticketId).toBe("ticket-existing-99");
  });
});

describe("(h) serious problem → handoff; (i) casual question → no ticket", () => {
  it("double-charged + never arrived + fraud → serious handoff without an LLM answer", async () => {
    m(executeToolCall).mockResolvedValue(
      JSON.stringify({ success: true, ticketId: "ticket-xyz-1", message: "ok" })
    );
    const res = await chat(
      "conv-1",
      "My payment was deducted twice and my order never arrived. This is fraud!"
    );
    expect(m(executeToolCall)).toHaveBeenCalledWith(
      "create_ticket",
      expect.objectContaining({
        title: "Serious problem — customer needs a human agent",
        priority: "high",
      }),
      "conv-1"
    );
    expect(captured.providerRequests).toHaveLength(0);
    expect(res.response).toContain("human agent");
    expect(captured.reviewAsksCreated).toHaveLength(0);
  });

  it("casual question: normal AI answer, no ticket, no state flip", async () => {
    const res = await chat("conv-1", "What time do you open?");
    expect(res.response).toContain("Happy to help");
    expect(m(executeToolCall)).not.toHaveBeenCalled();
    const flip = captured.conversationUpdates.find(
      (u) => (u as { data?: Record<string, unknown> }).data?.aiEnabled === false
    );
    expect(flip).toBeUndefined();
  });

  it("discount negotiation stays with the agent (retention), flagged but not handed off", async () => {
    const res = await chat("conv-1", "Can you give me a discount on this?");
    expect(m(executeToolCall)).not.toHaveBeenCalledWith(
      "create_ticket",
      expect.anything(),
      expect.anything()
    );
    expect(res.response).toContain("Happy to help");
    const flip = captured.conversationUpdates.find(
      (u) => (u as { data?: Record<string, unknown> }).data?.aiEnabled === false
    );
    expect(flip).toBeUndefined();
  });
});
