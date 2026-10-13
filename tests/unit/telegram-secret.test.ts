import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest } from "../helpers/request";

vi.mock("@/lib/channels/telegram", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/channels/telegram")>();
  return {
    ...original,
    handleTelegramUpdate: vi.fn().mockResolvedValue("reply"),
  };
});

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

describe("Telegram secret_token verification (H-16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockSecret(secret: string) {
    mockPrisma.settings.findFirst.mockResolvedValue({
      telegramWebhookSecret: secret,
    });
  }

  it("accepts an update with the correct secret_token", async () => {
    mockSecret("correct-secret");
    const { handleTelegramUpdate } = await import("@/lib/channels/telegram");
    const { POST } = await import("@/app/api/channels/telegram/route");

    const response = await POST(
      createRequest("/api/channels/telegram", {
        method: "POST",
        body: { update_id: 1, message: { text: "hi" } },
        headers: { "x-telegram-bot-api-secret-token": "correct-secret" },
      })
    );
    expect(response.status).toBe(200);
    expect(handleTelegramUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects an update with a wrong secret_token", async () => {
    mockSecret("correct-secret");
    const { handleTelegramUpdate } = await import("@/lib/channels/telegram");
    const { POST } = await import("@/app/api/channels/telegram/route");

    const response = await POST(
      createRequest("/api/channels/telegram", {
        method: "POST",
        body: { update_id: 1, message: { text: "hi" } },
        headers: { "x-telegram-bot-api-secret-token": "forged" },
      })
    );
    expect(response.status).toBe(403);
    expect(handleTelegramUpdate).not.toHaveBeenCalled();
  });

  it("rejects an update with no secret_token header", async () => {
    mockSecret("correct-secret");
    const { handleTelegramUpdate } = await import("@/lib/channels/telegram");
    const { POST } = await import("@/app/api/channels/telegram/route");

    const response = await POST(
      createRequest("/api/channels/telegram", {
        method: "POST",
        body: { update_id: 1, message: { text: "hi" } },
      })
    );
    expect(response.status).toBe(403);
    expect(handleTelegramUpdate).not.toHaveBeenCalled();
  });

  it("fails closed when no secret is configured", async () => {
    mockSecret("");
    const { handleTelegramUpdate } = await import("@/lib/channels/telegram");
    const { POST } = await import("@/app/api/channels/telegram/route");

    const response = await POST(
      createRequest("/api/channels/telegram", {
        method: "POST",
        body: { update_id: 1, message: { text: "hi" } },
        headers: { "x-telegram-bot-api-secret-token": "anything" },
      })
    );
    expect(response.status).toBe(403);
    expect(handleTelegramUpdate).not.toHaveBeenCalled();
  });

  it("setupTelegramWebhook sends secret_token when a secret is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { setupTelegramWebhook } = await import("@/lib/channels/telegram");
      const ok = await setupTelegramWebhook(
        "bot-token",
        "https://example.com/api/channels/telegram",
        "my-secret"
      );
      expect(ok).toBe(true);
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.secret_token).toBe("my-secret");
      expect(body.url).toBe("https://example.com/api/channels/telegram");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settings API masks the Telegram webhook secret", async () => {
    const { maskSettingsSecrets } = await import("@/lib/security");
    const masked = maskSettingsSecrets({
      telegramBotToken: "bot-token-value",
      telegramWebhookSecret: "secret-value",
      businessName: "Acme",
    });
    expect(masked.telegramBotToken).toBe("***");
    expect(masked.telegramWebhookSecret).toBe("***");
    expect(masked.businessName).toBe("Acme");
  });

  it("settings validation accepts the Telegram fields", async () => {
    const { updateSettingsSchema } = await import("@/lib/validations");
    const parsed = updateSettingsSchema.safeParse({
      telegramBotToken: "bot-token-value",
      telegramWebhookSecret: "secret-value",
    });
    expect(parsed.success).toBe(true);
  });
});
