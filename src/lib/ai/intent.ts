/**
 * Intent understanding + response strategy.
 *
 * The agent must UNDERSTAND what kind of question the customer is asking and
 * shape a perfect, human-natural answer for THAT question — not a generic
 * reply. classifyIntent() is a fast bilingual (English/Bengali) rule-based
 * classifier; getIntentGuidance() turns the intent into strategy instructions
 * injected into the system prompt.
 */

export type CustomerIntent =
  | "greeting"
  | "price_inquiry"
  | "availability_inquiry"
  | "order_request"
  | "complaint"
  | "support_request"
  | "human_handoff"
  | "cancel_request"
  | "feedback_positive"
  | "feedback_negative"
  | "followup_question"
  | "smalltalk"
  | "other";

export interface IntentResult {
  intent: CustomerIntent;
  confidence: "high" | "medium" | "low";
  matchedKeywords: string[];
}

const RULES: { intent: CustomerIntent; keywords: string[] }[] = [
  {
    intent: "human_handoff",
    keywords: ["human", "agent", "person", "real person", "call me", "phone number", "manager", "মানুষ", "এজেন্ট", "কল", "ফোন", "ম্যানেজার"],
  },
  {
    intent: "cancel_request",
    keywords: ["cancel", "refund", "বাতিল", "ক্যান্সেল", "রিফান্ড", "টাকা ফেরত"],
  },
  {
    intent: "complaint",
    keywords: ["complaint", "bad", "terrible", "worst", "angry", "disappointed", "late", "wrong", "broken", "missing", "not working", "খারাপ", "দেরি", "ভুল", "নষ্ট", "অভিযোগ", "রাগ"],
  },
  {
    intent: "order_request",
    keywords: ["order", "buy", "book", "i want", "need a ride", "send parcel", "deliver", "অর্ডার", "কিনতে", "বুক", "চাই", "পাঠাতে"],
  },
  {
    intent: "price_inquiry",
    keywords: ["price", "cost", "charge", "fare", "how much", "rate", "discount", "দাম", "খরচ", "ভাড়া", "কত", "ছাড়"],
  },
  {
    intent: "availability_inquiry",
    keywords: ["available", "have", "in stock", "do you offer", "is there", "আছে", "পাওয়া যাবে", "অফার"],
  },
  {
    intent: "feedback_positive",
    keywords: ["thank", "great", "excellent", "awesome", "love", "best", "ধন্যবাদ", "ভালো", "চমৎকার", "দারুন"],
  },
  {
    intent: "feedback_negative",
    keywords: ["not happy", "unsatisfied", "poor service", "never again", "অসন্তুষ্ট"],
  },
  {
    intent: "greeting",
    keywords: ["hello", "hi", "hey", "salam", "assalamu", "good morning", "good evening", "আসসালামু", "হ্যালো", "সালাম", "আদাব"],
  },
  {
    intent: "smalltalk",
    keywords: ["how are you", "who are you", "your name", "কেমন আছ", "তুমি কে", "নাম কি"],
  },
  {
    intent: "support_request",
    keywords: ["help", "problem", "issue", "support", "question", "how do i", "how to", "সাহায্য", "সমস্যা", "প্রশ্ন", "কিভাবে"],
  },
  {
    intent: "followup_question",
    keywords: ["what about", "and then", "also", "what if", "আর", "তারপর"],
  },
];

/**
 * Intents that must never be misread as something else: misclassifying a
 * cancellation, complaint or handoff request as an order/price question is a
 * retention-critical error. When one of these matches, it wins outright.
 */
const STRONG_INTENTS: CustomerIntent[] = ["cancel_request", "complaint", "human_handoff"];

