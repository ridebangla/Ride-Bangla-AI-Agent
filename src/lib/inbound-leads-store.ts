/**
 * inbound-leads-store.ts — SERVER-ONLY store for inbound leads.
 *
 * The single funnel for inbound-lead writes: the dashboard routes and the
 * agent's create_inbound_lead tool both come through here, so dedupe
 * cannot be bypassed by calling a different entry point.
 *
 * Tenancy: every query runs on the ambient tenant-scoped `prisma` client
 * (fail-closed — throws TenantContextError with no business context, the
 * same contract as src/lib/orders.ts). The `inboundLead` model is a NEW
 * Firestore collection (`inboundLeads`), registered in firestore.ts
 * alongside — never inside — the outbound `leads` collection.
 *
 * What this file does NOT do, deliberately:
 * - It never confirms an order, never touches orders, tickets or billing.
 * - It never quotes a fare or price. Interest text is the customer's own
 *   words (or the team's note), stored verbatim, not a price promise.
 * - It never writes to the outbound leads system (no `prisma.lead` call
 *   anywhere in this file).
 */

import { prisma, withBusinessId } from "@/lib/prisma";
import {
  INBOUND_LEAD_STAGES,
  OPEN_INBOUND_LEAD_STAGES,
  isInboundLeadStage,
  isOpenInboundLeadStage,
  validateInboundLeadInput,
  isValidFollowUpDate,
  findOpenLeadForCustomer,
  mergeLeadUpdate,
  detectLeadSignal,
  todayLists,
  buildCustomerTimeline,
  computeInboundAnalytics,
  type InboundLeadInput,
  type InboundLeadRecord,
  type InboundAnalytics,
  type LeadSignalKind,
} from "./inbound-leads";

type Row = Record<string, unknown> & { id: string };

function asLead(row: Row): InboundLeadRecord {
  return {
    id: row.id,
    businessId: String(row.businessId ?? ""),
    name: String(row.name ?? ""),
    phone: String(row.phone ?? ""),
    interest: String(row.interest ?? ""),
    note: String(row.note ?? ""),
    followUpDate:
      typeof row.followUpDate === "string" ? row.followUpDate : null,
    source: row.source === "agent" ? "agent" : "manual",
    channel: String(row.channel ?? ""),
    conversationId:
      typeof row.conversationId === "string" ? row.conversationId : null,
    customerId: typeof row.customerId === "string" ? row.customerId : null,
    stage: isInboundLeadStage(row.stage)
      ? row.stage
      : "new",
    assignedToId:
      typeof row.assignedToId === "string" ? row.assignedToId : null,
    assignedToName: String(row.assignedToName ?? ""),
    createdAt: (row.createdAt as Date | string) ?? new Date(0),
    updatedAt: (row.updatedAt as Date | string) ?? new Date(0),
  };
}

function todayYmdUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Create a lead, or merge into the customer's existing OPEN lead.
 * Returns the lead, whether the call merged, and the detected signal
 * kinds (evidence of why the lead exists). Refuses (returns
 * `refused: "no_lead_signal"`) when the call carries no signal in the
 * customer's words AND no interest text AND no phone number — the agent
 * must not mint leads out of smalltalk.
 */
export async function createOrMergeInboundLead(input: {
  name?: string | null;
  phone?: string | null;
  interest?: string | null;
  note?: string | null;
  followUpDate?: string | null;
  source: "agent" | "manual";
  channel?: string | null;
  conversationId?: string | null;
  customerId?: string | null;
  /** The customer's own triggering words (agent path). */
  customerMessage?: string | null;
}): Promise<{
  lead: InboundLeadRecord | null;
  merged: boolean;
  signalKinds: LeadSignalKind[];
  refused?: "no_lead_signal";
}> {
  const clean = validateInboundLeadInput(input as InboundLeadInput);
  const detected = detectLeadSignal(input.customerMessage ?? "");
  const signalKinds: LeadSignalKind[] = [...detected.kinds];
  if (clean.phone && !signalKinds.includes("phone")) signalKinds.push("phone");
  if (
    signalKinds.length === 0 &&
    !clean.interest &&
    !clean.phone
  ) {
    return { lead: null, merged: false, signalKinds, refused: "no_lead_signal" };
  }

  // NOTE: the inbound model stores the pipeline stage in `stage` — the
  // outbound leads model uses `status`, and the two must not be confused.
  // The shim prefilters only businessId/id server-side; other wheres are
  // evaluated in memory by the data layer (documented shim behaviour).
  const openRows = (await prisma.inboundLead.findMany({
    where: { stage: { in: [...OPEN_INBOUND_LEAD_STAGES] } },
    orderBy: { createdAt: "desc" },
  })) as unknown as Row[];
  const openLeads = openRows
    .map(asLead)
    .filter((l) => isOpenInboundLeadStage(l.stage));
  const existing = findOpenLeadForCustomer(openLeads, {
    conversationId: clean.conversationId,
    customerId: clean.customerId,
    phone: clean.phone || null,
  });

  if (existing) {
    const merged = mergeLeadUpdate(
      existing,
      clean,
      todayYmdUtc(new Date()),
    );
    const updated = (await prisma.inboundLead.update({
      where: { id: existing.id },
      data: { ...merged, updatedAt: new Date() },
    })) as unknown as Row;
    return { lead: asLead(updated), merged: true, signalKinds };
  }

  const created = (await prisma.inboundLead.create({
    data: withBusinessId({
      name: clean.name,
      phone: clean.phone,
      interest: clean.interest,
      note: clean.note,
      followUpDate: clean.followUpDate,
      source: clean.source,
      channel: clean.channel,
      conversationId: clean.conversationId,
      customerId: clean.customerId,
      stage: "new",
      assignedToId: null,
      assignedToName: "",
    }),
  })) as unknown as Row;
  return { lead: asLead(created), merged: false, signalKinds };
}

