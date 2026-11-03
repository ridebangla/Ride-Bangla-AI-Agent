/**
 * team-b-tickets-orders.test.ts — TEAM B (AI-repo side): orders +
 * tickets doctrine, targeted tests for the files TEAM B touched.
 *
 * Covered here:
 * - POST /api/tickets (dashboard, explicit human action only):
 *   every created ticket gets a short SITE-XXXXXXXX recording
 *   reference (never a raw id), sourceChannel defaults to
 *   "dashboard", and priority/status vocab is validated instead of
 *   stored verbatim.
 * - POST /api/public/tickets (Help Center form intake, explicit
 *   visitor submission only): reference is returned, and the record
 *   carries queryable source attribution + a kind tag
 *   (team_report for technical/feedback, support_ticket otherwise)
 *   so the future Reports leg can split the queue. The intake
 *   itself does NOT reroute — that awaits the Reports-spec
 *   decision (see coordinator report).
 * - src/lib/ai/agent-report.ts: disclosure never shows a raw UUID
 *   (returns null), accepts a short reference, and the problem
 *   report carries the visitor's FULL words in customerMessage.
 * - Order doctrine (unchanged, regression pin): setOrderStatus /
 *   order-lock still refuse non-human actors — see
 *   tests/unit/order-lock.test.ts for the full guard suite; here
 *   only the agent-may-not-confirm rule is pinned.
 *
 * Uses the global test mocks (tests/setup.ts): prisma + route-auth
 * mocked, runWithBusiness passes through. No live browser drive —
 * behaviours here are code-level only (UNVERIFIED live).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST as ticketsPOST } from "@/app/api/tickets/route";
import { POST as publicTicketsPOST } from "@/app/api/public/tickets/route";
import { prisma } from "@/lib/prisma";
import {
  buildAgentProblemReport,
  disclosureForReport,
  isShortTicketReference,
} from "@/lib/ai/agent-report";
import { guardAgentStatusChange } from "@/lib/order-lock";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

function jsonRequest(url: string, body: unknown, ip?: string): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (ip) headers["x-forwarded-for"] = ip;
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tickets (dashboard)", () => {
  it("stores a short recording reference + dashboard source, and normalises vocab", async () => {
    const created = {
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      title: "Help needed",
      description: "Full detail here",
      priority: "medium",
      status: "open",
    };
    db.ticket.create.mockResolvedValue(created);
    db.ticket.update.mockResolvedValue({ ...created, reference: "AI-ABCDEF12" });
    db.business.findUnique.mockResolvedValue({
      slug: "ride-bangla-ai",
      name: "Ride Bangla AI",
    });

    const res = await ticketsPOST(
      jsonRequest("http://localhost/api/tickets", {
        title: "Help needed",
        description: "Full detail here",
        // Out-of-vocab values must NOT be stored verbatim.
        priority: "critical!!",
        status: "whatever",
      })
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.reference).toBe("AI-ABCDEF12");
    expect((data.reference as string).length).toBeLessThan(20);
    expect(data.reference).not.toContain("abcdef12-3456");

    const createData = db.ticket.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData.priority).toBe("medium");
    expect(createData.status).toBe("open");
    expect(createData.sourceChannel).toBe("dashboard");
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: created.id },
      data: { reference: "AI-ABCDEF12" },
    });
  });

  it("keeps caller-supplied source attribution when given", async () => {
    const created = { id: "11111111-2222-3333-4444-555555555555", title: "T" };
    db.ticket.create.mockResolvedValue(created);
    db.ticket.update.mockResolvedValue({ ...created, reference: "RB-11111111" });
    db.business.findUnique.mockResolvedValue({ slug: null, name: null });

    const res = await ticketsPOST(
      jsonRequest("http://localhost/api/tickets", {
        title: "T",
        sourceWebsite: "ai.ridebangla.bd",
        sourceChannel: "help-center-form",
        visitorName: "Visitor",
        visitorContact: "01XXXXXXXXX",
      })
    );
    expect(res.status).toBe(201);
    const createData = db.ticket.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData.sourceWebsite).toBe("ai.ridebangla.bd");
    expect(createData.sourceChannel).toBe("help-center-form");
    expect(createData.visitorName).toBe("Visitor");
    // No business name/slug -> RB fallback reference, still short.
    expect((await res.json() as Record<string, unknown>).reference).toBe(
      "RB-11111111"
    );
  });
});

describe("POST /api/public/tickets (Help Center form intake)", () => {
  it("returns a reference and tags technical topics as team_report", async () => {
    db.business.findUnique.mockResolvedValue({
      id: "biz-ai",
      name: "Ride Bangla AI",
      isInternalAccount: false,
    });
    const created = { id: "deadbeef-1234-5678-9abc-def012345678" };
    db.ticket.create.mockResolvedValue(created);
    db.ticket.update.mockResolvedValue({ ...created, reference: "AI-DEADBEEF" });

    const res = await publicTicketsPOST(
      jsonRequest(
        "http://localhost/api/public/tickets",
        {
          siteKey: "site-key-technical",
          name: "Visitor",
          contact: "visitor@example.com",
          topic: "technical",
          message: "The tool on the website is not working for me.",
          pageUrl: "https://ai.ridebangla.bd/contact",
        },
        "192.0.2.101"
      )
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.reference).toBe("AI-DEADBEEF");
    const createData = db.ticket.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    const metadata = createData.metadata as Record<string, unknown>;
    expect(metadata.kind).toBe("team_report");
    expect(metadata.sourceTeam).toBe("Ride Bangla AI");
    expect(metadata.intake).toBe("help-center-form");
    expect(createData.sourceChannel).toBe("help-center-form");
    expect(String(createData.description)).toContain(
      "The tool on the website is not working for me."
    );
  });

  it("tags general topics as support_ticket", async () => {
    db.business.findUnique.mockResolvedValue({
      id: "biz-ai",
      name: "Ride Bangla AI",
      isInternalAccount: false,
    });
    const created = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    db.ticket.create.mockResolvedValue(created);
    db.ticket.update.mockResolvedValue({ ...created, reference: "AI-AAAAAAAA" });

    const res = await publicTicketsPOST(
      jsonRequest(
        "http://localhost/api/public/tickets",
        {
          siteKey: "site-key-general",
          name: "Visitor",
          contact: "visitor@example.com",
          topic: "general",
          message: "I have a question about your service please.",
        },
        "192.0.2.102"
      )
    );
    expect(res.status).toBe(201);
    const createData = db.ticket.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect((createData.metadata as Record<string, unknown>).kind).toBe(
      "support_ticket"
    );
  });
});

describe("agent-report disclosure + full-words record", () => {
  it("never discloses a raw UUID; a short reference is shown", () => {
    expect(
      disclosureForReport("en", "abcdef12-3456-7890-abcd-ef1234567890")
    ).toBeNull();
    expect(disclosureForReport("en", null)).toBeNull();
    expect(disclosureForReport("en", "not-a-reference!!")).toBeNull();
    expect(isShortTicketReference("AI-ABCDEF12")).toBe(true);
    expect(isShortTicketReference("abcdef12-3456-7890-abcd-ef1234567890")).toBe(
      false
    );
    const shown = disclosureForReport("en", "AI-ABCDEF12");
    expect(shown).toContain("AI-ABCDEF12");
    expect(disclosureForReport("bn", "AI-ABCDEF12")).toContain("AI-ABCDEF12");
  });

  it("buildAgentProblemReport keeps the visitor's full words", () => {
    const longMessage = "word ".repeat(300).trim(); // > 500 chars
    const report = buildAgentProblemReport({
      conversationId: "conv-1",
      customerMessage: longMessage,
    });
    expect(report.kind).toBe("report");
    expect(report.createdVia).toBe("agent");
    expect(report.customerMessage).toBe(longMessage);
    expect(report.customerMessage.length).toBeGreaterThan(500);
  });
});

describe("order doctrine regression pin", () => {
  it("agent/customer/system actors may never write order status", () => {
    expect(guardAgentStatusChange("agent")).toEqual({
      allowed: false,
      reason: "agent_may_not_confirm",
    });
    expect(guardAgentStatusChange("customer")).toEqual({
      allowed: false,
      reason: "agent_may_not_confirm",
    });
    expect(guardAgentStatusChange("system")).toEqual({
      allowed: false,
      reason: "agent_may_not_confirm",
    });
    expect(guardAgentStatusChange("human")).toEqual({
      allowed: true,
      reason: "ok",
    });
  });
});