export function classifyIntent(text: string): IntentResult {
  const lower = text.toLowerCase();
  let best: IntentResult = { intent: "other", confidence: "low", matchedKeywords: [] };
  let bestScore = 0;
  let strong: IntentResult | null = null;
  let strongBest = 0;

  for (const rule of RULES) {
    const matched = rule.keywords.filter((k) => {
      const kl = k.toLowerCase();
      if (!lower.includes(kl)) return false;
      return true;
    });
    if (matched.length === 0) continue;
    // Whole-word hits score far above mere substrings ("price" beats the
    // "deliver" inside "delivery").
    const score = matched.reduce((s, k) => {
      const wholeWord = new RegExp(`(^|[^a-z0-9\u0980-\u09FF])${escapeRegExp(k.toLowerCase())}([^a-z0-9\u0980-\u09FF]|$)`, "u").test(lower);
      return s + k.length + (wholeWord ? 20 : 0);
    }, 0);
    const result: IntentResult = {
      intent: rule.intent,
      confidence: matched.length >= 2 ? "high" : "medium",
      matchedKeywords: matched,
    };
    if (STRONG_INTENTS.includes(rule.intent)) {
      if (!strong || score > strongBest) {
        strong = result;
        strongBest = score;
      }
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return strong ?? best;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strategy guidance per intent — injected into the system prompt so the
 * answer fits the question type. Retention is woven through every strategy:
 * every conversation is a conversion opportunity.
 */
export function getIntentGuidance(intent: CustomerIntent): string {
  switch (intent) {
    case "greeting":
      return "The customer is greeting you. Respond warmly in their language, introduce yourself briefly as the business's assistant, and ask how you can help. Keep it short and inviting.";
    case "price_inquiry":
      return "The customer asks about PRICE. Look up the product/service in the PRODUCT CATALOG section and quote the exact price with currency. If the price is not in the catalog, say so honestly and offer to get a quote from the team. After quoting, add one gentle sentence about the value (quality, speed, trust) — never be pushy.";
    case "availability_inquiry":
      return "The customer asks whether something is AVAILABLE. Check the PRODUCT CATALOG: if available, confirm enthusiastically with key details. If NOT available, handle it gracefully (see UNAVAILABLE-PRODUCT RULE): never just say no — highlight 1-3 available alternatives from the catalog that are closest to what they asked for.";
    case "order_request":
      return "The customer wants to PLACE AN ORDER or BOOK a service. Be enthusiastic and helpful. Collect what is needed step by step: which service/product, pickup and drop-off locations (for rides/courier), date/time, and their name + phone number. Confirm every detail back before finalizing. Use the take_order tool once you have the essentials (service type, pickup, contact). Reassure them the team will confirm shortly.";
    case "complaint":
      return "The customer is COMPLAINING. This is a retention-critical moment. 1) Empathize sincerely and apologize without excuses. 2) Ask for the specific details you need (order id, what happened, when). 3) Create a support ticket with the create_ticket tool (priority high/urgent). 4) Tell them exactly what happens next and when they will hear back. Never argue, never blame, never be defensive.";
    case "support_request":
      return "The customer needs HELP. First search the KNOWLEDGE BASE for the answer and give it clearly, step by step. If the knowledge base does not cover it, say so honestly and create a ticket or offer a human handoff — never invent procedures.";
    case "human_handoff":
      return "The customer wants a HUMAN. Do not resist or stall: acknowledge warmly, create a ticket (create_ticket) so nothing is lost, share the business contact number, and say a team member will reach out. Stay polite and brief.";
    case "cancel_request":
      return "The customer wants to CANCEL or get a REFUND. Stay calm and graceful: ask for the order/booking reference, create a ticket (priority high) with all details, explain the next step honestly. If policy allows alternatives (reschedule instead of cancel), offer ONE gentle alternative — but respect their decision immediately if they decline.";
    case "feedback_positive":
      return "The customer is HAPPY. Thank them sincerely, in their language. If natural, invite them to tell a friend or leave a review — one sentence, no pressure.";
    case "feedback_negative":
      return "The customer is DISSATISFIED. Treat like a complaint: empathize, apologize, ask what went wrong, create a ticket, and promise follow-up. Retention matters most here.";
    case "followup_question":
      return "The customer is continuing the conversation. Use the conversation history: answer in context, do not repeat questions you already asked, and keep momentum toward resolving their need.";
    case "smalltalk":
      return "Light smalltalk. Be warm and briefly personable, then gently steer back: ask what you can help them with today.";
    case "other":
    default:
      return "Answer the customer's message directly and helpfully using the knowledge base and catalog. If you are unsure what they need, ask ONE clarifying question — never guess wildly.";
  }
}

/**
 * Retention doctrine — the agent's prime directive. Injected verbatim into
 * every system prompt. 100% effort to convince and keep the customer:
 * graceful, persuasive, never cold, never letting them walk away.
 */
export const RETENTION_DOCTRINE = `
RETENTION DOCTRINE (your prime directive):
- Every conversation is a retention and conversion opportunity. Your absolute goal is that the customer leaves HAPPY and stays with this business.
- Be warm, natural and human — never robotic, never cold, never dismissive. Write like a caring, competent human support agent, in the customer's own language (Bengali or English, matching them).
- NEVER let a customer walk away empty-handed. If you cannot do exactly what they asked, always offer the next-best path: an alternative product/service, a ticket for the team, a callback, a human handoff.
- Persuade gently, never pressure. Highlight genuine value (quality, speed, trust, real human support) in one natural sentence — not a sales pitch.
- If the customer seems frustrated or about to leave, slow down: acknowledge their feeling, take ownership, and give them a concrete next step with a time expectation.
- Never say "I can't help with that" and stop. Always add what you CAN do.
`.trim();

/**
 * Graceful-redirect rule for unavailable products/services.
 */
export const UNAVAILABLE_PRODUCT_RULE = `
UNAVAILABLE-PRODUCT RULE:
- If the customer asks for a product or service that is NOT in the available catalog (or marked unavailable), handle it gracefully:
  1) Acknowledge what they asked for positively ("Great choice — ...").
  2) Be honest that it is not available right now (one short sentence, no over-apologizing).
  3) Immediately highlight 1-3 AVAILABLE alternatives from the PRODUCT CATALOG that are closest to what they wanted, with names and prices. Use the recommend_alternative tool when unsure.
  4) Ask which alternative interests them, or offer to notify them / connect them with the team for the original request.
- Never invent products. Only suggest items that are actually in the catalog as available.
`.trim();