export interface LeadListFilters {
  search?: string;
  stage?: string;
  assignedToId?: string;
  /** Open leads only (used by the Today view's counts). */
  openOnly?: boolean;
}

/**
 * List this tenant's inbound leads, newest first. Search matches name,
 * phone or interest (case-insensitive, in memory — the same precedent as
 * the outbound leads route's in-memory minScore filter and the data
 * layer's documented in-memory evaluation; fine for small-business lists,
 * flagged in the report as a scale follow-up, not hidden).
 */
export async function listInboundLeads(
  filters: LeadListFilters,
): Promise<InboundLeadRecord[]> {
  const rows = (await prisma.inboundLead.findMany({
    orderBy: { createdAt: "desc" },
  })) as unknown as Row[];
  let leads = rows.map(asLead);
  if (filters.openOnly) {
    leads = leads.filter((l) => isOpenInboundLeadStage(l.stage));
  }
  if (filters.stage && isInboundLeadStage(filters.stage)) {
    leads = leads.filter((l) => l.stage === filters.stage);
  }
  if (filters.assignedToId) {
    leads = leads.filter((l) => l.assignedToId === filters.assignedToId);
  }
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    leads = leads.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.phone.toLowerCase().includes(q) ||
        l.interest.toLowerCase().includes(q),
    );
  }
  return leads;
}

/** Today view: who to call today + who is already overdue. */
export async function todayInboundLeads(todayYmd: string) {
  const leads = await listInboundLeads({ openOnly: true });
  return todayLists(leads, todayYmd);
}

/** Move a lead to another pipeline stage. Terminal stages are allowed as
 *  targets (Won/Lost close the lead); a terminal lead is never reopened
 *  by this function — reopening needs a new lead (see dedupe rule). */
export async function updateInboundLeadStage(
  id: string,
  stage: string,
): Promise<InboundLeadRecord> {
  if (!isInboundLeadStage(stage)) {
    throw new Error(`Invalid stage: ${stage}`);
  }
  const existing = (await prisma.inboundLead.findUnique({
    where: { id },
  })) as unknown as Row | null;
  if (!existing) throw new Error("Lead not found.");
  if (
    (["won", "lost"] as readonly string[]).includes(
      String(existing.stage ?? ""),
    )
  ) {
    throw new Error("A Won/Lost lead cannot be reopened; create a new lead.");
  }
  const updated = (await prisma.inboundLead.update({
    where: { id },
    data: { stage, updatedAt: new Date() },
  })) as unknown as Row;
  return asLead(updated);
}

/**
 * Append a dated note line and/or change the follow-up date / interest /
 * name / phone on an OPEN lead. Notes append (history kept); the other
 * fields replace only when a non-empty value is given, except
 * followUpDate, where an explicit null clears the date.
 */
export async function updateInboundLeadDetails(
  id: string,
  patch: {
    note?: string;
    followUpDate?: string | null;
    interest?: string;
    name?: string;
    phone?: string;
  },
  todayYmd: string,
): Promise<InboundLeadRecord> {
  const existing = (await prisma.inboundLead.findUnique({
    where: { id },
  })) as unknown as Row | null;
  if (!existing) throw new Error("Lead not found.");
  const lead = asLead(existing);
  const data: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.note && patch.note.trim()) {
    const line = `[${todayYmd}] ${patch.note.trim().slice(0, 2000)}`;
    data.note = lead.note ? `${lead.note}\n${line}` : line;
    data.note = String(data.note).slice(0, 4000);
  }
  if (patch.followUpDate !== undefined) {
    if (
      patch.followUpDate !== null &&
      !isValidFollowUpDate(patch.followUpDate)
    ) {
      throw new Error("followUpDate must be a real date in YYYY-MM-DD form.");
    }
    data.followUpDate = patch.followUpDate;
  }
  if (patch.interest && patch.interest.trim()) {
    data.interest = patch.interest.trim().slice(0, 500);
  }
  if (patch.name && patch.name.trim()) {
    data.name = patch.name.trim().slice(0, 120);
  }
  if (patch.phone && patch.phone.trim()) {
    data.phone = patch.phone.trim().slice(0, 40);
  }
  const updated = (await prisma.inboundLead.update({
    where: { id },
    data,
  })) as unknown as Row;
  return asLead(updated);
}

