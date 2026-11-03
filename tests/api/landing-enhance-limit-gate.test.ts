/**
 * landing-enhance-limit-gate.test.ts — Team G limit-gate gaps (AI tree).
 *
 * POST /api/landing/enhance must, like /api/chat and the other LLM-spend
 * routes: (1) 402 subscription_paused when the subscription is inactive
 * or scoped away from chat, BEFORE any work; (2) 402
 * message_limit_reached when provider keys resolve AND the plan quota is
 * exhausted, BEFORE refineCopyWithAI spends tokens; (3) meter exactly
 * one message via recordAiMessage on a successful enhancement
 * (aiEnhanced true) and never on a no-key / failed refinement.
 * The graceful no-key path ({ enhanced: false }) is preserved: with no
 * key there is no spend, so no limit gate fires.
 *
 * Mocks follow tests/api/chat.test.ts: the global setup mocks
 * @/lib/prisma (mock client) and @/lib/route-auth (authenticated as
 * business "test-business"); this file mocks subscription, billing-usage,
 * providers, landing-copy, and landing data.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseJsonResponse } from "../helpers/request";

vi.mock("@/lib/subscription", () => {
  class SubscriptionInactiveError extends Error {
    constructor(businessId?: string | null) {
      super(`Subscription is not active${businessId ? ` (business ${businessId})` : ""}.`);
      this.name = "SubscriptionInactiveError";
    }
  }
  return {
    SubscriptionInactiveError,
    requireActiveSubscription: vi.fn().mockResolvedValue({ scopeAllowsChat: true }),
  };
});

vi.mock("@/lib/billing-usage", () => ({
  checkMessageLimitExceeded: vi.fn().mockResolvedValue(false),
  recordAiMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ai/providers", () => ({
  resolveSiteKeys: vi.fn().mockResolvedValue({ groq: "test-key" }),
  hasAnyProviderKey: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/landing-copy", () => ({
  refineCopyWithAI: vi.fn().mockResolvedValue({
    copy: { heroTitle: "Enhanced" },
    suggestedTheme: "teal",
    aiEnhanced: true,
  }),
}));

vi.mock("@/lib/landing", () => ({
  getLandingData: vi.fn().mockResolvedValue({
    copy: { heroTitle: "Original" },
    products: [],
    productGroups: [],
    aboutEntries: [],
  }),
}));

async function setupPrisma() {
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  db.business.findUnique.mockResolvedValue({
    id: "test-business",
    name: "Test Biz",
    slug: "test-biz",
    tagline: null,
    brandColor: null,
    landingTheme: null,
  });
  db.settings.findFirst.mockResolvedValue({ businessDesc: "Desc" });
  db.business.update.mockResolvedValue({});
  return db;
}

describe("POST /api/landing/enhance — limit gates", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupPrisma();
    const { requireActiveSubscription } = await import("@/lib/subscription");
    (requireActiveSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
      scopeAllowsChat: true,
    });
    const { checkMessageLimitExceeded, recordAiMessage } = await import("@/lib/billing-usage");
    (checkMessageLimitExceeded as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (recordAiMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { resolveSiteKeys, hasAnyProviderKey } = await import("@/lib/ai/providers");
    (resolveSiteKeys as ReturnType<typeof vi.fn>).mockResolvedValue({ groq: "test-key" });
    (hasAnyProviderKey as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { refineCopyWithAI } = await import("@/lib/landing-copy");
    (refineCopyWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      copy: { heroTitle: "Enhanced" },
      suggestedTheme: "teal",
      aiEnhanced: true,
    });
  });

  it("meters one message and persists on a successful enhancement", async () => {
    const { POST } = await import("@/app/api/landing/enhance/route");
    const { recordAiMessage } = await import("@/lib/billing-usage");
    const { refineCopyWithAI } = await import("@/lib/landing-copy");
    const db = await setupPrisma();

    const response = await POST(createRequest("/api/landing/enhance", { method: "POST" }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.enhanced).toBe(true);
    expect(refineCopyWithAI as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(recordAiMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(recordAiMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("test-business");
    expect(db.business.update).toHaveBeenCalledTimes(1);
  });

  it("hard-stops with 402 message_limit_reached before spending when keys resolve and quota is exhausted", async () => {
    const { checkMessageLimitExceeded, recordAiMessage } = await import("@/lib/billing-usage");
    (checkMessageLimitExceeded as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const { refineCopyWithAI } = await import("@/lib/landing-copy");
    const db = await setupPrisma();

    const { POST } = await import("@/app/api/landing/enhance/route");
    const response = await POST(createRequest("/api/landing/enhance", { method: "POST" }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(402);
    expect(data.error).toBe("message_limit_reached");
    expect(refineCopyWithAI as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(recordAiMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(db.business.update).not.toHaveBeenCalled();
  });

  it("hard-stops with 402 subscription_paused when the subscription is inactive, before any spend", async () => {
    const { requireActiveSubscription, SubscriptionInactiveError } = await import("@/lib/subscription");
    (requireActiveSubscription as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new SubscriptionInactiveError("test-business")
    );
    const { refineCopyWithAI } = await import("@/lib/landing-copy");

    const { POST } = await import("@/app/api/landing/enhance/route");
    const response = await POST(createRequest("/api/landing/enhance", { method: "POST" }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(402);
    expect(data.error).toBe("subscription_paused");
    expect(refineCopyWithAI as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("preserves the graceful no-key path: no gate, no metering, { enhanced: false }", async () => {
    const { hasAnyProviderKey } = await import("@/lib/ai/providers");
    (hasAnyProviderKey as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { checkMessageLimitExceeded, recordAiMessage } = await import("@/lib/billing-usage");
    (checkMessageLimitExceeded as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const { refineCopyWithAI } = await import("@/lib/landing-copy");
    (refineCopyWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      copy: { heroTitle: "Original" },
      suggestedTheme: null,
      aiEnhanced: false,
      note: "no-key",
    });

    const { POST } = await import("@/app/api/landing/enhance/route");
    const response = await POST(createRequest("/api/landing/enhance", { method: "POST" }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.enhanced).toBe(false);
    // No spend was possible, so the limit gate must not have fired even
    // though the mocked quota reads exhausted.
    expect(checkMessageLimitExceeded as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(recordAiMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("does not meter a failed refinement", async () => {
    const { refineCopyWithAI } = await import("@/lib/landing-copy");
    (refineCopyWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      copy: { heroTitle: "Original" },
      suggestedTheme: null,
      aiEnhanced: false,
      note: "error",
    });
    const { recordAiMessage } = await import("@/lib/billing-usage");

    const { POST } = await import("@/app/api/landing/enhance/route");
    const response = await POST(createRequest("/api/landing/enhance", { method: "POST" }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.enhanced).toBe(false);
    expect(recordAiMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
