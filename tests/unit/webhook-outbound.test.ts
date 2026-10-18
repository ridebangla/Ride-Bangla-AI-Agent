import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]),
  },
}));

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

describe("Outbound webhooks (M-54)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" })
    );
  });

  it("refuses delivery when WEBHOOK_SECRET is unset (fail-closed)", async () => {
    delete process.env.WEBHOOK_SECRET;
    mockPrisma.webhookDelivery.create.mockResolvedValue({ id: "d1" });
    mockPrisma.webhookDelivery.update.mockResolvedValue({});

    const { deliverWebhook } = await import("@/lib/webhook-delivery");
    const result = await deliverWebhook(
      {
        id: "w1",
        name: "Test",
        url: "https://example.com/hook",
        method: "POST",
        headers: {},
      },
      "test.event",
      {}
    );

    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const updateArg = mockPrisma.webhookDelivery.update.mock.calls.at(-1)[0];
    expect(updateArg.data.status).toBe("failed");
    expect(String(updateArg.data.lastError)).toContain("WEBHOOK_SECRET");
  });

  it("signs deliveries with X-RBAI-Signature when WEBHOOK_SECRET is set", async () => {
    process.env.WEBHOOK_SECRET = "test-webhook-secret";
    try {
      mockPrisma.webhookDelivery.create.mockResolvedValue({ id: "d1" });
      mockPrisma.webhookDelivery.update.mockResolvedValue({});

      const { deliverWebhook } = await import("@/lib/webhook-delivery");
      const result = await deliverWebhook(
        {
          id: "w1",
          name: "Test",
          url: "https://example.com/hook",
          method: "POST",
          headers: {},
        },
        "test.event",
        { hello: "world" }
      );

      expect(result.success).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(init.headers["X-RBAI-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      delete process.env.WEBHOOK_SECRET;
    }
  });

  it("rejects webhook creation with a private URL (SSRF)", async () => {
    const { POST } = await import("@/app/api/webhooks/route");
    const response = await POST(
      createRequest("/api/webhooks", {
        method: "POST",
        body: {
          name: "Evil",
          url: "http://169.254.169.254/latest/meta-data/",
          triggerOn: "test.event",
        },
      })
    );
    expect(response.status).toBe(400);
    expect(mockPrisma.webhook.create).not.toHaveBeenCalled();
  });

  it("allows webhook creation with a public URL", async () => {
    mockPrisma.webhook.create.mockResolvedValue({
      id: "w1",
      name: "Good",
      url: "https://example.com/hook",
    });
    const { POST } = await import("@/app/api/webhooks/route");
    const response = await POST(
      createRequest("/api/webhooks", {
        method: "POST",
        body: {
          name: "Good",
          url: "https://example.com/hook",
          triggerOn: "test.event",
        },
      })
    );
    expect(response.status).toBe(201);
    const data = await parseJsonResponse(response);
    expect(data.id).toBe("w1");
  });

  it("rejects webhook URL update to a private URL (SSRF)", async () => {
    mockPrisma.webhook.findUnique.mockResolvedValue({ id: "w1" });
    const { PUT } = await import("@/app/api/webhooks/[id]/route");
    const response = await PUT(
      createRequest("/api/webhooks/w1", {
        method: "PUT",
        body: { url: "http://10.0.0.5/hook" },
      }),
      { params: Promise.resolve({ id: "w1" }) }
    );
    expect(response.status).toBe(400);
    expect(mockPrisma.webhook.update).not.toHaveBeenCalled();
  });
});
