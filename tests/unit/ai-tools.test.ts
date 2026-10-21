import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { executeToolCall } from "@/lib/ai/tools";

// Mock nodemailer
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test-id" }),
    }),
  },
}));

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("AI Tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset all mock implementations
    for (const model of Object.values(mockPrisma)) {
      if (typeof model === "object" && model !== null) {
        for (const method of Object.values(model)) {
          if (typeof method === "function" && "mockReset" in method) {
            (method as ReturnType<typeof vi.fn>).mockReset();
          }
        }
      }
    }
  });

  describe("create_ticket", () => {
    it("should create a ticket with correct fields", async () => {
      mockPrisma.department.findFirst.mockResolvedValue({
        id: "dept-1",
        name: "Support",
      });
      mockPrisma.ticket.create.mockResolvedValue({
        id: "ticket-1",
        title: "Login issue",
        priority: "high",
      });

      const result = JSON.parse(
        await executeToolCall(
          "create_ticket",
          {
            title: "Login issue",
            description: "Cannot login",
            priority: "high",
            department: "Support",
          },
          "conv-1"
        )
      );

      expect(result.success).toBe(true);
      expect(result.ticketId).toBe("ticket-1");
      expect(mockPrisma.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: "Login issue",
            description: "Cannot login",
            priority: "high",
            conversationId: "conv-1",
            departmentId: "dept-1",
          }),
        })
      );
    });

    it("should create ticket without department when not found", async () => {
      mockPrisma.department.findFirst.mockResolvedValue(null);
      mockPrisma.ticket.create.mockResolvedValue({
        id: "ticket-2",
        title: "Issue",
        priority: "medium",
      });

      const result = JSON.parse(
        await executeToolCall("create_ticket", {
          title: "Issue",
          description: "Details",
          priority: "medium",
        })
      );

      expect(result.success).toBe(true);
    });
  });

  describe("assign_to_person", () => {
    it("should assign ticket to matching team member", async () => {
      mockPrisma.teamMember.findFirst.mockResolvedValue({
        id: "member-1",
        name: "Jane",
        department: { name: "Billing" },
      });
      mockPrisma.ticket.update.mockResolvedValue({});

      const result = JSON.parse(
        await executeToolCall("assign_to_person", {
          ticketId: "ticket-1",
          expertise: "billing",
        })
      );

      expect(result.success).toBe(true);
      expect(result.assignedTo).toBe("Jane");
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: "ticket-1" },
        data: { assignedToId: "member-1", status: "in_progress" },
      });
    });

    it("should return failure when no matching member found", async () => {
      mockPrisma.teamMember.findFirst.mockResolvedValue(null);

      const result = JSON.parse(
        await executeToolCall("assign_to_person", {
          ticketId: "ticket-1",
          expertise: "quantum-physics",
        })
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("No available team member");
    });
  });

  describe("send_internal_email", () => {
    it("should send email when SMTP is configured", async () => {
      mockPrisma.settings.findFirst.mockResolvedValue({
        smtpHost: "smtp.test.com",
        smtpPort: 587,
        smtpUser: "user@test.com",
        smtpPass: "pass",
        smtpFrom: "support@test.com",
      });
      // Attack-test 2026-10-21 (F-7): internal email may only go to a
      // recorded team member — register the recipient in the directory.
      mockPrisma.teamMember.findFirst.mockResolvedValue({
        id: "tm-1",
        name: "Team Member",
        email: "team@test.com",
      });

      const result = JSON.parse(
        await executeToolCall("send_internal_email", {
          to: "team@test.com",
          subject: "Urgent issue",
          body: "Please check ticket #123",
        })
      );

      expect(result.success).toBe(true);
    });

    it("should return failure when SMTP not configured", async () => {
      mockPrisma.settings.findFirst.mockResolvedValue({ smtpHost: null });

      const result = JSON.parse(
        await executeToolCall("send_internal_email", {
          to: "team@test.com",
          subject: "Test",
          body: "Test body",
        })
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Email not configured");
    });
  });

  describe("get_customer_history", () => {
    it("should return conversation history", async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([
        {
          channel: "whatsapp",
          status: "resolved",
          createdAt: new Date("2025-01-01"),
          summary: "Billing inquiry",
          messages: [
            { role: "customer", content: "Help with bill" },
            { role: "assistant", content: "Let me check" },
          ],
        },
      ]);

      // Attack-test 2026-10-21 (F-5): history is read for the customer
      // of the conversation the call runs in — mock that conversation.
      mockPrisma.conversation.findUnique.mockResolvedValue({
        id: "conv-1",
        customerId: null,
        customerContact: "+1555",
      });

      const result = JSON.parse(
        await executeToolCall(
          "get_customer_history",
          {
            customerContact: "+1555",
          },
          "conv-1"
        )
      );

      expect(result.success).toBe(true);
      expect(result.history).toHaveLength(1);
      expect(result.history[0].channel).toBe("whatsapp");
    });

    it("should return empty history for new customer", async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([]);
      mockPrisma.conversation.findUnique.mockResolvedValue({
        id: "conv-9",
        customerId: null,
        customerContact: "+9999",
      });

      const result = JSON.parse(
        await executeToolCall(
          "get_customer_history",
          {
            customerContact: "+9999",
          },
          "conv-9"
        )
      );

      expect(result.success).toBe(true);
      expect(result.history).toHaveLength(0);
      expect(result.message).toContain("No previous conversations");
    });
  });

  describe("schedule_followup", () => {
    it("should persist the follow-up and return success with scheduled time", async () => {
      mockPrisma.followUp.create.mockResolvedValue({
        id: "fu-1",
        conversationId: "conv-1",
        message: "How is everything going?",
        dueAt: new Date(Date.now() + 24 * 3600_000),
        status: "pending",
      });

      const result = JSON.parse(
        await executeToolCall("schedule_followup", {
          conversationId: "conv-1",
          message: "How is everything going?",
          delayHours: 24,
        })
      );

      expect(result.success).toBe(true);
      expect(result.followUpId).toBe("fu-1");
      expect(result.scheduledFor).toBeDefined();
      expect(mockPrisma.followUp.create).toHaveBeenCalledOnce();
      const data = mockPrisma.followUp.create.mock.calls[0][0].data;
      expect(data.conversationId).toBe("conv-1");
      expect(data.status).toBe("pending");
    });
  });

  describe("trigger_webhook", () => {
    it("should trigger webhook when found and active", async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: "wh-1",
        name: "Slack",
        url: "https://hooks.slack.com/test",
        method: "POST",
        headers: {},
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      global.fetch = mockFetch;

      const result = JSON.parse(
        await executeToolCall("trigger_webhook", {
          webhookName: "Slack",
          data: { event: "ticket_created" },
        })
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://hooks.slack.com/test",
        expect.objectContaining({
          method: "POST",
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("should return failure when webhook not found", async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue(null);

      const result = JSON.parse(
        await executeToolCall("trigger_webhook", {
          webhookName: "NonExistent",
        })
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("No active webhook");
    });
  });

  describe("unknown tool", () => {
    it("should return error for unknown tool name", async () => {
      const result = JSON.parse(
        await executeToolCall("nonexistent_tool", {})
      );

      expect(result.error).toContain("Unknown tool");
    });
  });
});
