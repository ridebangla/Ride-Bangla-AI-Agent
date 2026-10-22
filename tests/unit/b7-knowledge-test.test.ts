/**
 * b7-knowledge-test.test.ts — B7 (3): the dashboard knowledge-test
 * route goes through the providers funnel (resolveSiteKeys +
 * completeWithFallback) instead of hard-requiring the legacy
 * settings.aiApiKey.
 *
 * Pins: a business with NO legacy aiApiKey but resolvable funnel keys
 * gets a real answer from the funnel; when no key resolves anywhere,
 * the route keeps its existing 400 + existing error text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { resolveSiteKeysMock, completeMock } = vi.hoisted(() => ({
  resolveSiteKeysMock: vi.fn(),
  completeMock: vi.fn(),
}));

vi.mock("@/lib/ai/providers", () => ({
  resolveSiteKeys: resolveSiteKeysMock,
  hasAnyProviderKey: (keys: Record<string, unknown> | null | undefined) =>
    !!keys && Object.values(keys).some((v) => typeof v === "string" && v),
  completeWithFallback: completeMock,
  normalizePreferredProvider: () => null,
}));

import { prisma } from "@/lib/prisma";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

async function callRoute() {
  const { POST } = await import("@/app/api/knowledge/test/route");
  const { createRequest } = await import("../helpers/request");
  return POST(
    createRequest("http://localhost:3000/api/knowledge/test", {
      method: "POST",
      body: { question: "What are your hours?" },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Settings carry NO legacy aiApiKey — the old route 400'd here.
  mockPrisma.settings.findUnique.mockResolvedValue({
    aiApiKey: null,
    aiModel: "gpt-4o-mini",
    aiProvider: "groq",
    maxTokens: 2048,
    temperature: 0.7,
  });
  mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
    {
      id: "k1",
      title: "Hours",
      content: "Open 9am to 9pm.",
      category: { id: "c1", name: "General", color: "#000" },
    },
  ]);
});

describe("B7 (3) — knowledge-test route uses the providers funnel", () => {
  it("answers via the funnel when keys resolve but no legacy aiApiKey exists", async () => {
    resolveSiteKeysMock.mockResolvedValue({ groq: "platform-groq-key" });
    completeMock.mockResolvedValue({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      text: "Open 9am to 9pm.\n---SOURCES---\n[1]",
    });
    const res = await callRoute();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.answer).toBe("Open 9am to 9pm.");
    expect(json.sources).toHaveLength(1);
    expect(json.sources[0].id).toBe("k1");
    expect(json.model).toBe("llama-3.3-70b-versatile");
    // The funnel was asked with the business's own id.
    expect(resolveSiteKeysMock).toHaveBeenCalledWith("test-business");
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "What are your hours?" }),
        ]),
      }),
      expect.objectContaining({ keys: { groq: "platform-groq-key" } })
    );
  });

  it("keeps the existing 400 + error text when no key resolves anywhere", async () => {
    resolveSiteKeysMock.mockResolvedValue({
      groq: null,
      gemini: null,
      openai: null,
      openrouter: null,
    });
    const res = await callRoute();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "AI API key is not configured. Please configure it in Settings."
    );
    expect(completeMock).not.toHaveBeenCalled();
  });
});
