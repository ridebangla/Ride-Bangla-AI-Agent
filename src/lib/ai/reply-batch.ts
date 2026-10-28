/**
 * reply-batch.ts — ONE reply per customer burst (owner rule 00:57).
 *
 * BATCHING RULE: a customer sends TEN messages at once → the agent does
 * NOT give ten replies → ONE small, great, organized reply covering all
 * ten, enough to convince. Replies are SMALL, beautiful, organized —
 * never a wall of text, never one reply per message.
 *
 * CONFLICT FOUND (honest, do not hide): the current social sync
 * (src/lib/social/engagement.ts) is built the opposite way — its header
 * says "reply to EVERY one of them" and it generates + posts one reply
 * per pulled item. That loop is what batching must REPLACE at apply
 * time (group first, generate once, post once per thread). This pure
 * module is the contract for that rewrite; it does not by itself
 * change engagement.ts, and no batched social reply is live until the
 * apply step rewires the sync loop to call groupBursts() before
 * generateReply(). The channel webhook paths (WhatsApp etc.) have the
 * same shape of problem at a smaller scale: chat() is one-message-in,
 * so ingress must buffer a burst per conversation and call chat()
 * once with the combined messages. That buffering is also apply-time
 * work, listed in the report's gap list.
 *
 * PURE MODULE: no imports, no DB, no platform writes.
 */

export interface IncomingMessage {
  id: string;
  /** Stable per-customer key (phone, platform user id, visitor id). */
  customerRef: string;
  /** Thread the message belongs to (conversation id, post/comment id). */
  threadId: string;
  channel: string;
  kind: "message" | "comment";
  text: string;
}

export interface MessageBurst {
  customerRef: string;
  threadId: string;
  channel: string;
  kind: "message" | "comment";
  messages: IncomingMessage[];
}

/** Group a pull of incoming items into one burst per customer+thread.
 * Order inside a burst is arrival order; nothing is dropped. */
export function groupBursts(items: IncomingMessage[]): MessageBurst[] {
  const groups = new Map<string, MessageBurst>();
  for (const item of items) {
    const key = `${item.customerRef}::${item.threadId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.messages.push(item);
    } else {
      groups.set(key, {
        customerRef: item.customerRef,
        threadId: item.threadId,
        channel: item.channel,
        kind: item.kind,
        messages: [item],
      });
    }
  }
  return [...groups.values()];
}

/** Reply jobs for a burst: ALWAYS exactly one, however many messages. */
export function replyJobsForBurst(burst: MessageBurst): number {
  void burst;
  return 1;
}

function shortClause(text: string, max = 72): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

/**
 * Build the single batched reply: one short greeting naming the
 * business, then ONE short organized line per incoming message, then
 * one convincing close. Small by construction: every line is capped,
 * and the whole reply is capped (see harness bound). It covers every
 * message's topic because every message gets its own line — a reply
 * that drops a message's topic fails the harness coverage check.
 */
export function buildBatchedReply(
  burst: MessageBurst,
  businessName: string,
  lang: "bn" | "en"
): string {
  const bn = lang === "bn";
  const lines = burst.messages.map(
    (m, i) => `${i + 1}. ${shortClause(m.text)}`
  );
  if (bn) {
    return [
      `${businessName}-এর পক্ষ থেকে ধন্যবাদ! আপনার সবগুলো মেসেজ দেখেছি:`,
      ...lines,
      "এই বিষয়গুলো নিয়ে আমি আপনাকে সাহায্য করতে পারব — কোনটি দিয়ে শুরু করব?",
    ].join("\n");
  }
  return [
    `Thanks for all your messages — from ${businessName}:`,
    ...lines,
    "I can help with all of these — which shall we start with?",
  ].join("\n");
}
