/**
 * /api/broadcasts — LEG F (booking batch), STAGED ONLY.
 *
 * Broadcast discipline as an API, NOT a prospecting tool:
 * - Input is ONLY existing conversation IDs belonging to this tenant.
 *   There is no phone-number list, no customer-ID list, no import and
 *   no upload in this route — an ID that does not resolve to one of
 *   this tenant's conversations is skipped, never messaged. Cold
 *   outreach is impossible through this endpoint by construction.
 * - This route shares NO store, NO code path and NO recipient list
 *   with the outbound client-finding system. The two systems must stay
 *   separate; this route never calls any lead/client-finding code.
 * - Two phases, enforced in order:
 *   1. action:"test" — queue ONE test-send of the exact message to a
 *      conversation the tenant nominates as the business's own chat.
 *      Delivery itself runs through the existing follow-up processor
 *      (POST /api/followups/process), so the test is a real delivery,
 *      not a simulation.
 *   2. action:"send" — only after a broadcast_test record with a
 *      BYTE-IDENTICAL message has status "sent". If the message
 *      changed, the old test does not validate and the send is
 *      refused (400 test_send_required) — the business must test again.
 * - Per recipient, the pure gate in src/lib/followup-discipline.ts
 *   decides: messaged in the last 23 hours, not in human hands, not
 *   already broadcast to, allowed channel (WhatsApp and website chat
 *   excluded in this batch), not blocked, thread not closed. Only
 *   eligible recipients get a broadcast follow-up record (due now,
 *   delivered by the existing processor, which re-checks the window
 *   and suppression rules at delivery time via the Leg F followups
 *   diff). Ineligible recipients get NO record and a reason each.
 * - Promotions NEVER after 24 hours: the 23h eligibility gate is
 *   stricter than the ban, so it holds by construction.
 * - Auth: conversations:update (existing permission — no new rbac key
 *   is introduced by this leg, so there is no rbac diff to reconcile).
 *   A null businessId fails closed with 403 (Leg H pattern).
 * - This route sends nothing itself and invents no wording: `message`
 *   is tenant-supplied. Reminder/broadcast copy remains a PROPOSAL for
 *   owner approval wherever the dashboard supplies default text; this
 *   route never fills in a default message.
 *
 * OPEN ITEMS (see LEG-REPORT, not papered over):
 * - "The business's own chat" has no marker field at HEAD (NOT FOUND):
 *   the test step trusts the tenant-nominated conversation ID. A
 *   dedicated own-chat marker is an apply-time follow-up.
 * - The 200-recipient per-request cap below is an abuse safeguard,
 *   NOT a plan quota and never counted against message quotas.
 *   The value itself is flagged for owner confirmation.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  evaluateBroadcastRecipient,
  FOLLOWUP_KINDS,
  hashMessage,
  isTestSendValid,
} from "@/lib/followup-discipline";

const MAX_RECIPIENTS_PER_REQUEST = 200;

type ConversationRow = {
  id: string;
  businessId?: string | null;
  channel: string;
  aiEnabled?: boolean | null;
  status?: string | null;
  customerId?: string | null;
};

async function loadConversation(id: string): Promise<ConversationRow | null> {
  return (await prisma.conversation.findUnique({
    where: { id },
  })) as ConversationRow | null;
}

async function lastCustomerMessageAtMs(
  conversationId: string
): Promise<number | null> {
  // Proven HEAD pattern (dropped revival): load messages ascending and
  // take the last customer message. No new query shape is invented.
  const messages = ((await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  })) ?? []) as Array<{ role: string; createdAt: unknown }>;
  let last: number | null = null;
  for (const m of messages) {
    if (m.role === "customer") last = new Date(m.createdAt as string).getTime();
  }
  return Number.isFinite(last) ? last : null;
}

async function isCustomerBlocked(
  customerId: string | null | undefined
): Promise<boolean> {
  if (!customerId) return false;
  const customer = await prisma.customer
    .findUnique({ where: { id: customerId } })
    .catch(() => null);
  return (customer as { isBlocked?: boolean } | null)?.isBlocked === true;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(auth)) return auth;
  const businessId = auth.businessId;
  if (!businessId) {
    return NextResponse.json({ error: "Business context required" }, { status: 403 });
  }
  return runWithBusiness(businessId, async () => {
    const items = await prisma.followUp.findMany({
      where: { kind: FOLLOWUP_KINDS.broadcast },
      orderBy: { dueAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ broadcasts: items });
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(auth)) return auth;
  const businessId = auth.businessId;
  if (!businessId) {
    return NextResponse.json({ error: "Business context required" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message : "";
  if (message.trim().length === 0) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  const action = body.action;

  return runWithBusiness(businessId, async () => {
    try {
      if (action === "test") {
        const testConversationId =
          typeof body.testConversationId === "string" ? body.testConversationId : "";
        if (!testConversationId) {
          return NextResponse.json(
            { error: "testConversationId is required for a test-send" },
            { status: 400 }
          );
        }
        const conv = await loadConversation(testConversationId);
        if (!conv) {
          return NextResponse.json({ error: "Test conversation not found" }, { status: 404 });
        }
        if (conv.businessId && conv.businessId !== businessId) {
          return NextResponse.json({ error: "Conversation belongs to another business" }, { status: 403 });
        }
        await prisma.followUp.create({
          data: withBusinessId({
            conversationId: conv.id,
            message,
            dueAt: new Date(),
            status: "pending",
            kind: FOLLOWUP_KINDS.broadcastTest,
          }),
        });
        return NextResponse.json({
          testQueued: true,
          messageHash: hashMessage(message),
          conversationId: conv.id,
          note: "Test delivery runs through the existing follow-up processor; send is refused until this test record is sent.",
        });
      }

      if (action !== "send") {
        return NextResponse.json({ error: "action must be test or send" }, { status: 400 });
      }

      const conversationIds = Array.isArray(body.conversationIds)
        ? body.conversationIds.filter((v): v is string => typeof v === "string")
        : [];
      if (conversationIds.length === 0) {
        return NextResponse.json(
          { error: "conversationIds (existing conversations only) is required" },
          { status: 400 }
        );
      }
      if (conversationIds.length > MAX_RECIPIENTS_PER_REQUEST) {
        return NextResponse.json(
          { error: `At most ${MAX_RECIPIENTS_PER_REQUEST} recipients per request` },
          { status: 400 }
        );
      }

      // Mandatory test-send gate: a SENT test record with a
      // byte-identical message must exist, or nothing is created.
      const testRecord = (await prisma.followUp.findFirst({
        where: { kind: FOLLOWUP_KINDS.broadcastTest, message },
      })) as { status?: string; message?: string } | null;
      if (
        !isTestSendValid({
          testMessage: testRecord?.message ?? null,
          testStatus: testRecord?.status ?? null,
          sendMessage: message,
        })
      ) {
        return NextResponse.json(
          {
            error: "test_send_required",
            detail:
              "Send a test first (action:test) and wait until it is sent; if the message changed, test again with the new text.",
          },
          { status: 400 }
        );
      }

      const nowMs = Date.now();
      const created: string[] = [];
      const skipped: Array<{ conversationId: string; reasons: string[] }> = [];
      for (const conversationId of conversationIds) {
        const conv = await loadConversation(conversationId);
        if (!conv) {
          skipped.push({ conversationId, reasons: ["conversation_not_found"] });
          continue;
        }
        const tenantMatch = !conv.businessId || conv.businessId === businessId;
        const prior = (await prisma.followUp.findMany({
          where: { conversationId: conv.id, kind: FOLLOWUP_KINDS.broadcast },
        })) as Array<{ status?: string }>;
        const alreadyReceivedBroadcast = prior.some((r) =>
          ["pending", "sending", "sent"].includes(r.status ?? "")
        );
        const eligibility = evaluateBroadcastRecipient({
          conversationId: conv.id,
          tenantMatch,
          channel: conv.channel,
          aiEnabled: conv.aiEnabled !== false,
          conversationStatus: conv.status ?? "active",
          isBlocked: await isCustomerBlocked(conv.customerId),
          lastCustomerMessageAtMs: await lastCustomerMessageAtMs(conv.id),
          nowMs,
          alreadyReceivedBroadcast,
          // Input here is always resolved tenant conversations: any
          // other source (import, list, cold number) cannot reach this
          // loop, because it would not resolve to a conversation ID.
          source: "conversation",
        });
        if (!eligibility.eligible) {
          skipped.push({ conversationId, reasons: eligibility.reasons });
          continue;
        }
        await prisma.followUp.create({
          data: withBusinessId({
            conversationId: conv.id,
            message,
            dueAt: new Date(),
            status: "pending",
            kind: FOLLOWUP_KINDS.broadcast,
          }),
        });
        created.push(conversationId);
      }
      return NextResponse.json({ created, createdCount: created.length, skipped });
    } catch (error) {
      logger.error("Broadcast request failed:", error);
      return NextResponse.json({ error: "Failed to process broadcast" }, { status: 500 });
    }
  });
}
