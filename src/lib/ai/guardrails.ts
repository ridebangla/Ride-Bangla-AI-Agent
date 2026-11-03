/**
 * AI Guardrails - Controls what the AI can and cannot do.
 */

export interface GuardrailConfig {
  blockedTopics: string[];
  maxResponseLength: number;
  requireHumanApproval: string[];
  confidenceThreshold: number;
}

const DEFAULT_GUARDRAILS: GuardrailConfig = {
  blockedTopics: [
    "legal advice",
    "medical advice",
    "investment advice",
    "price commitments",
    "competitor comparisons",
  ],
  maxResponseLength: 2000,
  requireHumanApproval: [
    "refund",
    "cancellation",
    "discount",
    "compensation",
    "legal",
  ],
  confidenceThreshold: 0.6,
};

/**
 * Check if a message contains blocked topics.
 */
export function checkBlockedTopics(
  message: string,
  config: GuardrailConfig = DEFAULT_GUARDRAILS
): { blocked: boolean; topic?: string } {
  const lower = message.toLowerCase();
  for (const topic of config.blockedTopics) {
    if (lower.includes(topic.toLowerCase())) {
      return { blocked: true, topic };
    }
  }
  return { blocked: false };
}

/**
 * Check if a message requires human approval before AI responds.
 */
export function requiresHumanApproval(
  message: string,
  config: GuardrailConfig = DEFAULT_GUARDRAILS
): { required: boolean; reason?: string } {
  const lower = message.toLowerCase();
  for (const keyword of config.requireHumanApproval) {
    if (lower.includes(keyword.toLowerCase())) {
      return { required: true, reason: keyword };
    }
  }
  return { required: false };
}

/**
 * FARE-FIGURE SUPPRESSION (owner rule: the agent says NOTHING about
 * fares — no figures ever; Team A audit 2026-11-03).
 *
 * A fare figure reaching a reply is a defect, whatever its source:
 * the model inventing one, a stale knowledge entry quoting one, or a
 * browsed page's fare table. Prompt instructions alone cannot enforce
 * this — the model is told to use the knowledge base exactly, so a
 * stale ৳50/৳70 entry would otherwise be quoted verbatim. This is
 * therefore a DETERMINISTIC post-filter over the finished reply text,
 * applied by the engine before the reply is saved/sent (main path
 * and approval-mode drafts; identity/greeting templates are filtered
 * at their own return points).
 *
 * Scope, deliberately narrow so legitimate product prices survive:
 * a sentence/line is removed ONLY when it contains BOTH a fare
 * context word (fare, ভাড়া, delivery charge/fee/cost, ডেলিভারি
 * চার্জ/ফি, shipping/courier charge/fee/cost, per-km rate) AND a
 * numeric figure. "Delivery is free" (no figure) survives; "Price
 * ৳500" (no fare context) survives; "delivery charge ৳60" is
 * removed whole — the figure is never replaced with another figure,
 * and no replacement sentence is invented here. A reply that would
 * become empty is the engine's fail-closed case (silent, team-visible),
 * not a case for inventing fallback copy in this module.
 */
const FARE_CONTEXT_PATTERN =
  /fare|ভাড়া|delivery\s+(charge|fee|cost|price)|ডেলিভারি\s*(চার্জ|ফি|মূল্য)|shipping\s+(charge|fee|cost)|courier\s+(charge|fee|cost)|per[-\s]?km|\/\s*km|প্রতি\s*কিলোমিটার/i;
const FIGURE_PATTERN = /[0-9০-৯]/;

function isFareFigureSegment(segment: string): boolean {
  return FARE_CONTEXT_PATTERN.test(segment) && FIGURE_PATTERN.test(segment);
}

