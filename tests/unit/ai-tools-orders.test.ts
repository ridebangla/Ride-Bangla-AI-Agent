import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("AI tools: take_order + schedule_followup (real persistence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("take_order persists a ticket with order metadata", async () => {
    mockPrisma.ticket.create.mockResolvedValue({ id: "ticket-123" });
    // Phase 2: take_order also writes the order doc (orders collection).
    mockPrisma.order.create.mockResolvedValue({ id: "order-456" });
    const { executeToolCall } = await import("@/lib/ai/tools");

    const raw = await executeToolCall(
      "take_order",
      {
        serviceType: "courier",
        pickup: "Faridpur Sadar",
        dropoff: "Dhaka",
        details: "1 parcel, documents",
        customerName: "Test User",
        customerPhone: "+8801XXXXXXXXX",
      },
      "conv-1"
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.orderId).toBe("order-456");
    expect(result.ticketId).toBe("ticket-123");
    expect(mockPrisma.ticket.create).toHaveBeenCalledOnce();
    const data = mockPrisma.ticket.create.mock.calls[0][0].data;
    expect(data.businessId).toBe("test-business");
    expect(data.title).toContain("courier");
    expect(data.metadata.kind).toBe("order");
    expect(data.metadata.pickup).toBe("Faridpur Sadar");
  });

  it("take_order rejects missing essentials", async () => {
    const { executeToolCall } = await import("@/lib/ai/tools");
    const raw = await executeToolCall("take_order", { serviceType: "", details: "" }, "conv-1");
    expect(JSON.parse(raw).success).toBe(false);
    expect(mockPrisma.ticket.create).not.toHaveBeenCalled();
  });

  it("schedule_followup persists a FollowUp row (no longer fake)", async () => {
    mockPrisma.followUp.create.mockResolvedValue({
      id: "fu-1",
      dueAt: new Date(Date.now() + 3600000),
    });
    const { executeToolCall } = await import("@/lib/ai/tools");

    const raw = await executeToolCall(
      "schedule_followup",
      { conversationId: "conv-1", message: "Checking in!", delayHours: 24 },
      "conv-1"
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.followUpId).toBe("fu-1");
    expect(mockPrisma.followUp.create).toHaveBeenCalledOnce();
    const data = mockPrisma.followUp.create.mock.calls[0][0].data;
    expect(data.businessId).toBe("test-business");
    expect(data.conversationId).toBe("conv-1");
    expect(data.message).toBe("Checking in!");
    expect(data.status).toBe("pending");
    expect(new Date(data.dueAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("schedule_followup rejects absurd delays", async () => {
    const { executeToolCall } = await import("@/lib/ai/tools");
    const raw = await executeToolCall(
      "schedule_followup",
      { conversationId: "conv-1", message: "hi", delayHours: 99999 },
      "conv-1"
    );
    expect(JSON.parse(raw).success).toBe(false);
    expect(mockPrisma.followUp.create).not.toHaveBeenCalled();
  });
});

