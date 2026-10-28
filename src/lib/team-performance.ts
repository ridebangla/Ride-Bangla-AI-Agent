/**
 * LEG K — Per-member team performance (STAGED ONLY, Presswayy-video round 2).
 *
 * Computes, per roster member, exactly four stats — messages sent,
 * conversations, median response time, orders touched — plus one
 * explicitly-labelled unattributed team bucket. NOTHING ELSE: there is
 * no fifth stat column here, and no stat in this file is derived from
 * any owner-excluded record type.
 *
 * ------------------------------------------------------------------
 * ATTRIBUTION HONESTY — READ BEFORE TRUSTING ANY NUMBER IN HERE
 * ------------------------------------------------------------------
 * At HEAD (706df0fd), a dashboard team reply is stored as role
 * "assistant" — the messages route only accepts customer/assistant/
 * system and defaults anything else to "assistant" — exactly like an
 * AI reply. The ONE distinguishing mark is `deliveryNote`, which the
 * messages route sets on team replies and the engine never sets on AI
 * replies (verified by booking-batch Leg H; re-verified for this
 * leg from the HEAD messages route). A team reply whose delivery
 * attempt wrote no note is therefore miscounted as AI here. That is
 * a HEURISTIC, and every consumer of this module must label it so.
 *
 * Worse, at HEAD no message carries a sender id or sender name at
 * all. So NO message can be recorded as "sent by member X". The
 * per-member message/response figures below are therefore computed
 * ONLY over conversations with a single recorded member link (see
 * "sole link" below) and are labelled
 * `sole_link_conversation_heuristic` — the message is certainly a
 * team message (deliveryNote heuristic), the member link is via the
 * conversation, NOT via a recorded sender. Messages in conversations
 * with no single link are NOT split across members and NOT guessed:
 * they go, whole, into `unattributedTeam`.
 *
 * Recorded member links (the only links this module trusts):
 *   (a) Ticket assignment: ticket.assignedToId == member.id AND
 *       ticket.conversationId == conversation.id. Recorded at HEAD.
 *   (b) Takeover holder: conversation.takenOverBy / takenOverByName.
 *       NOT present at HEAD — these fields exist only in Presswayy
 *       Leg D's STAGED takeover diff. This module reads them when
 *       present and ignores them when absent; it never assumes Leg D
 *       has landed. Takeover holder wins over ticket assignee when
 *       both exist, because the holder is the person currently
 *       working the conversation.
 *
 * FOLLOW-UP WORK (flagged, not silently fixed here): a durable
 * origin field on messages (sender id/name, set by the messages
 * route from the authenticated staff user) plus a dashboard-user
 * ↔ TeamMember link. Until those exist, per-person message figures
 * stay heuristic-by-conversation-link and the unattributed bucket
 * stays real. Never present these figures as exact per-person
 * counts.
 *
 * OTHER HONEST LIMITS:
 * - Roster = TeamMember rows (the /team roster). Inbox senders are
 *   dashboard Admin users; no Admin ↔ TeamMember link exists at
 *   HEAD, so a sender who is not on the TeamMember roster can only
 *   ever appear inside `unattributedTeam`, never as a named row.
 * - Orders are COUNTS ONLY. `total` is never read, so no money
 *   figure can leak through this module. An order counts as
 *   "touched" for a member when its conversationId is one of that
 *   member's linked conversations. Hand-entered orders with no
 *   conversationId count for nobody — they are not assigned by
 *   guesswork. Orders in a conversation linked to several members
 *   count for EACH linked member (conversations/orders rows are
 *   therefore NOT additive across members); messages and median
 *   response time ARE an exact partition (sole-link rows +
 *   unattributed bucket = every team reply / every team pair).
 * - Response time: for each customer message, the first LATER team
 *   reply in the same conversation; the reply is then consumed, so
 *   a burst of customer messages answered by one reply yields one
 *   pair (the earliest waiting customer). Pairs are formed only
 *   inside the supplied (windowed) messages. A reply to a
 *   pre-window customer message therefore has no pair here — a
 *   conservative under-count, never an invented time.
 * - Median: even count = mean of the two middle values, rounded to
 *   1 decimal (same rule as Leg H analytics). No pairs → null,
 *   NEVER 0 (0 would fake an instant reply).
 * - Times are windowed by the caller. This module additionally
 *   drops messages/orders older than windowStart defensively.
 * - No quota, limit, or metering logic lives here: this is a
 *   read-only aggregation. It does not change the limit model
 *   (company unlimited; trial no usage quotas; free tier
 *   ~100 messages/month) in any direction.
 */