/* ------------------------------------------------------------------ */
/* FARE-BOUNDARY EXEMPTION (head call, decision A4, 2026-11-03).       */
/*                                                                      */
/* The agent never states fare-table figures — but a tenant's OWN     */
/* saved delivery charge, presented via composePriceAnswer (price +  */
/* delivery charge + total together, only when both figures are       */
/* known and currencies match), is a business-configured figure,     */
/* NOT a fare-table quote, and is ALLOWED. A line rendered from a     */
/* composed price answer looks exactly like a fare-context + figure   */
/* sentence to the filter above, so without an exemption the filter   */
/* would strip the legitimate line.                                   */
/*                                                                      */
/* Mechanism — machine marker, NOT a whitelist: only a block          */
/* produced verbatim by renderComposedPriceAnswer (business-rules)    */
/* survives, and only when it passes STRUCTURAL validation here:     */
/* exactly three lines (Price / Delivery charge / Total), one        */
/* shared 3-letter currency, non-negative finite figures, and         */
/* price + delivery == total. An arbitrary "delivery charge"          */
/* sentence carries no marker and is still stripped; a marked block   */
/* with wrong arithmetic or mismatched currencies is DROPPED whole    */
/* (sentinels included) — never delivered, never repaired. The        */
/* sentinels are control characters that no model, knowledge entry,   */
/* or browsed page produces in normal text; if an upstream layer      */
/* strips them, the block degrades to unmarked text and is fare-      */
/* stripped — the safe direction (a legitimate line lost, never a     */
/* fare figure leaked). Sentinels NEVER reach the customer: valid     */
/* blocks are emitted with sentinels removed, invalid blocks are      */
/* removed entirely.                                                  */
/*                                                                      */
/* This module stays dependency-free: it validates the wire format    */
/* only and never imports the composer. The renderer and this         */
/* validator must agree on the format; tests pin both sides.          */
/* ------------------------------------------------------------------ */

const COMPOSED_START = "\u0001COMPOSED-PRICE-START\u0001";
const COMPOSED_END = "\u0001COMPOSED-PRICE-END\u0001";
const COMPOSED_BLOCK_PATTERN = new RegExp(
  `\u0001COMPOSED-PRICE-START\u0001\n?([\\s\\S]*?)\n?\u0001COMPOSED-PRICE-END\u0001`,
  "g"
);
const COMPOSED_LINE_PATTERN =
  /^(Price|Delivery charge|Total): (\d+(?:\.\d+)?) ([A-Z]{3})$/;

/**
 * Validate a marked block's inner text. Returns the three clean
 * customer-visible lines on success, null on any shape failure.
 */
function parseComposedPriceBlock(inner: string): string[] | null {
  const lines = inner
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 3) return null;
  const parsed: Array<{ label: string; amount: number; currency: string }> = [];
  const expected = ["Price", "Delivery charge", "Total"];
  for (let i = 0; i < 3; i++) {
    const m = COMPOSED_LINE_PATTERN.exec(lines[i]);
    if (!m || m[1] !== expected[i]) return null;
    const amount = Number(m[2]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    parsed.push({ label: m[1], amount, currency: m[3] });
  }
  if (
    parsed[0].currency !== parsed[1].currency ||
    parsed[0].currency !== parsed[2].currency
  ) {
    return null;
  }
  const sum = parsed[0].amount + parsed[1].amount;
  if (Math.abs(parsed[2].amount - sum) > 1e-9 * Math.max(1, sum)) return null;
  return lines;
}

/**
 * Split text into marked blocks (validated) and the remaining
 * unmarked text. Valid blocks are replaced by placeholders in the
 * remainder; invalid blocks are removed from the remainder.
 */
function extractComposedPriceBlocks(
  text: string
): { remainder: string; blocks: string[][] } {
  const blocks: string[][] = [];
  COMPOSED_BLOCK_PATTERN.lastIndex = 0;
  const remainder = text.replace(COMPOSED_BLOCK_PATTERN, (_match, inner: string) => {
    const valid = parseComposedPriceBlock(inner);
    if (!valid) return "";
    const idx = blocks.length;
    blocks.push(valid);
    return `\u0000COMPOSED-PRICE-EXEMPT-${idx}\u0000`;
  });
  return { remainder, blocks };
}