/**
 * Assign (or unassign with null) a lead to a teammate. The member row is
 * read through the tenant-scoped client, so a cross-tenant member id
 * simply reads as not found — and the explicit businessId check below
 * fail-closes even if scoping ever changes.
 */
export async function assignInboundLead(
  id: string,
  memberId: string | null,
  businessId: string,
): Promise<InboundLeadRecord> {
  const existing = (await prisma.inboundLead.findUnique({
    where: { id },
  })) as unknown as Row | null;
  if (!existing) throw new Error("Lead not found.");
  let assignedToName = "";
  if (memberId) {
    const member = (await prisma.teamMember.findUnique({
      where: { id: memberId },
    })) as unknown as Row | null;
    if (!member || String(member.businessId ?? "") !== businessId) {
      throw new Error("Team member not found.");
    }
    assignedToName = String(member.name ?? "");
  }
  const updated = (await prisma.inboundLead.update({
    where: { id },
    data: {
      assignedToId: memberId,
      assignedToName,
      updatedAt: new Date(),
    },
  })) as unknown as Row;
  return asLead(updated);
}

// ---------------------------------------------------------------------------
// Customer timeline
// ---------------------------------------------------------------------------

/**
 * Build a customer's timeline from existing records only. Conversation
 * lookup mirrors the existing /api/customers/[id]/conversations route:
 * customerId match OR any contact-field match (email/phone/whatsapp).
 * Message fetch is capped at 2000 newest (timeline events are markers,
 * not a message dump — the full thread stays in the conversation view).
 */