export interface TeamPerfMember {
  id: string;
  name: string;
  departmentName?: string | null;
}

export interface TeamPerfMessage {
  id: string;
  conversationId: string;
  role: string;
  deliveryNote?: string | null;
  createdAt: Date | string | number;
}

export interface TeamPerfConversation {
  id: string;
  /** STAGED Leg D field only — absent at HEAD. */
  takenOverBy?: string | null;
  /** STAGED Leg D field only — absent at HEAD. */
  takenOverByName?: string | null;
}

export interface TeamPerfTicket {
  conversationId: string | null;
  assignedToId: string | null;
}

export interface TeamPerfOrder {
  id: string;
  conversationId: string | null;
  createdAt: Date | string | number;
}

export type TeamAttributionLabel =
  | "recorded_link"
  | "sole_link_conversation_heuristic"
  | "heuristic_team_bucket"
  | "none_recorded";

export interface TeamPerfMemberStat {
  memberId: string;
  memberName: string;
  departmentName: string | null;
  /** Team replies in this member's sole-link conversations. */
  messagesSent: number;
  /** Distinct conversations linked by ticket assignment or takeover. */
  conversationsLinked: number;
  /** Median minutes, customer message -> first later team reply. Null = no pairs. */
  medianResponseMinutes: number | null;
  /** Orders (count only) whose conversation is linked to this member. */
  ordersTouched: number;
  /** Distinct sole-link conversations behind messagesSent/median. */
  soleLinkConversations: number;
  attribution: {
    messages: TeamAttributionLabel;
    conversations: TeamAttributionLabel;
    medianResponse: TeamAttributionLabel;
    orders: TeamAttributionLabel;
  };
}

export interface TeamPerfBucketStat {
  /** Team replies in conversations with no sole member link. */
  messagesSent: number;
  /** Conversations with >= 1 team reply and no sole member link. */
  conversations: number;
  /** Median minutes over all unattributed team pairs. Null = no pairs. */
  medianResponseMinutes: number | null;
  /** Orders (count only) in conversations with no member link at all. */
  ordersTouched: number;
  attribution: {
    messages: TeamAttributionLabel;
    conversations: TeamAttributionLabel;
    medianResponse: TeamAttributionLabel;
    orders: TeamAttributionLabel;
  };
}

export interface TeamPerformanceResult {
  windowStart: string;
  /** One row per roster member, including members with zero activity. */
  members: TeamPerfMemberStat[];
  /** Team work that cannot be attributed to a named member. NOT a member. */
  unattributedTeam: TeamPerfBucketStat;
  /** Every team reply in the window (sole-link rows + bucket). Partition check. */
  teamRepliesTotal: number;
  /** How team replies were identified. Consumers must surface this. */
  attributionNote: string;
}

export const TEAM_ATTRIBUTION_NOTE =
  "Team replies are identified by a delivery-note heuristic (assistant " +
  "messages with a non-empty deliveryNote, or role admin where present); " +
  "AI replies carry no deliveryNote. Per-member message and response " +
  "figures cover sole-link conversations only — no message at HEAD " +
  "records its sender, so work in shared or unlinked conversations " +
  "stays in the unattributed bucket and is never split by guesswork.";

/** Team reply heuristic (Leg H verified): deliveryNote, or role admin. */
export function isTeamReplyMessage(m: TeamPerfMessage): boolean {
  if (m.role === "admin") return true;
  if (m.role !== "assistant") return false;
  return typeof m.deliveryNote === "string" && m.deliveryNote.length > 0;
}

