/**
 * inbound-leads.ts — PURE module (no imports, no I/O, no dates from the
 * environment except via explicit arguments).
 *
 * INBOUND leads only. An inbound lead is a customer of THIS business who
 * showed real interest in buying or booking: they asked a product price,
 * they want to order/book, or they gave a phone number. This is NOT the
 * outbound Harvey Lead Engine: that system lives in the `leads`
 * collection (`new/contacted/replied/meeting/closed/lost`, written by the
 * sidecar) and is deliberately untouched here. Inbound leads live in their
 * own `inboundLeads` collection with their own stages, so the two
 * pipelines can never pollute each other.
 *
 * Lifecycle (hard rules, enforced by the store layer + this module):
 * - A lead is NEVER an order and NEVER a confirmation. The agent creates
 *   PENDING orders through take_order; a human team confirms; confirmed
 *   is LOCKED. A lead only records interest so the team can follow up.
 * - The agent NEVER quotes a fare. A price signal (the customer asking
 *   what something costs) may create a lead; it never authorises the
 *   agent to state a fare or delivery price.
 * - Dedupe: if an OPEN lead already exists for the customer, new
 *   information is merged into it — never a second open lead. If the
 *   customer's lead is Won/Lost (terminal), a returning customer gets a
 *   NEW lead.
 * - All display labels in STAGE_LABELS are PROPOSALS for owner approval
 *   (no invented copy is silently shipped); the stage KEYS are the
 *   machine contract.
 */

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** The 6-stage inbound pipeline, in order. */
export const INBOUND_LEAD_STAGES = [
  "new",
  "contacted",
  "interested",
  "quoted",
  "won",
  "lost",
] as const;
export type InboundLeadStage = (typeof INBOUND_LEAD_STAGES)[number];

/** Stages that still need follow-up. Dedupe merges into these only. */
export const OPEN_INBOUND_LEAD_STAGES: readonly InboundLeadStage[] = [
  "new",
  "contacted",
  "interested",
  "quoted",
];

/** Terminal stages: a returning customer gets a NEW lead, never a reopen. */
export const TERMINAL_INBOUND_LEAD_STAGES: readonly InboundLeadStage[] = [
  "won",
  "lost",
];

export function isInboundLeadStage(value: unknown): value is InboundLeadStage {
  return (
    typeof value === "string" &&
    (INBOUND_LEAD_STAGES as readonly string[]).includes(value)
  );
}

export function isOpenInboundLeadStage(stage: string): boolean {
  return (OPEN_INBOUND_LEAD_STAGES as readonly string[]).includes(stage);
}

/** Display labels — PROPOSAL wording, not approved copy. */
export const INBOUND_LEAD_STAGE_LABELS: Record<InboundLeadStage, string> = {
  new: "New",
  contacted: "Contacted",
  interested: "Interested",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost",
};

export type InboundLeadSource = "agent" | "manual";

export interface InboundLeadInput {
  name?: string | null;
  phone?: string | null;
  /** What the customer wants (product, service, booking). Free text. */
  interest?: string | null;
  note?: string | null;
  /** Follow-up date, YYYY-MM-DD, or null for "no date set". */
  followUpDate?: string | null;
  source: InboundLeadSource;
  channel?: string | null;
  conversationId?: string | null;
  customerId?: string | null;
}

export interface CleanInboundLeadInput {
  name: string;
  phone: string;
  interest: string;
  note: string;
  followUpDate: string | null;
  source: InboundLeadSource;
  channel: string;
  conversationId: string | null;
  customerId: string | null;
}

