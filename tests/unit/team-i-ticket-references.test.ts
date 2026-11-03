/**
 * TEAM I (ticket reference gaps G1/G2): targeted tests for the files
 * TEAM I touched — src/lib/ai/tools.ts only (the dashboard G4 form is
 * a client component, covered by code review, not by vitest here).
 *
 * - create_ticket sets sourceChannel (conversation channel, default
 *   "widget-chat"), sourceWebsite (conversation metadata.sourceSite
 *   when recorded), and the short SITE-XXXXXXXX reference at creation
 *   time (stored by immediate follow-up update, since the reference
 *   is id-derived), and appends the customer's full message to the
 *   description instead of storing only the LLM-supplied text.
 * - take_order's order ticket carries the same attribution +
 *   reference, and the customer-facing reply shows the short
 *   SITE-XXXXXXXX order reference — never a raw id fragment — while
 *   staying doctrine-compliant (pending, team confirms).
 *
 * Uses the global test mocks (tests/setup.ts). No live browser drive
 * — code-level only (UNVERIFIED live).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test-id" }),
    }),
  },
}));

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

beforeEach(() => {
  vi.clearAllMocks();
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
  conversationId?: string
) {
  const { executeToolCall } = await import("@/lib/ai/tools");
  return JSON.parse(await executeToolCall(name, args, conversationId));
}

describe("TEAM I G1 — create_ticket attribution + reference", () => {
  it("sets sourceChannel, sourceWebsite, reference, and the full customer message", async () => {
    db.conversation.findUnique.mockResolvedValue({
      channel: "widget",
      metadata: { sourceSite: "tools.ridebangla.bd" },
      messages: [
        { role: "user", content: "My parcel never arrived, please help" },
      ],
    });
    db.business.findUnique.mockResolvedValue({
      slug: "ride-bangla-ai",
      name: "Ride Bangla AI",
    });
    db.ticket.create.mockResolvedValue({
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      title: "Parcel issue",
      priority: "high",
    });
    db.ticket.update.mockResolvedValue({});

    const result = await callTool(
      "create_ticket",
      {
        title: "Parcel issue",
        description: "Customer reports a problem.",
        priority: "high",
      },
      "conv-1"
    );

    expect(result.success).toBe(true);
    expect(result.reference).toBe("AI-ABCDEF12");
    expect(result.message).toContain("Reference: AI-ABCDEF12");
    const data = db.ticket.create.mock.calls[0][0].data;
    expect(data.sourceChannel).toBe("widget");
    expect(data.sourceWebsite).toBe("tools.ridebangla.bd");
    expect(data.description).toContain("Customer reports a problem.");
    expect(data.description).toContain(
      'Customer\'s full message: "My parcel never arrived, please help"'
    );
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "abcdef12-3456-7890-abcd-ef1234567890" },
      data: { reference: "AI-ABCDEF12" },
    });
  });

  it("defaults sourceChannel to widget-chat with no conversation, and never invents a sourceWebsite", async () => {
    db.business.findUnique.mockResolvedValue({
      slug: "ride-bangla-ai",
      name: "Ride Bangla AI",
    });
    db.ticket.create.mockResolvedValue({
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      title: "Issue",
      priority: "medium",
    });
    db.ticket.update.mockResolvedValue({});

    const result = await callTool("create_ticket", {
      title: "Issue",
      description: "Details",
      priority: "medium",
    });

    expect(result.success).toBe(true);
    expect(result.reference).toBe("AI-ABCDEF12");
    const data = db.ticket.create.mock.calls[0][0].data;
    expect(data.sourceChannel).toBe("widget-chat");
    expect(data.sourceWebsite).toBeUndefined();
  });

  it("does not duplicate a full message the caller already embedded (handoff path)", async () => {
    const full = "Please help, my delivery is late";
    db.conversation.findUnique.mockResolvedValue({
      channel: "widget",
      metadata: {},
      messages: [{ role: "user", content: full }],
    });
    db.business.findUnique.mockResolvedValue({ slug: "ride-bangla-ai" });
    db.ticket.create.mockResolvedValue({
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      title: "Handoff",
      priority: "high",
    });
    db.ticket.update.mockResolvedValue({});

    await callTool(
      "create_ticket",
      {
        title: "Handoff",
        description: `Customer's FULL message: "${full}" — please continue.`,
        priority: "high",
      },
      "conv-1"
    );

    const data = db.ticket.create.mock.calls[0][0].data;
    const occurrences = data.description.split(full).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("TEAM I G1+G2 — take_order ticket + reply reference", () => {
  it("order ticket carries attribution + reference; reply shows SITE-XXXXXXXX, stays pending", async () => {
    db.conversation.findUnique.mockResolvedValue({
      customerId: null,
      businessId: "test-business",
      channel: "widget",
      metadata: { sourceSite: "tools.ridebangla.bd" },
      messages: [{ role: "user", content: "Yes, send it to Dhaka" }],
    });
    db.business.findUnique.mockResolvedValue({
      slug: "ride-bangla-ai",
      name: "Ride Bangla AI",
    });
    db.order.create.mockResolvedValue({ id: "order456-7890-abcd-ef12" });
    db.ticket.create.mockResolvedValue({ id: "ticket12-3456-7890" });
    db.ticket.update.mockResolvedValue({});

    const result = await callTool(
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

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("order456-7890-abcd-ef12");
    expect(result.ticketId).toBe("ticket12-3456-7890");
    // G2: short scheme reference, never the raw id fragment.
    expect(result.reference).toBe("AI-ORDER456");
    expect(result.message).toContain("Order reference: AI-ORDER456");
    expect(result.message).not.toContain("order456");
    // Doctrine: pending, team confirms — never a confirmation.
    expect(result.message).toContain("will confirm shortly");
    expect(result.message).not.toMatch(/order (is )?confirmed/i);
    // G1 on the order ticket itself.
    const data = db.ticket.create.mock.calls[0][0].data;
    expect(data.sourceChannel).toBe("widget");
    expect(data.sourceWebsite).toBe("tools.ridebangla.bd");
    expect(data.description).toContain("Yes, send it to Dhaka");
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "ticket12-3456-7890" },
      data: { reference: "AI-TICKET12" },
    });
  });
});