/** True when any sentence/line of the text carries a fare figure. Valid composed-price blocks are exempt; invalid marked blocks still count (fail-closed). */
export function containsFareFigure(text: string): boolean {
  if (!text) return false;
  const { remainder } = extractComposedPriceBlocks(text);
  for (const line of remainder.split("\n")) {
    // Terminator RUNS ([.!?।]*) stay attached: "see..." is one
    // segment, not "see." plus dropped dots (Team A fix: the [.]?
    // form silently ate trailing ellipses from kept sentences).
    const sentences = line.match(/[^.!?।]+[.!?।]*/g) ?? [];
    for (const s of sentences) {
      if (s.trim() && isFareFigureSegment(s)) return true;
    }
  }
  return false;
}

/**
 * Remove every fare-figure sentence/line from a reply. Returns the
 * reply with those segments dropped (other sentences untouched, in
 * order). Valid composed-price blocks survive with their sentinels
 * stripped; invalid marked blocks are dropped whole. Returns ""
 * when nothing non-fare remains — the caller decides the
 * fail-closed handling for that case.
 */
export function suppressFareFigures(text: string): string {
  if (!text) return "";
  const { remainder, blocks } = extractComposedPriceBlocks(text);
  const keptLines: string[] = [];
  for (const line of remainder.split("\n")) {
    const sentences = line.match(/[^.!?।]+[.!?।]*/g) ?? [];
    const kept = sentences
      .filter((s) => s.trim() && !isFareFigureSegment(s))
      .map((s) => s.trim());
    if (kept.length > 0) keptLines.push(kept.join(" "));
  }
  let out = keptLines.join("\n").trim();
  // Restore exempt blocks (sentinels already gone — the placeholder
  // held the place, the stored lines are the customer-visible text).
  blocks.forEach((lines, idx) => {
    out = out.replace(
      `\u0000COMPOSED-PRICE-EXEMPT-${idx}\u0000`,
      lines.join("\n")
    );
  });
  return out.trim();
}

/**
 * Truncate AI response to maximum allowed length.
 */
export function enforceResponseLength(
  response: string,
  config: GuardrailConfig = DEFAULT_GUARDRAILS
): string {
  if (response.length <= config.maxResponseLength) return response;
  return response.substring(0, config.maxResponseLength).trimEnd() + "...";
}

/**
 * Analyze sentiment of a message.
 * Returns: positive, negative, neutral, or frustrated
 */
export function analyzeSentiment(message: string): {
  sentiment: "positive" | "negative" | "neutral" | "frustrated";
  score: number;
} {
  const lower = message.toLowerCase();

  const negativePatterns = [
    "angry", "furious", "terrible", "worst", "hate", "awful",
    "disgusting", "unacceptable", "ridiculous", "horrible",
    "scam", "fraud", "sue", "lawyer", "complaint",
  ];
  const frustratedPatterns = [
    "again", "still", "waiting", "how long", "not working",
    "broken", "frustrated", "annoyed", "disappointed",
    "already told", "third time", "keep asking",
  ];
  const positivePatterns = [
    "thank", "great", "excellent", "awesome", "love",
    "perfect", "amazing", "wonderful", "fantastic", "helpful",
    "appreciate", "satisfied", "happy",
  ];

  let score = 0;
  for (const p of negativePatterns) {
    if (lower.includes(p)) score -= 2;
  }
  for (const p of frustratedPatterns) {
    if (lower.includes(p)) score -= 1;
  }
  for (const p of positivePatterns) {
    if (lower.includes(p)) score += 2;
  }

  if (score <= -3) return { sentiment: "negative", score: Math.max(-1, score / 10) };
  if (score <= -1) return { sentiment: "frustrated", score: score / 10 };
  if (score >= 2) return { sentiment: "positive", score: Math.min(1, score / 10) };
  return { sentiment: "neutral", score: 0 };
}

/**
 * Detect customer intent from message.
 */
