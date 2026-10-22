/**
 * b7-scope-gates.test.ts — Item 0 (B6 follow-up): feature-scope
 * enforcement on the talk entry points B6 did not cover.
 *
 * B6 gated /api/chat, /api/chat/widget and /api/public/ai/generate.
 * This suite pins the same contract on the remaining entry points:
 *   - channel inbound (processChannelMessage — WhatsApp / Telegram /
 *     SMS / email / phone / Meta all funnel through it): a grant
 *     scoped away from "chat" gets the route's existing silent-drop
 *     (message stored, no AI spend, blockedBySubscription).
 *   - Meta comment handling (handleCommentEvent): stored without an
 *     AI draft, exactly like an inactive subscription.
 *   - vision + voice routes: 402 { error: "subscription_paused" },
 *     the routes' existing denial shape.
 * A grant whose scope INCLUDES "chat" — and every unscoped account —
 * passes these gates byte-identically (the check is explicit-false).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { chatMock, getOpenAIMock } = vi.hoisted(() => ({
  chatMock: vi.fn(async () => ({ response: "Hi there!", products: [], silent: false })),
  getOpenAIMock: vi.fn(),
}));

vi.mock("@/lib/ai/engine", () => ({
  chat: chatMock,
  getAIConfig: vi.fn(async () => ({ language: "en", model: "gpt-4o-mini" })),
  createNewConversation: vi.fn(),
}));

vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBusinessBySiteKey: vi.fn(async (key: string) =>
      key === "site-key-1" ? { id: "biz-1", name: "Test" } : null
    ),
  };
});

vi.mock("@/lib/social/ai", () => ({
  getOpenAI: getOpenAIMock,
  getKnowledgeContext: vi.fn(async () => ""),
}));

vi.mock("@/lib/social/accounts", () => ({
  getActiveAccounts: vi.fn(async () => []),
  getDecryptedToken: vi.fn(() => ""),
}));

vi.mock("@/lib/social/engagement", () => ({
  postReply: vi.fn(async () => "reply-ref"),
}));

import { getUnscopedPrisma } from "@/lib/prisma";
import { processChannelMessage } from "@/lib/channels/inbound";
import { handleCommentEvent } from "@/lib/social/comments";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const past = (d: number) => new Date(NOW - d * DAY);
const future = (d: number) => new Date(NOW + d * DAY);

function compBiz(scopeFeatures: string[] | null) {
  return {
    id: "biz-1",
    name: "Test",
    slug: "test",
    isActive: true,
    plan: "trial",
    subscriptionStatus: "trialing",
    trialEndsAt: past(2),
    aiMessagesUsed: 0,
    usagePeriodStart: past(0),
    comp: {
      active: true,
      planId: "growth",
      startsAt: past(1),
      endsAt: future(30),
      reason: "test",
      grantedBy: "admin@ridebangla.bd",
      grantedAt: past(1),
      source: "panel",
      ...(scopeFeatures ? { scope: { features: scopeFeatures } } : {}),
    },
  };
}

const UNSCOPED_ACTIVE = {
  id: "biz-1",
  name: "Test",
  slug: "test",
  isActive: true,
  plan: "starter",
  subscriptionStatus: "active",
};

type MockDb = {
  business: { findUnique: ReturnType<typeof vi.fn> };
  message: { create: ReturnType<typeof vi.fn> };
  conversation: {
    update: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  socialInteraction: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

function db(): MockDb {
  return getUnscopedPrisma() as unknown as MockDb;
}

beforeEach(() => {
  vi.clearAllMocks();
  chatMock.mockResolvedValue({ response: "Hi there!", products: [], silent: false });
  db().message.create.mockResolvedValue({ id: "msg-1" });
  db().conversation.update.mockResolvedValue({});
  db().conversation.findUnique.mockResolvedValue({ liveActivity: null });
  db().socialInteraction.findFirst.mockResolvedValue(null);
  db().socialInteraction.create.mockResolvedValue({ id: "int-1" });
});

// ---------------------------------------------------------------------------
describe("Item 0 — channel inbound scope gate (processChannelMessage)", () => {
  it("a comp scoped away from chat is silently stored, no AI spend", async () => {
    db().business.findUnique.mockResolvedValue(compBiz([]));
    const result = await processChannelMessage("conv-1", "biz-1", "hello?");
    expect(result.silent).toBe(true);
    expect(result.blockedBySubscription).toBe(true);
    expect(chatMock).not.toHaveBeenCalled();
    expect(db().message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "customer",
          content: "hello?",
        }),
      })
    );
  });

  it("a comp scoped WITH chat runs the AI pipeline", async () => {
    db().business.findUnique.mockResolvedValue(compBiz(["chat"]));
    const result = await processChannelMessage("conv-1", "biz-1", "hello?");
    expect(result.silent).toBe(false);
    expect(result.response).toBe("Hi there!");
    expect(chatMock).toHaveBeenCalled();
  });

  it("an unscoped comp runs the AI pipeline", async () => {
    db().business.findUnique.mockResolvedValue(compBiz(null));
    const result = await processChannelMessage("conv-1", "biz-1", "hello?");
    expect(result.silent).toBe(false);
    expect(chatMock).toHaveBeenCalled();
  });

  it("an ordinary unscoped active business is unchanged", async () => {
    db().business.findUnique.mockResolvedValue(UNSCOPED_ACTIVE);
    const result = await processChannelMessage("conv-1", "biz-1", "hello?");
    expect(result.silent).toBe(false);
    expect(chatMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("Item 0 — Meta comment scope gate (handleCommentEvent)", () => {
  const event = {
    platform: "facebook" as const,
    commentId: "c-1",
    parentRef: "page-1_post-1",
    authorRef: "user-1",
    authorName: "Customer",
    text: "Nice product!",
    businessId: "biz-1",
  };

  it("a comp scoped away from chat stores the comment with NO AI draft", async () => {
    db().business.findUnique.mockResolvedValue(compBiz([]));
    const result = await handleCommentEvent(event);
    expect(result.autoReplied).toBe(false);
    expect(getOpenAIMock).not.toHaveBeenCalled();
    expect(db().socialInteraction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ draftReply: "", externalId: "c-1" }),
      })
    );
  });

  it("a comp scoped WITH chat drafts a reply as before", async () => {
    db().business.findUnique.mockResolvedValue(compBiz(["chat"]));
    getOpenAIMock.mockResolvedValue({
      client: {
        chat: {
          completions: {
            create: vi.fn(async () => ({
              choices: [{ message: { content: "Thanks!" } }],
            })),
          },
        },
      },
      settings: { businessName: "Test", businessDesc: "" },
    });
    const result = await handleCommentEvent(event);
    expect(result.interactionId).toBe("int-1");
    expect(getOpenAIMock).toHaveBeenCalled();
    expect(db().socialInteraction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ draftReply: "Thanks!" }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
describe("Item 0 — vision / voice route scope gates", () => {
  async function callVision(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/chat/vision/route");
    const { createRequest } = await import("../helpers/request");
    return POST(
      createRequest("http://localhost:3000/api/chat/vision", {
        method: "POST",
        body,
      })
    );
  }

  async function callVoice(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/chat/voice/route");
    const { createRequest } = await import("../helpers/request");
    return POST(
      createRequest("http://localhost:3000/api/chat/voice", {
        method: "POST",
        body,
      })
    );
  }

  it("vision: a comp scoped away from chat gets the existing 402 shape", async () => {
    db().business.findUnique.mockResolvedValue(compBiz([]));
    const res = await callVision({
      siteKey: "site-key-1",
      visitorId: "visitor-vision-scoped",
      image: { mimeType: "image/jpeg", base64: "aGVsbG8=" },
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("subscription_paused");
  });

  it("vision: an unscoped active business passes the gate (fails later validation, not 402)", async () => {
    db().business.findUnique.mockResolvedValue(UNSCOPED_ACTIVE);
    const res = await callVision({
      siteKey: "site-key-1",
      visitorId: "visitor-vision-open",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Provide exactly one of image, video or frames"
    );
  });

  it("voice: a comp scoped away from chat gets the existing 402 shape", async () => {
    db().business.findUnique.mockResolvedValue(compBiz([]));
    const res = await callVoice({
      siteKey: "site-key-1",
      visitorId: "visitor-voice-scoped",
      audio: { mimeType: "audio/webm", base64: "aGVsbG8=" },
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("subscription_paused");
  });

  it("voice: a comp scoped WITH chat passes the gate (fails later validation, not 402)", async () => {
    db().business.findUnique.mockResolvedValue(compBiz(["chat"]));
    const res = await callVoice({
      siteKey: "site-key-1",
      visitorId: "visitor-voice-open",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("audio is required");
  });
});
