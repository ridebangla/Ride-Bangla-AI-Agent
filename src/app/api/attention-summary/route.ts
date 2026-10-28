/**
 * GET /api/attention-summary — TIPS Leg A (honest "gone quiet"
 * concept), STAGED ONLY.
 *
 * Read-only summary of unreplied threads by silence, layered on
 * the staged Leg B follow-up queues. It returns COUNTS ONLY — no
 * money figure, no order total, no price, no fare, no currency
 * value is read, computed or returned. A quiet thread is reported
 * as a thread that needs a human reply first; it is never reported
 * as proof that an order was missed.
 *
 * APPLY DEPENDENCY (read before landing): this route imports
 * buildQueues from "@/lib/unreplied-queues" — the staged Leg B
 * pure module. Leg B must land BEFORE this route, or this route
 * fails to resolve its import. This route does NOT import Leg B's
 * route file; it performs its own conversation/message/pending-
 * order scan with the same caps as Leg B (SCAN_CAP 500,
 * MESSAGE_TAKE 200, PENDING_ORDER_TAKE 1000) so its counts stay
 * comparable with the Follow-up Queues page. If the two scans
 * ever diverge in volume, the route reports scanTruncated and the
 * quiet list is capped separately (QUIET_RETURN_CAP 20).
 *
 * What this route deliberately does NOT do:
 *   - no writes of any kind;
 *   - no order confirmation, edit, reopen or re-price (the team
 *     confirms orders; pending orders are counted, never decided);
 *   - no text scanning / classification: intent comes from Leg B's
 *     recorded evidence only (pending order / open lead / recorded
 *     warm-hot state);
 *   - no money computation: the money version in the leg report §5
 *     is PROPOSAL ONLY and is not implemented here;
 *   - no new quota or plan gate: reading a summary is team
 *     operations, not AI usage, so it is never metered;
 *   - no new rbac key: it reuses "conversations:read", the same
 *     permission as Leg B's route. A Super Admin with businessId
 *     null gets 403 — tenant summary data is never served unscoped.
 *
 * Last-customer derivation (honest edge): Leg B's unreplied row
 * carries waitingSince but not the last-customer time, so this
 * route derives lastCustomerMs from the loaded message tail for
 * each unreplied thread. If the tail contains no customer message
 * (possible only when MESSAGE_TAKE truncated a very long thread),
 * that thread is dropped from the summary and counted in
 * threadsDroppedNoLastCustomerInTail — never bucketed by guess.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  buildQueues,
  type IntentEvidenceInput,
} from "@/lib/unreplied-queues";
import {
  buildAttentionSummary,
  PROPOSED_AT_RISK_AFTER_MS,
  PROPOSED_QUIET_AFTER_MS,
  type AttentionThreadInput,
  type AttentionPendingOrderInput,
} from "@/lib/attention-summary";

const SCAN_CAP = 500;
const MESSAGE_TAKE = 200;
const RESPONSE_QUIET_CAP = 20;
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

      const convRows = (await prisma.conversation.findMany({
        orderBy: { updatedAt: "asc" },
        take: SCAN_CAP,
      })) as unknown as Row[];
      const scanTruncated = convRows.length >= SCAN_CAP;

      const perThread = await Promise.all(
        convRows.map(async (c) => {
          const msgs = (await prisma.message.findMany({
            where: { conversationId: c.id },
            orderBy: { createdAt: "desc" },
            take: MESSAGE_TAKE,
          })) as unknown as Row[];
          return { id: c.id, asc: [...msgs].reverse() };
        }),
      );
      const messagesByConv = new Map(perThread.map((t) => [t.id, t.asc]));

      const conversations = convRows.map((c) => ({
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

      const orderRows = (await prisma.order.findMany({
        where: { status: "pending" },
        take: PENDING_ORDER_TAKE,
      })) as unknown as Row[];
      const pendingOrderEvidence: Record<string, IntentEvidenceInput[]> = {};
      const pendingOrderByConv = new Set<string>();
      const pendingOrders: AttentionPendingOrderInput[] = [];
      for (const o of orderRows) {
        const convId =
          typeof (o as Row).conversationId === "string"
            ? ((o as Row).conversationId as string)
            : null;
        if (convId) {
          pendingOrderByConv.add(convId);
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
        const createdMs = new Date(
          (o as Row).createdAt as string,
        ).getTime();
        pendingOrders.push({
          id: o.id,
          businessId: String(o.businessId ?? ""),
          conversationId: convId,
          status: "pending",
          createdAtMs: createdMs,
        });
      }

      // Inbound-lead seam, mirrored from Leg B: the delegate exists
      // only after Leg H lands; otherwise the source is reported as
      // unavailable, never silently treated as "no leads".
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

      // RECORDED-INTENT SEAM — intentionally empty at HEAD (see Leg B).
      const recordedIntent: Record<string, "warm" | "hot"> = {};
      const recordedIntentAt: Record<string, Date | string> = {};

      // Two-pass blocked handling, mirrored from Leg B: first pass
      // finds candidates, blocked lookups run for candidates only,
      // then the final pass applies them.
      const baseInput = {
        businessId,
        nowMs,
        conversations,
        pendingOrderEvidence,
        leadEvidence,
        leadEvidenceByCustomer,
        recordedIntent,
        recordedIntentAt,
      };
      const first = buildQueues(baseInput);
      const candidateIds = new Set([
        ...first.unreplied.map((r) => r.conversationId),
        ...first.orderingIntent.map((r) => r.conversationId),
      ]);
      const customerBlockedByConversation: Record<string, boolean> = {};
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
          // Failed lookup fails open to visibility (the summary
          // sends nothing); the row stays.
        }
      }
      const queues = buildQueues({
        ...baseInput,
        customerBlockedByConversation,
      });

      // Derive lastCustomerMs per unreplied thread from the tail.
      const threads: AttentionThreadInput[] = [];
      let threadsDroppedNoLastCustomerInTail = 0;
      for (const row of queues.unreplied) {
        const tail = messagesByConv.get(row.conversationId) ?? [];
        let lastCustomerMs: number | null = null;
        for (let i = tail.length - 1; i >= 0; i--) {
          if (String((tail[i] as Row).role ?? "") === "customer") {
            const t = new Date(
              (tail[i] as Row).createdAt as string,
            ).getTime();
            if (!Number.isNaN(t)) lastCustomerMs = t;
            break;
          }
        }
        if (lastCustomerMs === null) {
          threadsDroppedNoLastCustomerInTail += 1;
          continue;
        }
        threads.push({
          conversationId: row.conversationId,
          businessId: row.businessId,
          channel: row.channel,
          customerName: row.customerName,
          status: row.status,
          aiEnabled: row.aiEnabled,
          waitingSinceMs: row.waitingSinceMs,
          lastCustomerMs,
          unrepliedCount: row.unrepliedCount,
          alsoHasIntent: row.alsoHasIntent,
          hasPendingOrder: pendingOrderByConv.has(row.conversationId),
        });
      }

      const summary = buildAttentionSummary({
        businessId,
        nowMs,
        threads,
        pendingOrders,
        atRiskAfterMs: PROPOSED_AT_RISK_AFTER_MS,
        quietAfterMs: PROPOSED_QUIET_AFTER_MS,
      });

      return NextResponse.json({
        windowDays: summary.windowDays,
        thresholds: summary.thresholds,
        scannedConversations: convRows.length,
        scanTruncated,
        intentSourcesAvailable,
        threadsDroppedNoLastCustomerInTail,
        counts: summary.counts,
        oldestWaitingSinceIso: summary.oldestWaitingSinceIso,
        longestSilenceHours: summary.longestSilenceHours,
        quietThreadsReturned: Math.min(
          summary.quietThreads.length,
          RESPONSE_QUIET_CAP,
        ),
        quietThreadsTotal: summary.quietThreads.length,
        quietThreads: summary.quietThreads
          .slice(0, RESPONSE_QUIET_CAP)
          .map((q) => ({
            conversationId: q.conversationId,
            channel: q.channel,
            customerName: q.customerName,
            status: q.status,
            aiEnabled: q.aiEnabled,
            waitingSinceIso: q.waitingSinceIso,
            lastCustomerIso: q.lastCustomerIso,
            silenceHours: q.silenceHours,
            waitingHours: q.waitingHours,
            unrepliedCount: q.unrepliedCount,
            alsoHasIntent: q.alsoHasIntent,
            hasPendingOrder: q.hasPendingOrder,
          })),
        // No money figure is computed by this route. The field is
        // present and null so no consumer can mistake absence for
        // an uncomputed value that should be filled by guesswork;
        // the money version is PROPOSAL ONLY (leg report §5).
        money: null,
        excluded: summary.excluded,
      });
    } catch (error) {
      logger.error("Failed to fetch attention summary:", error);
      return NextResponse.json(
        { error: "Failed to fetch attention summary" },
        { status: 500 },
      );
    }
  });
}
