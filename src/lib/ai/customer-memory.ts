/**
 * customer-memory.ts — per-customer memory across channels (00:57).
 *
 * The agent REMEMBERS everything per customer (which video/what they
 * liked, where they did what, where they commented) and talks
 * accordingly, beautifully arranged — and it WATCHES that no customer
 * is lost (retention).
 *
 * WHAT EXISTS TODAY (local copy, verified by reading — not claimed
 * beyond the code):
 * - Customer row: tags, metadata Json, CustomerNote rows, conversations
 *   (prisma/schema.prisma Customer/CustomerNote).
 * - Cross-channel identity: resolveCustomer() maps a channel contact to
 *   one customerId (used by the WhatsApp path).
 * - get_customer_history tool: past conversations by customerId/contact
 *   (last 5 messages each).
 * - SocialInteraction rows: platform, kind (comment/message/like/post),
 *   customerRef, content, likes, replied flag (social/engagement.ts).
 * - Retention watch, partial: checkSLABreaches() escalates conversations
 *   with NO assistant reply past the first-response window
 *   (conversation-engine.ts); follow-ups exist (schedule_followup).
 *
 * WHAT IS MISSING (gap, honestly stated — this module does not fake it):
 * - The chat engine NEVER loads any of it into a turn: chat() sets
 *   customerHistory: [] and never calls get_customer_history or reads
 *   SocialInteraction. A customer who liked a video on Instagram is a
 *   stranger again on WhatsApp today.
 * - No preference/like aggregation exists: nothing turns "liked X,
 *   commented Y" into a prompt line.
 * - No "no customer lost" surface is proven: SLA escalation exists as
 *   a function, but its schedule/caller and any team surfacing were not
 *   verified in this leg, and nothing watches unanswered COMMENTS
 *   (SocialInteraction.replied=false) as a retention queue.
 *
 * This pure module is the memory RECORD + RECALL contract: the shape
 * the engine must load (from Customer metadata/notes + SocialInteraction
 * rows) and the one short line it must inject into the prompt. Until
 * the apply step wires that load, cross-channel recall is NOT live —
 * the harness proves the contract, not the wiring.
 */

export interface MemoryInteraction {
  channel: string;
  kind: "like" | "comment" | "message" | "post" | "purchase" | "view";
  /** What it was about (video/product/topic), in the customer's words. */
  topic: string;
  /** Platform object reference when known (post/video/comment id). */
  ref?: string;
}

export interface CustomerMemory {
  customerRef: string;
  interactions: MemoryInteraction[];
}

/** Append an interaction (newest last). Pure; persistence is apply-time. */
export function recordInteraction(
  memory: CustomerMemory,
  interaction: MemoryInteraction
): CustomerMemory {
  return {
    customerRef: memory.customerRef,
    interactions: [...memory.interactions, interaction],
  };
}

/** Topics the customer liked or commented on, most recent first, deduped. */
export function likedTopics(memory: CustomerMemory): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ix of [...memory.interactions].reverse()) {
    if ((ix.kind === "like" || ix.kind === "comment") && ix.topic) {
      const key = ix.topic.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(ix.topic);
      }
    }
  }
  return out;
}

/** Channels this customer has used, in first-seen order. */
export function channelsUsed(memory: CustomerMemory): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ix of memory.interactions) {
    if (!seen.has(ix.channel)) {
      seen.add(ix.channel);
      out.push(ix.channel);
    }
  }
  return out;
}

/**
 * The ONE short memory line for the prompt (never a dump): what they
 * liked/commented on, and where. Empty string when there is nothing
 * to remember — the agent then says nothing about history, and
 * certainly invents none.
 */
export function memoryLineForPrompt(
  memory: CustomerMemory,
  lang: "bn" | "en"
): string {
  const topics = likedTopics(memory);
  if (topics.length === 0) return "";
  const channels = channelsUsed(memory).join(", ");
  if (lang === "bn") {
    return `এই গ্রাহক আগে ${channels}-এ ${topics.join(", ")} নিয়ে আগ্রহ দেখিয়েছেন। সেই অনুযায়ী কথা বলুন।`;
  }
  return `This customer previously showed interest in ${topics.join(", ")} on ${channels}. Talk accordingly.`;
}

/** Retention check (pure): conversations with no assistant reply past
 * the window are "at risk" — they must surface to the team, not drop.
 * (Mirrors checkSLABreaches' rule; the surfacing itself is apply-time.) */
export function atRiskConversations(
  conversations: Array<{
    id: string;
    hasAssistantReply: boolean;
    ageMinutes: number;
  }>,
  firstResponseMins: number
): string[] {
  return conversations
    .filter((c) => !c.hasAssistantReply && c.ageMinutes > firstResponseMins)
    .map((c) => c.id);
}
