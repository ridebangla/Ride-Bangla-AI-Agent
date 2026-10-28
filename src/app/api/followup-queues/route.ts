/**
 * GET /api/followup-queues — LEG B (video round 2), STAGED ONLY.
 *
 * Read-only team follow-up queues. Returns BOTH queues in one response
 * so the dashboard can render them as two separate sections:
 *   - unreplied: customer messages in the last 30 days with no recorded
 *     assistant/admin reply after them (see src/lib/unreplied-queues.ts
 *     for the exact definition);
 *   - orderingIntent: conversations with RECORDED ordering intent in
 *     the last 30 days (a pending order, an open inbound lead, or a
 *     recorded warm/hot intent state — never a guess from message text).
 *
 * What this route deliberately does NOT do:
 *   - no writes of any kind (no orders, no support records, no
 *     messages, no follow-up records are created here);
 *   - no bulk messaging and no campaign send path;
 *   - no text scanning / classification: raw customer text is never
 *     classified here. At HEAD there is no recorded intent field, so
 *     recordedIntent is an empty map and the intent queue is built
 *     from pending orders plus (when it exists) the inbound-lead
 *     delegate. The two future wirings are named in the seam comment
 *     below and are NOT wired silently.
 *   - no new quota or plan gate: reading a queue is team operations,
 *     not AI usage, so it is never metered and never blocked by plan.
 *   - no price, total or fare is read, computed or returned. Order
 *     rows contribute only id + status + createdAt; the preview on
 *     an unreplied row is the customer's own message text, truncated
 *     to 140 chars exactly as HEAD /api/inbox does.
 *
 * Tenancy: requireAuth with "conversations:read" (the same permission
 * as /api/inbox; no new rbac key is introduced). A Super Admin with
 * businessId null gets 403 — tenant queue data is never served
 * unscoped. All queries run inside runWithBusiness, and the pure
 * module re-checks every row's businessId, so a foreign row can
 * never surface even if a query were mis-scoped.
 *
 * Bounds (read safeguards, NOT plan quotas — they are never counted
 * against any message allowance):
 *   - SCAN_CAP conversations, oldest-updated first, so the
 *     oldest-first triage order is preserved when the cap binds;
 *     scanTruncated is reported honestly when it does.
 *   - MESSAGE_TAKE newest messages per thread, reversed to
 *     chronological order for the pure module. If a thread returns
 *     exactly MESSAGE_TAKE messages its tail may be cut; those rows
 *     carry messagesTruncated: true.
 *   - RESPONSE_CAP rows per queue in the response.
 *   - Pending orders are read with a status equality (pending only);
 *     confirmed/cancelled orders never enter the intent queue.
 *
 * Deep-link note: there is no evidenced per-thread dashboard URL at
 * HEAD (the Inbox selects threads by client state, not by URL), so
 * rows link to /inbox and the team finds the thread by the customer
 * name shown. A ?conversation= deep link is follow-up work, not
 * invented here.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  buildQueues,
  type IntentEvidenceInput,
  type QueueConversation,
} from "@/lib/unreplied-queues";

const SCAN_CAP = 500;
const MESSAGE_TAKE = 200;
const RESPONSE_CAP = 100;
const PENDING_ORDER_TAKE = 1000;
const OPEN_LEAD_STAGES = ["new", "contacted", "interested", "quoted"];

type Row = Record<string, unknown> & {
  id: string;
  businessId?: unknown;
  customerId?: unknown;
  status?: unknown;
};

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "Tenant data requires a business context." },
      { status: 403 },
    );
  }
  const businessId = auth.businessId;

  return runWithBusiness(businessId, async () => {
    try {
      const nowMs = Date.now();

      // 1. Scan conversations oldest-updated first (triage order).
      const convRows = (await prisma.conversation.findMany({
        orderBy: { updatedAt: "asc" },
        take: SCAN_CAP,
      })) as unknown as Row[];
      const scanTruncated = convRows.length >= SCAN_CAP;

      // 2. Tail messages per thread (newest first, then reversed).
      const perThread = await Promise.all(
        convRows.map(async (c) => {
          const msgs = (await prisma.message.findMany({
            where: { conversationId: c.id },
            orderBy: { createdAt: "desc" },
            take: MESSAGE_TAKE,
          })) as unknown as Row[];
          const truncated = msgs.length >= MESSAGE_TAKE;
          return { id: c.id, truncated, asc: [...msgs].reverse() };
        }),
      );
      const messagesByConv = new Map(
        perThread.map((t) => [t.id, t.asc]),
      );
      const truncatedByConv = new Map(
        perThread.map((t) => [t.id, t.truncated]),
      );

      const conversations: QueueConversation[] = convRows.map((c) => ({
        id: c.id,
        businessId: String(c.businessId ?? ""),
        channel: String((c as Row).channel ?? ""),
        customerName: String((c as Row).customerName ?? "Unknown"),
        customerContact: String((c as Row).customerContact ?? ""),
        customerId:
          typeof c.customerId === "string" ? c.customerId : null,
        status: String(c.status ?? ""),
        aiEnabled: (c as Row).aiEnabled !== false,
        messages: (messagesByConv.get(c.id) ?? []).map((m) => ({
          id: m.id,
          role: String(m.role ?? ""),
          content: String((m as Row).content ?? ""),
          createdAt: (m as Row).createdAt as Date | string,
        })),
      }));

      // 3. Pending orders (the only intent source present at HEAD).
      const orderRows = (await prisma.order.findMany({
        where: { status: "pending" },
        take: PENDING_ORDER_TAKE,
      })) as unknown as Row[];
      const pendingOrderEvidence: Record<string, IntentEvidenceInput[]> = {};
      for (const o of orderRows) {
        const convId =
          typeof (o as Row).conversationId === "string"
            ? ((o as Row).conversationId as string)
            : null;
        if (!convId) continue;
        const list = pendingOrderEvidence[convId] ?? [];
        list.push({
          source: "pending_order",
          detail: "pending",
          businessId: String(o.businessId ?? ""),
          recordedAt: (o as Row).createdAt as Date | string,
          orderId: o.id,
        });
        pendingOrderEvidence[convId] = list;
      }

      // 4. Inbound-lead seam (staged Leg H). The delegate exists only
      // after Leg H lands; when it does not, this source is reported
      // as unavailable — it is never silently treated as "no leads".
      const intentSourcesAvailable: string[] = ["pending_order"];
      const leadEvidence: Record<string, IntentEvidenceInput[]> = {};
      const leadEvidenceByCustomer: Record<string, IntentEvidenceInput[]> =
        {};
      const maybeLeads = (
        prisma as unknown as {
          inboundLead?: {
            findMany: (args: unknown) => Promise<unknown>;
          };
        }
      ).inboundLead;
      if (maybeLeads) {
        intentSourcesAvailable.push("inbound_lead_open");
        const leadRows = (await maybeLeads.findMany({
          where: { stage: { in: OPEN_LEAD_STAGES } },
        })) as unknown as Row[];
        for (const l of leadRows) {
          const ev: IntentEvidenceInput = {
            source: "inbound_lead_open",
            detail: String(l.stage ?? ""),
            businessId: String(l.businessId ?? ""),
            recordedAt: (l as Row).createdAt as Date | string,
            leadStage: String(l.stage ?? ""),
          };
          const convId =
            typeof (l as Row).conversationId === "string"
              ? ((l as Row).conversationId as string)
              : null;
          const custId =
            typeof l.customerId === "string" ? l.customerId : null;
          if (convId) {
            const list = leadEvidence[convId] ?? [];
            list.push(ev);
            leadEvidence[convId] = list;
          } else if (custId) {
            const list = leadEvidenceByCustomer[custId] ?? [];
            list.push(ev);
            leadEvidenceByCustomer[custId] = list;
          }
        }
      }

      // 5. RECORDED-INTENT SEAM — intentionally empty at HEAD.
      // There is no recorded warm/hot intent field on any HEAD doc,
      // and this leg does not invent one by scanning message text.
      // Future wiring (owner-approved, separate change, never silent):
      //   (a) staged Leg F warm_followup / hot_followup follow-up
      //       records on the conversation -> recordedIntent +
      //       recordedIntentAt from the record's kind + createdAt;
      //   (b) a dedicated classifier that WRITES its warm/hot verdict
      //       to a recorded field -> read that field here.
      // Until one of those lands, recorded_intent contributes nothing
      // and intentSourcesAvailable honestly omits it.
      const recordedIntent: Record<string, "warm" | "hot"> = {};
      const recordedIntentAt: Record<string, Date | string> = {};

      // 6. First pass (no blocked map) to find queue candidates, then
      // look up blocked status for candidates only, then final pass.
      const first = buildQueues({
        businessId,
        nowMs,
        conversations,
        pendingOrderEvidence,
        leadEvidence,
        leadEvidenceByCustomer,
        recordedIntent,
        recordedIntentAt,
      });
      const candidateIds = new Set([
        ...first.unreplied.map((r) => r.conversationId),
        ...first.orderingIntent.map((r) => r.conversationId),
      ]);
      const customerBlockedByConversation: Record<string, boolean> = {};
      let blockedExcludedCount = 0;
      for (const conv of conversations) {
        if (!candidateIds.has(conv.id) || !conv.customerId) continue;
        try {
          const customer = (await prisma.customer.findUnique({
            where: { id: conv.customerId },
          })) as unknown as Row | null;
          if (customer && (customer as Row).isBlocked === true) {
            customerBlockedByConversation[conv.id] = true;
          }
        } catch {
          // A failed lookup must not drop a thread: fail open to
          // visibility (the queue sends nothing), and the row stays.
        }
      }
      const result = buildQueues({
        businessId,
        nowMs,
        conversations,
        pendingOrderEvidence,
        leadEvidence,
        leadEvidenceByCustomer,
        recordedIntent,
        recordedIntentAt,
        customerBlockedByConversation,
      });
      blockedExcludedCount =
        candidateIds.size -
        new Set([
          ...result.unreplied.map((r) => r.conversationId),
          ...result.orderingIntent.map((r) => r.conversationId),
        ]).size;

      // 7. Attach route-level truncation flags and apply the
      // response cap (both queues, separately).
      const unreplied = result.unreplied.slice(0, RESPONSE_CAP).map((r) => ({
        ...r,
        messagesTruncated: truncatedByConv.get(r.conversationId) ?? false,
      }));
      const orderingIntent = result.orderingIntent
        .slice(0, RESPONSE_CAP)
        .map((r) => ({
          ...r,
          messagesTruncated:
            truncatedByConv.get(r.conversationId) ?? false,
        }));

      return NextResponse.json({
        window: result.window,
        scannedConversations: convRows.length,
        scanCap: SCAN_CAP,
        scanTruncated,
        intentSourcesAvailable,
        blockedExcludedCount,
        counts: {
          unreplied: result.counts.unreplied,
          orderingIntent: result.counts.orderingIntent,
          overlap: result.counts.overlap,
          unrepliedReturned: unreplied.length,
          orderingIntentReturned: orderingIntent.length,
        },
        overlapConversationIds: result.overlapConversationIds,
        unreplied,
        orderingIntent,
        // Excluded rows are diagnostic only (why a thread is NOT in
        // a queue); the page does not render them as work items.
        excluded: result.excluded,
      });
    } catch (error) {
      logger.error("Failed to fetch follow-up queues:", error);
      return NextResponse.json(
        { error: "Failed to fetch follow-up queues" },
        { status: 500 },
      );
    }
  });
}