export function detectIntent(message: string): {
  intent: string;
  confidence: number;
} {
  const lower = message.toLowerCase();

  const intents: { intent: string; keywords: string[]; weight: number }[] = [
    { intent: "support", keywords: ["help", "issue", "problem", "not working", "broken", "error", "bug", "fix"], weight: 1 },
    { intent: "billing", keywords: ["invoice", "bill", "charge", "payment", "refund", "price", "cost", "subscription", "plan"], weight: 1 },
    { intent: "sales", keywords: ["buy", "purchase", "pricing", "demo", "trial", "interested", "quote", "proposal"], weight: 1 },
    { intent: "complaint", keywords: ["complaint", "unhappy", "dissatisfied", "terrible", "worst", "unacceptable", "sue"], weight: 1.5 },
    { intent: "information", keywords: ["how", "what", "when", "where", "can i", "do you", "is it", "tell me"], weight: 0.5 },
    { intent: "cancellation", keywords: ["cancel", "unsubscribe", "stop", "close account", "terminate", "end service"], weight: 1.5 },
    { intent: "feedback", keywords: ["suggest", "feedback", "improve", "feature request", "would be nice", "wish"], weight: 1 },
    { intent: "greeting", keywords: ["hello", "hi", "hey", "good morning", "good afternoon"], weight: 0.3 },
  ];

  let bestMatch = { intent: "general", confidence: 0 };

  for (const { intent, keywords, weight } of intents) {
    let matchCount = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) matchCount++;
    }
    const confidence = Math.min(1, (matchCount * weight) / 3);
    if (confidence > bestMatch.confidence) {
      bestMatch = { intent, confidence };
    }
  }

  return bestMatch;
}

/**
 * Generate a conversation summary from messages.
 */
export function generateSummaryPrompt(
  messages: { role: string; content: string }[]
): string {
  const transcript = messages
    .slice(-20)
    .map((m) => `${m.role}: ${m.content.substring(0, 300)}`)
    .join("\n");

  return `Summarize this customer support conversation in 2-3 sentences. Focus on: what the customer needed, what was done, and the outcome.

Conversation:
${transcript}

Summary:`;
}

/**
 * Calculate AI confidence score based on response characteristics.
 */
export function estimateConfidence(
  response: string,
  knowledgeBaseSize: number,
  hasToolCalls: boolean
): { score: number; shouldEscalate: boolean } {
  let score = 0.5;

  // Knowledge base coverage
  if (knowledgeBaseSize > 20) score += 0.1;
  if (knowledgeBaseSize > 50) score += 0.1;

  // Response quality indicators
  if (response.length > 50 && response.length < 1500) score += 0.1;
  if (hasToolCalls) score += 0.1;

  // Uncertainty indicators
  const uncertainPhrases = [
    "i'm not sure", "i don't know", "i cannot", "i apologize",
    "unfortunately", "i'm unable", "beyond my knowledge",
    "connect you with", "team member",
  ];
  const lower = response.toLowerCase();
  for (const phrase of uncertainPhrases) {
    if (lower.includes(phrase)) {
      score -= 0.15;
      break;
    }
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    shouldEscalate: score < DEFAULT_GUARDRAILS.confidenceThreshold,
  };
}

/**
 * Generate suggested replies for an agent based on conversation context.
 */
export function generateSuggestedRepliesPrompt(
  messages: { role: string; content: string }[],
  cannedResponses: { title: string; content: string }[]
): string {
  const lastMessages = messages.slice(-5);
  const transcript = lastMessages
    .map((m) => `${m.role}: ${m.content.substring(0, 200)}`)
    .join("\n");

  const canned = cannedResponses
    .slice(0, 5)
    .map((c) => `- ${c.title}: ${c.content.substring(0, 100)}`)
    .join("\n");

  return `Based on this conversation, suggest 3 short professional replies the support agent could send. Each reply should be 1-2 sentences.

Recent messages:
${transcript}

${canned ? `Available templates:\n${canned}\n` : ""}
Return exactly 3 suggestions as a JSON array of strings.`;
}