export async function buildTimelineForCustomer(customerId: string) {
  const customer = (await prisma.customer.findUnique({
    where: { id: customerId },
  })) as unknown as Row | null;
  if (!customer) return null;

  const contactFilters: Record<string, unknown>[] = [{ customerId }];
  if (customer.email) {
    contactFilters.push({
      customerContact: { equals: customer.email, mode: "insensitive" },
    });
  }
  if (customer.phone) {
    contactFilters.push({ customerContact: customer.phone });
  }
  if (customer.whatsapp) {
    contactFilters.push({ customerContact: customer.whatsapp });
  }

  const conversations = (await prisma.conversation.findMany({
    where: { OR: contactFilters },
    orderBy: { updatedAt: "desc" },
    take: 100,
  })) as unknown as Row[];
  const convIds = conversations.map((c) => c.id);

  const [customerNotes, orders, messages, internalNotes, tickets] =
    await Promise.all([
      prisma.customerNote.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.order.findMany({
        where: {
          OR: [
            { customerId },
            ...(convIds.length > 0
              ? [{ conversationId: { in: convIds } }]
              : []),
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      convIds.length > 0
        ? prisma.message.findMany({
            where: { conversationId: { in: convIds } },
            orderBy: { createdAt: "desc" },
            take: 2000,
          })
        : Promise.resolve([]),
      convIds.length > 0
        ? prisma.internalNote.findMany({
            where: { conversationId: { in: convIds } },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      convIds.length > 0
        ? prisma.ticket.findMany({
            where: { conversationId: { in: convIds } },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
    ]);

  const events = buildCustomerTimeline({
    conversations: conversations.map((c) => ({
      id: c.id,
      channel: String(c.channel ?? ""),
      status: String(c.status ?? ""),
      satisfaction:
        typeof c.satisfaction === "number" ? c.satisfaction : null,
      metadata:
        c.metadata && typeof c.metadata === "object"
          ? (c.metadata as Record<string, unknown>)
          : null,
      createdAt: (c.createdAt as Date | string) ?? new Date(0),
      updatedAt: (c.updatedAt as Date | string) ?? new Date(0),
    })),
    messages: (messages as unknown as Row[]).map((m) => ({
      id: m.id,
      conversationId: String(m.conversationId ?? ""),
      role: String(m.role ?? ""),
      content: String(m.content ?? ""),
      createdAt: (m.createdAt as Date | string) ?? new Date(0),
    })),
    orders: (orders as unknown as Row[]).map((o) => ({
      id: o.id,
      conversationId:
        typeof o.conversationId === "string" ? o.conversationId : null,
      customerId: typeof o.customerId === "string" ? o.customerId : null,
      summary: String(o.summary ?? ""),
      status: String(o.status ?? ""),
      total: typeof o.total === "number" ? o.total : null,
      createdAt: (o.createdAt as Date | string) ?? new Date(0),
    })),
    notes: [
      ...(customerNotes as unknown as Row[]).map((n) => ({
        id: n.id,
        conversationId: null as string | null,
        customerId,
        content: String(n.content ?? ""),
        authorName: String(n.authorName ?? ""),
        createdAt: (n.createdAt as Date | string) ?? new Date(0),
      })),
      ...(internalNotes as unknown as Row[]).map((n) => ({
        id: n.id,
        conversationId: String(n.conversationId ?? ""),
        customerId: null as string | null,
        content: String(n.content ?? ""),
        authorName: String(n.authorName ?? ""),
        createdAt: (n.createdAt as Date | string) ?? new Date(0),
      })),
    ],
    tickets: (tickets as unknown as Row[]).map((t) => ({
      id: t.id,
      conversationId:
        typeof t.conversationId === "string" ? t.conversationId : null,
      createdAt: (t.createdAt as Date | string) ?? new Date(0),
    })),
  });

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      whatsapp: customer.whatsapp,
    },
    events,
  };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Compute the business's inbound analytics for a 7/14/30-day window.
 * Query shape mirrors the existing /api/analytics route (windowed
 * findMany calls, in-memory aggregation). The waiting-now check reuses
 * the conversations route's batched latest-message pattern (one
 * FK-prefiltered, server-limited query per waiting candidate, capped).
 */
export async function computeInboundAnalyticsForBusiness(
  windowDays: number,
): Promise<InboundAnalytics> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const start30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [conversations, messagesInWindow, tickets, internalNotes, leads] =
    await Promise.all([
      prisma.conversation.findMany({
        orderBy: { updatedAt: "desc" },
      }),
      prisma.message.findMany({
        where: { createdAt: { gte: windowStart } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.ticket.findMany({}),
      prisma.internalNote.findMany({
        where: { createdAt: { gte: start30d } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.inboundLead.findMany({
        orderBy: { createdAt: "desc" },
      }),
    ]);

  const convRows = conversations as unknown as Row[];
  const waitingCandidates = convRows.filter(
    (c) => c.status === "active" || c.status === "escalated",
  );
  const latestPerCandidate = await Promise.all(
    waitingCandidates.slice(0, 100).map(async (c) => {
      const rows = (await prisma.message.findMany({
        where: { conversationId: c.id },
        orderBy: { createdAt: "desc" },
        take: 1,
      })) as unknown as Row[];
      return rows[0]
        ? {
            conversationId: c.id,
            role: String(rows[0].role ?? ""),
            createdAt: (rows[0].createdAt as Date | string) ?? new Date(0),
          }
        : null;
    }),
  );

  return computeInboundAnalytics({
    conversations: convRows.map((c) => ({
      id: c.id,
      channel: String(c.channel ?? ""),
      customerName: String(c.customerName ?? ""),
      customerContact: String(c.customerContact ?? ""),
      customerId: typeof c.customerId === "string" ? c.customerId : null,
      status: String(c.status ?? ""),
      aiEnabled: c.aiEnabled !== false,
      metadata:
        c.metadata && typeof c.metadata === "object"
          ? (c.metadata as Record<string, unknown>)
          : null,
      createdAt: (c.createdAt as Date | string) ?? new Date(0),
      updatedAt: (c.updatedAt as Date | string) ?? new Date(0),
    })),
    messagesInWindow: (messagesInWindow as unknown as Row[]).map((m) => ({
      id: m.id,
      conversationId: String(m.conversationId ?? ""),
      role: String(m.role ?? ""),
      deliveryNote:
        typeof m.deliveryNote === "string" ? m.deliveryNote : null,
      createdAt: (m.createdAt as Date | string) ?? new Date(0),
    })),
    latestMessages: latestPerCandidate.filter(
      (x): x is NonNullable<typeof x> => x !== null,
    ),
    tickets: (tickets as unknown as Row[]).map((t) => ({
      id: t.id,
      conversationId:
        typeof t.conversationId === "string" ? t.conversationId : null,
      status: String(t.status ?? ""),
      createdAt: (t.createdAt as Date | string) ?? new Date(0),
    })),
    internalNotes: (internalNotes as unknown as Row[]).map((n) => ({
      id: n.id,
      conversationId:
        typeof n.conversationId === "string" ? n.conversationId : null,
      content: String(n.content ?? ""),
      createdAt: (n.createdAt as Date | string) ?? new Date(0),
    })),
    inboundLeads: (leads as unknown as Row[]).map(asLead),
    windowDays,
    now,
  });
}

export { INBOUND_LEAD_STAGES };