export interface InboundLeadRecord {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  interest: string;
  note: string;
  followUpDate: string | null;
  source: InboundLeadSource;
  channel: string;
  conversationId: string | null;
  customerId: string | null;
  stage: InboundLeadStage;
  assignedToId: string | null;
  assignedToName: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function isRealCalendarDate(ymd: string): boolean {
  if (!DATE_RE.test(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/** True when `ymd` is a real calendar date in YYYY-MM-DD form. */
export function isValidFollowUpDate(ymd: string): boolean {
  return isRealCalendarDate(ymd);
}

/**
 * Validate + clean a lead input. Throws with a plain message on bad input.
 * At least one of name / phone / interest must be present: a lead with
 * nothing identifying the customer or what they want is not a lead.
 * A follow-up date in the past is NOT rejected — the team may backfill.
 */
export function validateInboundLeadInput(
  input: InboundLeadInput,
): CleanInboundLeadInput {
  if (!input || typeof input !== "object") {
    throw new Error("Lead input is required.");
  }
  if (input.source !== "agent" && input.source !== "manual") {
    throw new Error("Lead source must be 'agent' or 'manual'.");
  }
  const name = cleanText(input.name, 120);
  const phone = cleanText(input.phone, 40);
  const interest = cleanText(input.interest, 500);
  const note = cleanText(input.note, 2000);
  const channel = cleanText(input.channel, 60);
  let followUpDate: string | null = null;
  if (input.followUpDate !== undefined && input.followUpDate !== null) {
    const raw = String(input.followUpDate).trim();
    if (raw !== "") {
      if (!isRealCalendarDate(raw)) {
        throw new Error("followUpDate must be a real date in YYYY-MM-DD form.");
      }
      followUpDate = raw;
    }
  }
  if (!name && !phone && !interest) {
    throw new Error(
      "A lead needs at least a name, a phone number, or what the customer wants.",
    );
  }
  return {
    name,
    phone,
    interest,
    note,
    followUpDate,
    source: input.source,
    channel,
    conversationId:
      typeof input.conversationId === "string" && input.conversationId.trim()
        ? input.conversationId.trim().slice(0, 200)
        : null,
    customerId:
      typeof input.customerId === "string" && input.customerId.trim()
        ? input.customerId.trim().slice(0, 200)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Customer matching / dedupe
// ---------------------------------------------------------------------------

/**
 * Matching key for a phone number. Digits only; Bangladeshi forms collapse:
 * "+8801711111111", "8801711111111", "01711111111" and "1711111111" all
 * key to "1711111111". This is a MATCHING key only — the stored phone
 * keeps the form it arrived in (the server layer may also store the
 * customer-resolver canonical form on the customer record; that record is
 * a different system and is not rewritten here).
 */
export function phoneMatchKey(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("880")) return digits.slice(3);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export interface LeadIdentity {
  conversationId?: string | null;
  customerId?: string | null;
  phone?: string | null;
}

/**
 * Find the OPEN lead for this customer, if any. Priority is deliberate:
 * same conversation first (the surest link), then the same customer
 * record, then the same phone number. Terminal (Won/Lost) leads are
 * never returned — a returning customer gets a new lead.
 */
export function findOpenLeadForCustomer<T extends InboundLeadRecord>(
  leads: readonly T[],
  identity: LeadIdentity,
): T | null {
  const phoneKey = identity.phone ? phoneMatchKey(identity.phone) : "";
  const open = leads.filter((l) => isOpenInboundLeadStage(l.stage));
  if (identity.conversationId) {
    const byConv = open.find((l) => l.conversationId === identity.conversationId);
    if (byConv) return byConv;
  }
  if (identity.customerId) {
    const byCustomer = open.find((l) => l.customerId === identity.customerId);
    if (byCustomer) return byCustomer;
  }
  if (phoneKey) {
    const byPhone = open.find(
      (l) => l.phone && phoneMatchKey(l.phone) === phoneKey,
    );
    if (byPhone) return byPhone;
  }
  return null;
}

/**
 * Merge new information into an existing OPEN lead. Rules, all deliberate:
 * - Empty fields are filled; filled fields are never blanked.
 * - A different interest is appended ("old; new"), never overwritten —
 *   the customer may now want two things.
 * - A note is appended as a new dated line (history is kept, not replaced).
 * - A provided follow-up date replaces the old one (latest intent wins).
 * - Stage, assignee and source are NEVER changed by a merge.
 * `todayYmd` is injected so tests are deterministic; callers pass the
 * current UTC date.
 */
export function mergeLeadUpdate(
  existing: InboundLeadRecord,
  incoming: CleanInboundLeadInput,
  todayYmd: string,
): {
  name: string;
  phone: string;
  interest: string;
  note: string;
  followUpDate: string | null;
  channel: string;
  conversationId: string | null;
  customerId: string | null;
} {
  let interest = existing.interest;
  if (incoming.interest) {
    if (!interest) interest = incoming.interest;
    else if (interest !== incoming.interest && !interest.includes(incoming.interest)) {
      interest = `${interest}; ${incoming.interest}`.slice(0, 500);
    }
  }
  let note = existing.note;
  if (incoming.note) {
    const line = `[${todayYmd}] ${incoming.note}`;
    note = note ? `${note}\n${line}` : line;
    note = note.slice(0, 4000);
  }
  return {
    name: existing.name || incoming.name,
    phone: existing.phone || incoming.phone,
    interest,
    note,
    followUpDate:
      incoming.followUpDate !== null ? incoming.followUpDate : existing.followUpDate,
    channel: existing.channel || incoming.channel,
    conversationId: existing.conversationId || incoming.conversationId,
    customerId: existing.customerId || incoming.customerId,
  };
}

// ---------------------------------------------------------------------------
// Lead-signal detection (why a lead was created)
// ---------------------------------------------------------------------------

export type LeadSignalKind = "price" | "order" | "phone";

const PRICE_WORDS_EN = [
  "price",
  "cost",
  "how much",
  "rate",
  "charge",
  "discount",
  "quote",
  "fare",
];
const PRICE_WORDS_BN = ["দাম", "খরচ", "কত", "ভাড়া", "ছাড়"];
const ORDER_WORDS_EN = [
  "order",
  "buy",
  "book",
  "booking",
  "purchase",
  "deliver",
  "i want",
  "need a",
];
const ORDER_WORDS_BN = ["অর্ডার", "কিনতে", "বুক", "চাই", "পাঠাতে"];

const BD_MOBILE_RE = /(?:\+?880|0)?1[3-9]\d{8}\b/;
const INTL_PHONE_RE = /\+\d{8,15}\b/;

/**
 * Detect, from the customer's own words, which lead trigger fired.
 * A price signal records INTEREST only — it never authorises quoting a
 * fare or delivery price (that doctrine lives in the agent's reply rules,
 * not in this detector). Returns no kinds for smalltalk/greetings, so the
 * tool layer can refuse to mint junk leads from an empty signal when the
 * call also carries no interest text and no phone number.
 */
export function detectLeadSignal(text: string): {
  signal: boolean;
  kinds: LeadSignalKind[];
} {
  const lower = (text || "").toLowerCase();
  const kinds: LeadSignalKind[] = [];
  if (
    PRICE_WORDS_EN.some((w) => lower.includes(w)) ||
    PRICE_WORDS_BN.some((w) => (text || "").includes(w))
  ) {
    kinds.push("price");
  }
  if (
    ORDER_WORDS_EN.some((w) => lower.includes(w)) ||
    ORDER_WORDS_BN.some((w) => (text || "").includes(w))
  ) {
    kinds.push("order");
  }
  if (BD_MOBILE_RE.test(text || "") || INTL_PHONE_RE.test(text || "")) {
    kinds.push("phone");
  }
  return { signal: kinds.length > 0, kinds };
}

// ---------------------------------------------------------------------------
// Today list
// ---------------------------------------------------------------------------

export interface TodayLists<T> {
  /** Open leads whose follow-up date is today, longest-waiting first. */
  today: T[];
  /** Open leads whose follow-up date already passed, earliest date first. */
  overdue: T[];
}

/**
 * Split OPEN leads into "call today" and "overdue". Dates are YYYY-MM-DD
 * strings, so plain string comparison is calendar comparison. "Today" is
 * the caller's UTC date — the repo has no tenant timezone setting (see
 * report), so the route documents UTC and accepts an explicit ?date=.
 */
export function todayLists<T extends InboundLeadRecord>(
  leads: readonly T[],
  todayYmd: string,
): TodayLists<T> {
  const open = leads.filter((l) => isOpenInboundLeadStage(l.stage));
  const today = open
    .filter((l) => l.followUpDate === todayYmd)
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const overdue = open
    .filter((l) => l.followUpDate !== null && l.followUpDate < todayYmd)
    .sort((a, b) =>
      (a.followUpDate as string) < (b.followUpDate as string)
        ? -1
        : (a.followUpDate as string) > (b.followUpDate as string)
          ? 1
          : toMs(a.createdAt) - toMs(b.createdAt),
    );
  return { today, overdue };
}

// ---------------------------------------------------------------------------
// CSV download (mirrors the repo's /api/export escaping)
// ---------------------------------------------------------------------------

function escapeCSV(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toInboundLeadsCSV(leads: readonly InboundLeadRecord[]): string {
  const headers = [
    "ID",
    "Name",
    "Phone",
    "Interest",
    "Stage",
    "Source",
    "Channel",
    "Assigned To",
    "Follow-up Date",
    "Created At",
    "Updated At",
    "Note",
  ];
  const rows = leads.map((l) => [
    l.id,
    l.name,
    l.phone,
    l.interest,
    l.stage,
    l.source,
    l.channel,
    l.assignedToName,
    l.followUpDate ?? "",
    new Date(l.createdAt).toISOString(),
    new Date(l.updatedAt).toISOString(),
    l.note,
  ]);
  return [headers, ...rows]
    .map((row) => row.map(escapeCSV).join(","))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Timeline (per customer — built ONLY from sources the repo already has)
// ---------------------------------------------------------------------------

export type TimelineEventType =
  | "conversation_started"
  | "order"
  | "rating"
  | "note"
  | "handoff"
  | "photo"
  | "voice_marker";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  date: string;
  /** Human title. PROPOSAL wording (owner approval before ship). */
  title: string;
  detail: string;
  conversationId: string | null;
  /** True when the date is approximate (see handoff rule below). */
  dateApproximate?: boolean;
}

interface TimelineConversation {
  id: string;
  channel: string;
  status: string;
  satisfaction: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface TimelineMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date | string;
}

interface TimelineOrder {
  id: string;
  conversationId: string | null;
  customerId: string | null;
  summary: string;
  status: string;
  total: number | null;
  createdAt: Date | string;
}

interface TimelineNote {
  id: string;
  conversationId: string | null;
  customerId: string | null;
  content: string;
  authorName: string;
  createdAt: Date | string;
}

interface TimelineTicket {
  id: string;
  conversationId: string | null;
  createdAt: Date | string;
}

export function toMs(value: Date | string): number {
  return new Date(value).getTime();
}

function excerpt(text: string, max: number): string {
  const t = (text || "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Handoff reason bucket. The engine writes conversation.metadata as
 * `handoff: true, handoffReason: "<kind>:<matched>"` with kind in
 * explicit_human | ticket_request | serious_problem (behaviour.ts). Any
 * other value is "unknown" — never guessed.
 */
export function classifyHandoffReason(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || metadata.handoff !== true) return null;
  const raw = metadata.handoffReason;
  if (typeof raw !== "string" || !raw) return "unknown";
  const kind = raw.split(":")[0];
  if (
    kind === "explicit_human" ||
    kind === "ticket_request" ||
    kind === "serious_problem"
  ) {
    return kind;
  }
  return "unknown";
}

/**
 * Assemble a customer's timeline from existing records only.
 *
 * INCLUDED (all evidenced in HEAD):
 * - conversation starts (channel + first customer message excerpt)
 * - orders (status + summary + total as a bare number; no currency is
 *   invented — currency lives per catalog product, not per order)
 * - ratings (conversation.satisfaction, 1–5)
 * - notes: customer notes + internal (conversation) notes, including
 *   transfer notes ("Conversation transferred …")
 * - handoffs: from conversation.metadata.handoffReason. Date = the
 *   earliest ticket on that conversation when one exists, else the
 *   conversation's updatedAt flagged dateApproximate (the metadata
 *   itself carries no timestamp — the report states this plainly).
 * - photos/videos sent: customer messages whose content is exactly
 *   "(sent a photo)" / "(sent a video)" (vision route markers). The
 *   image bytes are NOT stored anywhere in the repo, so the event has
 *   no image — it says so in its detail.
 * - voice markers: "(sent a voice message)" / transcription-failed
 *   markers (voice route). A successful transcript is fed into chat as
 *   ordinary customer text with NO voice-origin flag anywhere in the
 *   repo, so transcript text is NOT labelled as voice here.
 *
 * NOT INCLUDED (gaps, not invented — see report):
 * - "cards viewed": show_products results are never persisted as a
 *   record (tool_calls live only in the provider response, not on the
 *   stored message), so no card-view event exists to show.
 */
export function buildCustomerTimeline(input: {
  conversations: readonly TimelineConversation[];
  messages: readonly TimelineMessage[];
  orders: readonly TimelineOrder[];
  notes: readonly TimelineNote[];
  tickets: readonly TimelineTicket[];
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const firstCustomerByConv = new Map<string, TimelineMessage>();
  for (const m of input.messages) {
    if (m.role !== "customer") continue;
    const prev = firstCustomerByConv.get(m.conversationId);
    if (!prev || toMs(m.createdAt) < toMs(prev.createdAt)) {
      firstCustomerByConv.set(m.conversationId, m);
    }
  }
  const ticketsByConv = new Map<string, TimelineTicket[]>();
  for (const t of input.tickets) {
    if (!t.conversationId) continue;
    const list = ticketsByConv.get(t.conversationId) ?? [];
    list.push(t);
    ticketsByConv.set(t.conversationId, list);
  }

  for (const c of input.conversations) {
    const first = firstCustomerByConv.get(c.id);
    events.push({
      id: `conv-${c.id}`,
      type: "conversation_started",
      date: new Date(c.createdAt).toISOString(),
      title: `Conversation started (${c.channel})`,
      detail: first ? excerpt(first.content, 200) : "",
      conversationId: c.id,
    });
    if (c.satisfaction !== null && c.satisfaction !== undefined) {
      events.push({
        id: `rating-${c.id}`,
        type: "rating",
        date: new Date(c.updatedAt).toISOString(),
        title: `Rated ${c.satisfaction}/5`,
        detail: "Customer satisfaction rating on this conversation.",
        conversationId: c.id,
      });
    }
    const reason = classifyHandoffReason(c.metadata);
    if (reason !== null) {
      const convTickets = (ticketsByConv.get(c.id) ?? []).sort(
        (a, b) => toMs(a.createdAt) - toMs(b.createdAt),
      );
      const ticket = convTickets[0];
      events.push({
        id: `handoff-${c.id}`,
        type: "handoff",
        date: new Date(
          ticket ? ticket.createdAt : c.updatedAt,
        ).toISOString(),
        title: `Handed off to the team (${reason})`,
        detail: ticket
          ? "Handoff recorded with a support ticket."
          : "Handoff date is approximate: the handoff record carries no timestamp, so the conversation's last update is shown.",
        conversationId: c.id,
        dateApproximate: ticket ? false : true,
      });
    }
  }

  for (const o of input.orders) {
    events.push({
      id: `order-${o.id}`,
      type: "order",
      date: new Date(o.createdAt).toISOString(),
      title: `Order ${o.status}`,
      detail: o.summary || "",
      conversationId: o.conversationId,
    });
  }

  for (const n of input.notes) {
    events.push({
      id: `note-${n.id}`,
      type: "note",
      date: new Date(n.createdAt).toISOString(),
      title: `Note by ${n.authorName || "Team"}`,
      detail: n.content,
      conversationId: n.conversationId,
    });
  }

  for (const m of input.messages) {
    if (m.role !== "customer") continue;
    if (m.content === "(sent a photo)" || m.content === "(sent a video)") {
      const isVideo = m.content === "(sent a video)";
      events.push({
        id: `media-${m.id}`,
        type: "photo",
        date: new Date(m.createdAt).toISOString(),
        title: isVideo ? "Video sent" : "Photo sent",
        detail: "The image/video itself is not stored by the platform.",
        conversationId: m.conversationId,
      });
    } else if (
      m.content === "(sent a voice message)" ||
      m.content === "(sent a voice message — transcription failed)"
    ) {
      events.push({
        id: `voice-${m.id}`,
        type: "voice_marker",
        date: new Date(m.createdAt).toISOString(),
        title: "Voice message sent",
        detail:
          m.content ===
          "(sent a voice message — transcription failed)"
            ? "Transcription failed; no transcript text exists."
            : "Voice note marker (transcript, when made, is stored as ordinary chat text).",
        conversationId: m.conversationId,
      });
    }
  }

  events.sort((a, b) => {
    const d = new Date(b.date).getTime() - new Date(a.date).getTime();
    return d !== 0 ? d : 0;
  });
  return events;
}

// ---------------------------------------------------------------------------
// Analytics (the business's OWN record counts — never platform reach or
// follower counts; nothing here reads social audience data)
// ---------------------------------------------------------------------------

export interface AnalyticsMessage {
  id: string;
  conversationId: string;
  role: string;
  /** Team replies carry a deliveryNote; AI replies never do (see report). */
  deliveryNote?: string | null;
  createdAt: Date | string;
  content?: string;
}

export interface AnalyticsConversation {
  id: string;
  channel: string;
  customerName: string;
  customerContact: string;
  customerId: string | null;
  status: string;
  aiEnabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AnalyticsTicket {
  id: string;
  conversationId: string | null;
  status: string;
  createdAt: Date | string;
}

export interface AnalyticsInternalNote {
  id: string;
  conversationId: string | null;
  content: string;
  createdAt: Date | string;
}

export interface AnalyticsLatestMessage {
  conversationId: string;
  role: string;
  createdAt: Date | string;
}

export interface InboundAnalytics {
  windowDays: number;
  windowStart: string;
  /** All messages in the window (every role). */
  messagesHandled: number;
  /** Assistant-role messages WITHOUT a deliveryNote = AI replies. */
  repliesByAi: number;
  /** Assistant-role messages WITH a deliveryNote = team replies (heuristic, documented). */
  repliesByTeam: number;
  /** Distinct customers (customerId, else contact) in window conversations. */
  customers: number;
  /** Resolved/closed in window with no team reply, ticket or handoff. */
  conversationsFinishedAloneByAi: number;
  /** Escalated, AI-paused, handoff-recorded or open-ticket in window. */
  conversationsNeedingHuman: number;
  firstReplyMinutes: { avg: number; median: number; counted: number };
  /** Customer-message counts per UTC hour (0–23). */
  busiestHours: { hour: number; count: number }[];
  busiestTopHours: number[];
  channelSplit: { channel: string; count: number }[];
  chatsWaitingNow: {
    count: number;
    rows: {
      conversationId: string;
      channel: string;
      customerName: string;
      lastCustomerMessageAt: string;
    }[];
  };
  leadCounts: {
    totalInWindow: number;
    openNow: number;
    byStageInWindow: Record<string, number>;
    byAssigneeOpen: Record<string, number>;
    byAssigneeInWindow: Record<string, number>;
  };
  /** Fixed 30-day window, regardless of windowDays (per the brief). */
  handoffReasons30d: Record<string, number>;
}

/**
 * "Team reply" heuristic — read this before trusting repliesByTeam:
 * at HEAD, dashboard team replies are stored as role "assistant" (the
 * messages route only accepts customer/assistant/system and defaults
 * anything else to assistant), exactly like AI replies. The ONE
 * distinguishing mark is deliveryNote, which the messages route sets on
 * team replies and the engine never sets on AI replies. A team reply
 * whose delivery attempt wrote no note would be miscounted as AI; the
 * report flags a durable fix (a real sender/origin field on messages)
 * as follow-up work, not silently assumed.
 */
export function isTeamReplyMessage(m: AnalyticsMessage): boolean {
  return (
    m.role === "assistant" &&
    typeof m.deliveryNote === "string" &&
    m.deliveryNote.length > 0
  );
}

function avg1(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function median1(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med =
    sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(med * 10) / 10;
}

export function computeInboundAnalytics(input: {
  conversations: readonly AnalyticsConversation[];
  /** Messages inside the window (for replies / first-reply / busiest). */
  messagesInWindow: readonly AnalyticsMessage[];
  /** Latest message per active/escalated conversation (for waiting). */
  latestMessages: readonly AnalyticsLatestMessage[];
  tickets: readonly AnalyticsTicket[];
  internalNotes: readonly AnalyticsInternalNote[];
  inboundLeads: readonly InboundLeadRecord[];
  windowDays: number;
  now: Date;
}): InboundAnalytics {
  const nowMs = input.now.getTime();
  const windowStartMs = nowMs - input.windowDays * 24 * 60 * 60 * 1000;
  const start30dMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const windowStart = new Date(windowStartMs).toISOString();

  const convsInWindow = input.conversations.filter(
    (c) => toMs(c.updatedAt) >= windowStartMs || toMs(c.createdAt) >= windowStartMs,
  );
  const convIdsInWindow = new Set(convsInWindow.map((c) => c.id));

  const messagesHandled = input.messagesInWindow.length;
  let repliesByAi = 0;
  let repliesByTeam = 0;
  for (const m of input.messagesInWindow) {
    if (m.role !== "assistant") continue;
    if (isTeamReplyMessage(m)) repliesByTeam++;
    else repliesByAi++;
  }

  const customerKeys = new Set<string>();
  for (const c of input.conversations) {
    if (toMs(c.createdAt) < windowStartMs) continue;
    customerKeys.add(c.customerId || c.customerContact || c.id);
  }

  // First reply: first customer message -> first later assistant message.
  const byConv = new Map<string, AnalyticsMessage[]>();
  for (const m of input.messagesInWindow) {
    const list = byConv.get(m.conversationId) ?? [];
    list.push(m);
    byConv.set(m.conversationId, list);
  }
  const firstReplyDiffs: number[] = [];
  for (const list of byConv.values()) {
    const sorted = [...list].sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
    const firstCustomer = sorted.find((m) => m.role === "customer");
    if (!firstCustomer) continue;
    const firstReply = sorted.find(
      (m) => m.role === "assistant" && toMs(m.createdAt) > toMs(firstCustomer.createdAt),
    );
    if (!firstReply) continue;
    const diffMin =
      (toMs(firstReply.createdAt) - toMs(firstCustomer.createdAt)) / 60000;
    if (diffMin >= 0) firstReplyDiffs.push(diffMin);
  }

  // Busiest times: UTC hour histogram of customer messages in the window.
  // UTC is documented, not hidden: the repo has no tenant timezone setting.
  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const m of input.messagesInWindow) {
    if (m.role !== "customer") continue;
    hourCounts[new Date(m.createdAt).getUTCHours()].count++;
  }
  const busiestTopHours = [...hourCounts]
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .filter((h) => h.count > 0)
    .slice(0, 3)
    .map((h) => h.hour);

  const channelCounts = new Map<string, number>();
  for (const c of input.conversations) {
    if (toMs(c.createdAt) < windowStartMs) continue;
    channelCounts.set(c.channel, (channelCounts.get(c.channel) ?? 0) + 1);
  }
  const channelSplit = [...channelCounts.entries()]
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);

  // Waiting now: active/escalated conversations whose LATEST message is
  // from the customer (current state, not windowed).
  const latestByConv = new Map<string, AnalyticsLatestMessage>();
  for (const lm of input.latestMessages) latestByConv.set(lm.conversationId, lm);
  const waitingRows: InboundAnalytics["chatsWaitingNow"]["rows"] = [];
  for (const c of input.conversations) {
    if (c.status !== "active" && c.status !== "escalated") continue;
    const latest = latestByConv.get(c.id);
    if (!latest || latest.role !== "customer") continue;
    waitingRows.push({
      conversationId: c.id,
      channel: c.channel,
      customerName: c.customerName,
      lastCustomerMessageAt: new Date(latest.createdAt).toISOString(),
    });
  }
  waitingRows.sort((a, b) =>
    b.lastCustomerMessageAt.localeCompare(a.lastCustomerMessageAt),
  );

  // Finished alone / needing a human (window-scoped by updatedAt).
  const teamReplyConvs = new Set<string>();
  for (const m of input.messagesInWindow) {
    if (isTeamReplyMessage(m)) teamReplyConvs.add(m.conversationId);
  }
  const ticketConvs = new Set<string>();
  const openTicketConvs = new Set<string>();
  for (const t of input.tickets) {
    if (!t.conversationId) continue;
    ticketConvs.add(t.conversationId);
    if (t.status === "open" || t.status === "in_progress") {
      openTicketConvs.add(t.conversationId);
    }
  }
  let finishedAlone = 0;
  let needingHuman = 0;
  for (const c of convsInWindow) {
    const hasHandoff = classifyHandoffReason(c.metadata) !== null;
    const needsHuman =
      c.status === "escalated" ||
      c.aiEnabled === false ||
      hasHandoff ||
      openTicketConvs.has(c.id);
    if (needsHuman) needingHuman++;
    const isFinishedAlone =
      (c.status === "resolved" || c.status === "closed") &&
      !teamReplyConvs.has(c.id) &&
      !ticketConvs.has(c.id) &&
      !hasHandoff &&
      c.aiEnabled !== false;
    if (isFinishedAlone) finishedAlone++;
  }

  // Leads.
  const leadsInWindow = input.inboundLeads.filter(
    (l) => toMs(l.createdAt) >= windowStartMs,
  );
  const byStageInWindow: Record<string, number> = {};
  const byAssigneeInWindow: Record<string, number> = {};
  for (const l of leadsInWindow) {
    byStageInWindow[l.stage] = (byStageInWindow[l.stage] ?? 0) + 1;
    const key = l.assignedToName || "Unassigned";
    byAssigneeInWindow[key] = (byAssigneeInWindow[key] ?? 0) + 1;
  }
  const byAssigneeOpen: Record<string, number> = {};
  let openNow = 0;
  for (const l of input.inboundLeads) {
    if (!isOpenInboundLeadStage(l.stage)) continue;
    openNow++;
    const key = l.assignedToName || "Unassigned";
    byAssigneeOpen[key] = (byAssigneeOpen[key] ?? 0) + 1;
  }

  // Handoff reasons, fixed last-30-days, one bucket per conversation:
  // metadata kind wins; else a transfer note; else escalated-without-
  // reason counts as unknown. Transfer notes are matched by their
  // transferConversation() prefix — the only timestamped transfer record.
  const transferConvs = new Set<string>();
  for (const n of input.internalNotes) {
    if (
      n.conversationId &&
      toMs(n.createdAt) >= start30dMs &&
      n.content.startsWith("Conversation transferred")
    ) {
      transferConvs.add(n.conversationId);
    }
  }
  const handoffReasons30d: Record<string, number> = {};
  const bump = (k: string) => {
    handoffReasons30d[k] = (handoffReasons30d[k] ?? 0) + 1;
  };
  for (const c of input.conversations) {
    if (toMs(c.updatedAt) < start30dMs) continue;
    const reason = classifyHandoffReason(c.metadata);
    if (reason !== null) bump(reason);
    else if (transferConvs.has(c.id)) bump("transfer");
    else if (c.status === "escalated") bump("unknown");
  }

  return {
    windowDays: input.windowDays,
    windowStart,
    messagesHandled,
    repliesByAi,
    repliesByTeam,
    customers: customerKeys.size,
    conversationsFinishedAloneByAi: finishedAlone,
    conversationsNeedingHuman: needingHuman,
    firstReplyMinutes: {
      avg: avg1(firstReplyDiffs),
      median: median1(firstReplyDiffs),
      counted: firstReplyDiffs.length,
    },
    busiestHours: hourCounts,
    busiestTopHours,
    channelSplit,
    chatsWaitingNow: { count: waitingRows.length, rows: waitingRows.slice(0, 50) },
    leadCounts: {
      totalInWindow: leadsInWindow.length,
      openNow,
      byStageInWindow,
      byAssigneeOpen,
      byAssigneeInWindow,
    },
    handoffReasons30d,
  };
}

// ---------------------------------------------------------------------------
// Role gating (owner sees all; teammates only what their role allows)
// ---------------------------------------------------------------------------

export type AnalyticsGateRole =
  | "super_admin"
  | "admin"
  | "supervisor"
  | "agent"
  | "viewer"
  | string;

/**
 * Gate an analytics payload by dashboard role.
 * - admin / super_admin ("owner"): everything, unchanged.
 * - supervisor: everything except waiting-chat customer names (ids,
 *   channel and timestamps stay — enough to work the queue, not enough
 *   to browse customers from the analytics screen).
 * - agent: business totals for non-identifying metrics + ONLY their own
 *   lead counts (matched by assignedToName === agentName — the repo has
 *   no dashboard-user ↔ team-member link, so name match is the honest
 *   best available; see report). Waiting chats: count only, no rows.
 *   Per-assignee maps are removed (they would leak teammates' loads).
 * - viewer (and anything unknown): totals only — no waiting rows, no
 *   per-assignee maps, no own-lead section.
 */
export function gateAnalyticsForRole(
  role: AnalyticsGateRole,
  agentName: string,
  full: InboundAnalytics,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    windowDays: full.windowDays,
    windowStart: full.windowStart,
    messagesHandled: full.messagesHandled,
    repliesByAi: full.repliesByAi,
    repliesByTeam: full.repliesByTeam,
    customers: full.customers,
    conversationsFinishedAloneByAi: full.conversationsFinishedAloneByAi,
    conversationsNeedingHuman: full.conversationsNeedingHuman,
    firstReplyMinutes: full.firstReplyMinutes,
    busiestHours: full.busiestHours,
    busiestTopHours: full.busiestTopHours,
    channelSplit: full.channelSplit,
    handoffReasons30d: full.handoffReasons30d,
  };
  if (role === "admin" || role === "super_admin") {
    return {
      ...base,
      chatsWaitingNow: full.chatsWaitingNow,
      leadCounts: full.leadCounts,
    };
  }
  if (role === "supervisor") {
    return {
      ...base,
      chatsWaitingNow: {
        count: full.chatsWaitingNow.count,
        rows: full.chatsWaitingNow.rows.map((r) => ({
          conversationId: r.conversationId,
          channel: r.channel,
          lastCustomerMessageAt: r.lastCustomerMessageAt,
        })),
      },
      leadCounts: full.leadCounts,
    };
  }
  if (role === "agent") {
    return {
      ...base,
      chatsWaitingNow: { count: full.chatsWaitingNow.count, rows: [] },
      ownLeadCounts: {
        openNow: full.leadCounts.byAssigneeOpen[agentName] ?? 0,
        createdInWindow: full.leadCounts.byAssigneeInWindow[agentName] ?? 0,
      },
    };
  }
  return {
    ...base,
    chatsWaitingNow: { count: full.chatsWaitingNow.count, rows: [] },
  };
}