function toMs(v: Date | string | number): number {
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

function median1(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med =
    sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(med * 10) / 10;
}

/**
 * Response pairs for one conversation's messages (already filtered to
 * team/customer roles by the caller of this helper via isTeamReplyMessage
 * + role === "customer"). Earliest waiting customer pairs with the next
 * team reply; that reply is then consumed.
 */
function responseMinutesForConversation(
  sorted: { role: string; isTeam: boolean; ms: number }[],
): number[] {
  const diffs: number[] = [];
  const waiting: number[] = [];
  for (const m of sorted) {
    if (m.role === "customer") {
      waiting.push(m.ms);
    } else if (m.isTeam && waiting.length > 0) {
      const customerMs = waiting.shift() as number;
      const diffMin = (m.ms - customerMs) / 60000;
      if (diffMin >= 0) diffs.push(Math.round(diffMin * 10) / 10);
    }
  }
  return diffs;
}

/**
 * Role gate for the team-performance payload. The route enforces this
 * through the EXISTING permission `activity:read` (supervisor + admin
 * at HEAD, plus super_admin via hasPermission); this pure function is
 * the same rule for tests and for defence-in-depth. No new role is
 * invented: agent / viewer / unknown callers are denied the per-member
 * payload outright, because the payload IS the per-member data — a
 * totals-only fallback would be Leg H analytics, not this feature,
 * and a name-match self-view would be a guess without a
 * dashboard-user ↔ TeamMember link (see follow-up in the header).
 */
export function gateTeamPerformanceForRole(
  role: string,
): "full" | "denied" {
  if (role === "supervisor" || role === "admin" || role === "super_admin")
    return "full";
  return "denied";
}

export function computeTeamPerformance(input: {
  members: readonly TeamPerfMember[];
  messages: readonly TeamPerfMessage[];
  conversations: readonly TeamPerfConversation[];
  tickets: readonly TeamPerfTicket[];
  orders: readonly TeamPerfOrder[];
  windowStart: Date | string | number;
}): TeamPerformanceResult {
  const windowStartMs = toMs(input.windowStart);
  const windowStart = Number.isNaN(windowStartMs)
    ? new Date(0).toISOString()
    : new Date(windowStartMs).toISOString();

  const membersById = new Map<string, TeamPerfMember>();
  const membersByName = new Map<string, TeamPerfMember>();
  for (const m of input.members) {
    membersById.set(m.id, m);
    if (m.name) membersByName.set(m.name, m);
  }

  // Linked conversations per member: ticket assignment OR takeover holder.
  const linkedByMember = new Map<string, Set<string>>();
  const link = (memberId: string, conversationId: string | null) => {
    if (!memberId || !conversationId) return;
    if (!membersById.has(memberId)) return;
    const set = linkedByMember.get(memberId) ?? new Set<string>();
    set.add(conversationId);
    linkedByMember.set(memberId, set);
  };
  for (const t of input.tickets) link(t.assignedToId ?? "", t.conversationId);
  for (const c of input.conversations) {
    if (c.takenOverBy && membersById.has(c.takenOverBy)) {
      link(c.takenOverBy, c.id);
    } else if (c.takenOverByName && membersByName.has(c.takenOverByName)) {
      link(membersByName.get(c.takenOverByName)!.id, c.id);
    }
  }

  // Sole owner per conversation: takeover holder wins, else the single
  // distinct ticket assignee, else null (shared / unlinked).
  const ownerByConversation = new Map<string, string | null>();
  const allConvIds = new Set<string>();
  for (const c of input.conversations) allConvIds.add(c.id);
  for (const t of input.tickets) if (t.conversationId) allConvIds.add(t.conversationId);
  for (const convId of allConvIds) {
    const conv = input.conversations.find((c) => c.id === convId);
    let owner: string | null = null;
    if (conv?.takenOverBy && membersById.has(conv.takenOverBy)) {
      owner = conv.takenOverBy;
    } else if (conv?.takenOverByName && membersByName.has(conv.takenOverByName)) {
      owner = membersByName.get(conv.takenOverByName)!.id;
    } else {
      const assignees = new Set<string>();
      for (const t of input.tickets) {
        if (t.conversationId === convId && t.assignedToId && membersById.has(t.assignedToId)) {
          assignees.add(t.assignedToId);
        }
      }
      owner = assignees.size === 1 ? [...assignees][0] : null;
    }
    ownerByConversation.set(convId, owner);
  }

  // Windowed messages, grouped by conversation, chronological.
  const byConv = new Map<string, { role: string; isTeam: boolean; ms: number }[]>();
  let teamRepliesTotal = 0;
  for (const m of input.messages) {
    const ms = toMs(m.createdAt);
    if (Number.isNaN(ms)) continue;
    if (!Number.isNaN(windowStartMs) && ms < windowStartMs) continue;
    const isTeam = isTeamReplyMessage(m);
    if (isTeam) teamRepliesTotal += 1;
    if (m.role !== "customer" && !isTeam) continue;
    const list = byConv.get(m.conversationId) ?? [];
    list.push({ role: m.role, isTeam, ms });
    byConv.set(m.conversationId, list);
  }
  for (const list of byConv.values()) {
    list.sort((a, b) => a.ms - b.ms);
  }

  // Per-conversation team counts + response pairs, split sole-owner vs bucket.
  const messagesByOwner = new Map<string, number>();
  const pairsByOwner = new Map<string, number[]>();
  const bucketPairs: number[] = [];
  let bucketMessages = 0;
  const bucketConvs = new Set<string>();
  const soleConvsByOwner = new Map<string, Set<string>>();
  for (const [convId, list] of byConv.entries()) {
    const teamCount = list.filter((m) => m.isTeam).length;
    if (teamCount === 0) continue;
    const owner = ownerByConversation.get(convId) ?? null;
    const pairs = responseMinutesForConversation(list);
    if (owner) {
      messagesByOwner.set(owner, (messagesByOwner.get(owner) ?? 0) + teamCount);
      const arr = pairsByOwner.get(owner) ?? [];
      arr.push(...pairs);
      pairsByOwner.set(owner, arr);
      const set = soleConvsByOwner.get(owner) ?? new Set<string>();
      set.add(convId);
      soleConvsByOwner.set(owner, set);
    } else {
      bucketMessages += teamCount;
      bucketPairs.push(...pairs);
      bucketConvs.add(convId);
    }
  }

  // Orders (count only): windowed, by linked conversation.
  const windowedOrders = input.orders.filter((o) => {
    const ms = toMs(o.createdAt);
    if (Number.isNaN(ms)) return false;
    if (!Number.isNaN(windowStartMs) && ms < windowStartMs) return false;
    return true;
  });
  const ordersByMember = new Map<string, Set<string>>();
  let bucketOrders = 0;
  for (const o of windowedOrders) {
    if (!o.conversationId) continue;
    let linked = false;
    for (const [memberId, convs] of linkedByMember.entries()) {
      if (convs.has(o.conversationId)) {
        linked = true;
        const set = ordersByMember.get(memberId) ?? new Set<string>();
        set.add(o.id);
        ordersByMember.set(memberId, set);
      }
    }
    if (!linked && (ownerByConversation.get(o.conversationId) ?? null) === null) {
      // Only conversations with no member link at all feed the bucket
      // order count; a shared-link conversation's orders stay with
      // their linked members and out of the bucket.
      bucketOrders += 1;
    }
  }

  const members: TeamPerfMemberStat[] = input.members.map((m) => {
    const linked = linkedByMember.get(m.id) ?? new Set<string>();
    const pairs = pairsByOwner.get(m.id) ?? [];
    const soleCount = soleConvsByOwner.get(m.id)?.size ?? 0;
    const messagesSent = messagesByOwner.get(m.id) ?? 0;
    return {
      memberId: m.id,
      memberName: m.name,
      departmentName: m.departmentName ?? null,
      messagesSent,
      conversationsLinked: linked.size,
      medianResponseMinutes: median1(pairs),
      ordersTouched: ordersByMember.get(m.id)?.size ?? 0,
      soleLinkConversations: soleCount,
      attribution: {
        messages:
          soleCount > 0
            ? "sole_link_conversation_heuristic"
            : "none_recorded",
        conversations: "recorded_link",
        medianResponse:
          pairs.length > 0
            ? "sole_link_conversation_heuristic"
            : "none_recorded",
        orders: "recorded_link",
      },
    };
  });

  return {
    windowStart,
    members,
    unattributedTeam: {
      messagesSent: bucketMessages,
      conversations: bucketConvs.size,
      medianResponseMinutes: median1(bucketPairs),
      ordersTouched: bucketOrders,
      attribution: {
        messages: "heuristic_team_bucket",
        conversations: "heuristic_team_bucket",
        medianResponse: "heuristic_team_bucket",
        orders: "recorded_link",
      },
    },
    teamRepliesTotal,
    attributionNote: TEAM_ATTRIBUTION_NOTE,
  };
}
