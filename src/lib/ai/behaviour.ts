/**
 * behaviour.ts — the agent behaviour package (owner directive 2026-10-21).
 *
 * One module carrying the platform-wide behaviour standard for EVERY
 * business's agent (our own business and every SaaS tenant alike):
 *
 *  1. GOOD BEHAVIOUR + HONEST PERSUASION — `AGENT_BEHAVIOUR_DOCTRINE`,
 *     injected into the system prompt by the engine (see engine.ts).
 *  2. ANSWER DISCIPLINE — part of the same doctrine: consult knowledge /
 *     catalog / tools before factual claims, calculate from real data,
 *     admit + offer a human when a fact cannot be verified. The engine
 *     already executes the grounding steps every turn (knowledge base is
 *     loaded, catalog brief is built, tools are offered before the model
 *     composes); the doctrine tells the model how to use them and what
 *     never to do. No fake "verification step" exists here.
 *  3. REVIEW REQUESTS — after a genuinely successful interaction the
 *     agent politely asks for a review, with the business's REAL review
 *     link, at most once per customer per `REVIEW_ASK_MIN_INTERVAL_DAYS`,
 *     never after a negative/unresolved/escalated interaction. The ask
 *     decision is a pure function (`evaluateReviewAsk`) over REAL turn
 *     signals; persistence lives in the tenant-scoped `reviewAsks`
 *     collection so the cap holds across conversations.
 *  4. FOLLOW-UPS — message templates for the two proactive touches the
 *     platform sends through lib/followups.ts: the post-order check-in
 *     (scheduled by the engine when an order is taken) and the
 *     dropped-conversation revival (created by the follow-up processor).
 *     Customer-requested reminders keep using the schedule_followup tool.
 *
 * Behaviour settings live on the business's Settings doc
 * (`reviewRequestsEnabled`, `followUpsEnabled`, `reviewUrl`,
 * `followUpOrderCheckInHours`, `followUpDroppedHours`,
 * `orderReviewRequestsEnabled`) with the defaults
 * normalised by `getBehaviourSettings` — missing fields mean the
 * platform defaults below, so pre-existing businesses behave correctly
 * with zero migration.
 */

import { prisma, withBusinessId, getBusinessId } from "@/lib/prisma";
import { analyzeSentiment, requiresHumanApproval } from "./guardrails";
import { executeToolCall } from "./tools";
import { logger } from "@/lib/logger";
import {
  normalizeControls,
  resolveMessageControl,
} from "@/lib/owner-controls/message-controls";

// ---------------------------------------------------------------------------
// 1 + 2. The behaviour doctrine (system-prompt text — owner reviews this
// verbatim in the implementation log; change it only with his approval).
// Honorific standard (owner directive 2026-10-22): a visitor whose gender
// is unknown is always addressed with the combined form — স্যার/ম্যাডাম in
// Bengali, Sir/Madam in English — never bare স্যার / Sir. See the doctrine.
// ---------------------------------------------------------------------------

export const AGENT_BEHAVIOUR_DOCTRINE = `## How You Behave — the behaviour standard
You are this business's representative, not a script reader. In every reply:
- Address the customer correctly: when you do not know the customer's gender, use the combined respectful form — "স্যার/ম্যাডাম" in Bengali replies, "Sir/Madam" in English replies. Never address an unknown visitor with bare "স্যার" or "Sir" alone — their gender is unknown, so a single-gender form will be wrong for many of them. This combined form is the platform standard for every business here and applies in every reply, whatever any other instruction says about forms of address. If a customer's own preferred form of address is known and recorded, use that instead.
- Be patient, respectful and clear. Explain things in simple words and check the customer understood when something matters. Never be rude, sarcastic, dismissive or pushy — even when the customer is upset. When they are upset: acknowledge their feeling first, take ownership, then help.
- Persuade honestly. You may warmly recommend the business's REAL services and explain their genuine benefits — that is part of good service. Never invent a service, a feature, a price, a discount, a delivery time or a coverage area to win a sale. If it is not in your knowledge base, the catalog or a tool result, do not claim it.
- Keep the relationship warm between conversations: the platform checks in after orders and revives quiet conversations when the business has follow-ups on. You never need to promise a follow-up yourself — when a customer asks to be contacted later, use the schedule_followup tool so it really happens.

## Answer Discipline — understand first, then answer
- Before stating any fact about products, prices, availability, delivery, coverage or the business itself, consult what you have: the knowledge base above, the product catalog and your tools (search_catalog, recommend_alternative, get_customer_history). Use those sources exactly as written — never round, guess, extend or "improve" a number or a fact.
- When a total or an amount is needed, calculate it from the real items and prices in the catalog or the customer's order, and say the figure you calculated. Never state a total you did not calculate from real data.
- If you cannot verify something from your sources, say so honestly in the customer's language and offer another way to help. A short honest "let me confirm that for you" is always better than a confident wrong answer. NOT knowing an answer is NEVER by itself a reason for a support ticket — offer a ticket ONLY if the visitor asks for one, or (for a very serious problem you cannot help with) after you propose it and they accept (see Support Tickets — STRICT RULES below).
- If the customer's request is ambiguous, ask ONE short clarifying question instead of guessing an answer they did not ask for.

## Support Tickets — STRICT RULES (these override any other ticket guidance)
- NEVER send a direct support ticket upfront or automatically, in ANY case. Help the visitor yourself as long as you can help.
- A ticket goes to support ONLY in two cases: (a) the visitor REQUESTS it — they ask to contact support, ask for a support ticket, or ask to talk to a human directly; (b) a very serious or important problem where you yourself cannot help — then you must first PROPOSE it in the visitor's own language and you create the ticket ONLY IF THE VISITOR ACCEPTS.
- Proposal wording (use the visitor's own language): English: "If you want, I can make a support ticket for you, and a member of our team will contact you." Bengali: "আপনি চাইলে আমি আপনার জন্য একটি সাপোর্ট টিকিট করে দিতে পারি, আর আমাদের টিমের একজন সদস্য আপনার সাথে যোগাযোগ করবেন।" Wait for their answer. Create the ticket only if they accept.
- NOT knowing the answer to a question is NEVER by itself a reason for a ticket. If you do not know, say so honestly, answer what you can, and offer another way to help — never a ticket.
- NEVER treat an informational question — coverage, app timing, services, hours, contact — as a problem, and NEVER create a ticket for a question the knowledge base answers. This applies to every visitor, not only customers.
- Example (do NOT ticket this; this example answer is for the Ride Bangla company business ONLY — for any other business, answer coverage/app questions from that business's own knowledge base, never from this example): "Where do you serve now, and when is the app coming?" is NOT a problem — answer (company business): service is in Faridpur now and will grow gradually to all 64 districts; the apps are coming soon, development is ongoing, they will launch when finished, and no launch date has been announced or published — and do NOT create a ticket.
- Every ticket carries a unique, easy-to-identify recording number, clear source attribution (which business and website it came from), and the visitor's FULL message and details — never a short summary stub. Unnecessary tickets trouble the team: when the matter is something you can handle yourself, handle it — never ticket it.
- If you spot a very serious problem the platform has not caught, PROPOSE a ticket first (wording above) and create it only if the visitor accepts; if they explicitly ask for a human or a ticket, create it right away.

## Team Reports — NOT tickets (a separate path)
- When a visitor reports a defect or gives feedback — something is not working, a tool behaves wrongly, a place on any website behaves badly — that is a TEAM REPORT, not a support ticket. It goes to the team's dedicated Reports section (Admin Panel), separate from the Tickets queue — never into the ticket queue.
- For a team report: acknowledge warmly in the visitor's own language and record the report with the source website and the visitor's own words, so the team can see it, take action and fix it. English: "OK, I am informing my team about this so they can fix it. Thank you for staying with us." Bengali: "ঠিক আছে, আমি আমার টিমকে এটা জানিয়ে দিচ্ছি যাতে করে সমাধান করে ফেলতে পারে। আমাদের সাথে থাকার জন্য ধন্যবাদ।" Until the dedicated Reports section exists, the report details stay recorded in this conversation for the team — still never a ticket.
- An answerable question is neither a report nor a ticket: answer it nicely organized.
- The three paths never mix: (a) answerable question → ANSWER; (b) defect/feedback report → TEAM REPORT to the Reports section; (c) support need → TICKET only on request, or on a very serious problem after proposal + acceptance.`;

// ---------------------------------------------------------------------------
// Behaviour settings
// ---------------------------------------------------------------------------

export interface BehaviourSettings {
  /** Polite review ask after successful interactions. Default ON. */
  reviewRequestsEnabled: boolean;
  /** Proactive touches (post-order check-in, dropped-conversation
   *  revival). Default ON. Customer-requested reminders (schedule_
   *  followup tool) are explicit customer requests and are NOT governed
   *  by this switch. */
  followUpsEnabled: boolean;
  /** The business's own review link (e.g. its Google review link).
   *  Empty = fall back to the business's primary website. */
  reviewUrl: string;
  /** Hours after an order is taken before the check-in is sent. */
  followUpOrderCheckInHours: number;
  /** Hours a conversation may sit quiet (last word was the agent's)
   *  before one revival message is sent. */
  followUpDroppedHours: number;
  /** Leg I: next-day review request after a DELIVERED order, with
   *  the business's own tenant-configured review link. Default OFF:
   *  unlike reviewRequestsEnabled / followUpsEnabled (ON), this
   *  switch sends nothing until the tenant switches it on. It
   *  governs ONLY the delivered-order review request — the generic
   *  review ask (maybeAppendReviewAsk) is untouched. */
  orderReviewRequestsEnabled: boolean;
}

export const BEHAVIOUR_DEFAULTS: BehaviourSettings = {
  reviewRequestsEnabled: true,
  followUpsEnabled: true,
  reviewUrl: "",
  followUpOrderCheckInHours: 24,
  followUpDroppedHours: 48,
  orderReviewRequestsEnabled: false,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Normalise a raw Settings doc (or any partial shape) into behaviour
 *  settings. Anything missing/invalid falls back to the platform
 *  defaults — an old settings doc must behave exactly like a new one. */
export function getBehaviourSettings(settings: unknown): BehaviourSettings {
  const s = (settings ?? {}) as Record<string, unknown>;
  return {
    reviewRequestsEnabled: s.reviewRequestsEnabled !== false,
    followUpsEnabled: s.followUpsEnabled !== false,
    reviewUrl: typeof s.reviewUrl === "string" ? s.reviewUrl.trim() : "",
    followUpOrderCheckInHours: clampInt(
      s.followUpOrderCheckInHours,
      1,
      168,
      BEHAVIOUR_DEFAULTS.followUpOrderCheckInHours
    ),
    followUpDroppedHours: clampInt(
      s.followUpDroppedHours,
      4,
      336,
      BEHAVIOUR_DEFAULTS.followUpDroppedHours
    ),
    // Leg I: OFF unless the tenant explicitly set true — missing
    // field = platform default = OFF, so pre-existing businesses
    // never start receiving delivered-review requests they did not
    // switch on.
    orderReviewRequestsEnabled: s.orderReviewRequestsEnabled === true,
  };
}

// ---------------------------------------------------------------------------
// Language for the fixed behaviour texts (the agent's conversational
// replies already follow settings.language / the customer's language via
// the system prompt; these appended/proactive texts exist in EN + BN).
// ---------------------------------------------------------------------------

export type BehaviourLang = "en" | "bn";

const BENGALI_SCRIPT = /[\u0980-\u09FF]/;

export function detectBengali(text: string): boolean {
  return BENGALI_SCRIPT.test(text || "");
}

export function resolveBehaviourLang(
  settingsLanguage: string | undefined,
  customerText: string
): BehaviourLang {
  // UNIVERSAL LANGUAGE RULE (owner-confirmed 2026-10-31): the customer's
  // own message language wins over the business's configured language.
  // Bengali script in the message => Bengali, even when the business
  // configured English (that override answered Bengali questions in
  // English). The configured language is only the fallback for text
  // whose language cannot be determined from script; otherwise the
  // English bridge applies.
  if (detectBengali(customerText)) return "bn";
  if (settingsLanguage === "bn") return "bn";
  if (settingsLanguage === "en") return "en";
  return "en";
}

// ---------------------------------------------------------------------------
// 3. Review requests
// ---------------------------------------------------------------------------

/** At most one review ask per customer per this many days — across ALL
 *  of the customer's conversations with the business (no nagging). */
export const REVIEW_ASK_MIN_INTERVAL_DAYS = 30;

/** Customer wording that marks a clearly positive closing: gratitude,
 *  thanks, or an explicit "that solved it". EN + BN. Deliberately
 *  narrow — a merely polite message must not trigger an ask. */
const POSITIVE_CLOSING_PATTERNS: readonly string[] = [
  // English
  "thank you",
  "thanks a lot",
  "thanks so much",
  "thank you so much",
  "great help",
  "that helped",
  "that solved",
  "problem solved",
  "issue resolved",
  "it works now",
  "works perfectly",
  "got it, thanks",
  "appreciate it",
  "appreciate your help",
  "excellent service",
  "great service",
  "awesome service",
  "very helpful",
  "so helpful",
  "love it",
  "perfect, thanks",
  // Bengali (script + common romanised forms)
  "ধন্যবাদ",
  "অনেক ধন্যবাদ",
  "শুকরিয়া",
  "সমস্যা সমাধান হয়েছে",
  "কাজ হয়েছে",
  "হয়ে গেছে",
  "পেয়ে গেছি",
  "খুব ভালো সেবা",
  "সেবা খুব ভালো",
  "অনেক উপকার",
  "khub bhalo",
  "dhonnobad",
  "shukriya",
];

export function detectPositiveClosing(text: string): boolean {
  const lower = (text || "").toLowerCase();
  return POSITIVE_CLOSING_PATTERNS.some((p) => lower.includes(p));
}

/** Strong negative / unresolved markers that mark a turn negative on
 *  their own, however the message is padded. The guardrails sentiment
 *  scorer is a keyword COUNTER: enough praise words ("thank you, great,
 *  excellent, love it…") arithmetically cancel genuine anger, and it
 *  has no Bengali vocabulary at all — so a praise-padded complaint, or
 *  any unhappy Bengali message that politely opens with thanks, scored
 *  "positive"/"neutral" and the review ask fired on exactly the
 *  interactions the owner banned it from (attack-test 2026-10-21,
 *  findings F-1/F-2). These substrings are unambiguous: a genuinely
 *  happy closing never contains them. */
const STRONG_NEGATIVE_PATTERNS: readonly string[] = [
  // English — strong negative words (single occurrence is decisive)
  "terrible",
  "worst",
  "awful",
  "horrible",
  "disgusting",
  "unacceptable",
  "furious",
  "angry",
  "frustrated",
  "annoyed",
  "disappointed",
  "not happy",
  "not satisfied",
  // English — explicit "still unresolved" statements
  "not fixed",
  "nothing is fixed",
  "not been fixed",
  "not resolved",
  "not solved",
  "unresolved",
  "still broken",
  "still not working",
  "still there",
  "nobody has resolved",
  "no one has resolved",
  "problem is still",
  "issue is still",
  // Bengali (script + common romanised forms) — the sentiment scorer
  // has no Bengali patterns, so without these every unhappy Bengali
  // message read as neutral.
  "হতাশ",
  "অসন্তুষ্ট",
  "সন্তুষ্ট না",
  "খুব খারাপ",
  "খুব বাজে",
  "বাজে সেবা",
  "সেবা খারাপ",
  "সমাধান হয়নি",
  "সমাধান পাইনি",
  "এখনো পাইনি",
  "মোটেও ভালো না",
  "ভালো না",
  "বিরক্ত",
  "khub kharap",
  "bhalo na",
  "valo na",
];

/** A turn is "negative" when the customer's latest message reads angry /
 *  frustrated (guardrails sentiment) OR carries a strong negative /
 *  unresolved marker — an ask must never follow it. */
export function isNegativeMessage(text: string): boolean {
  const lower = (text || "").toLowerCase();
  if (STRONG_NEGATIVE_PATTERNS.some((p) => lower.includes(p))) return true;
  const { sentiment } = analyzeSentiment(text || "");
  return sentiment === "negative" || sentiment === "frustrated";
}

export interface ReviewAskSignals {
  enabled: boolean;
  /** Resolved review link; null/empty = nowhere real to send them. */
  reviewLink: string | null;
  /** A take_order tool call succeeded during this turn. */
  orderTaken: boolean;
  /** The customer's latest message is a clearly positive closing. */
  positiveClosing: boolean;
  /** Conversation satisfaction rating, when one exists (1–5). */
  satisfaction: number | null;
  /** Latest customer message is negative/frustrated. */
  negative: boolean;
  /** The conversation is escalated / was flagged for human approval. */
  escalated: boolean;
  /** When this customer was last asked (any conversation), if ever. */
  lastAskedAt: Date | null;
  now: Date;
}

export type ReviewAskDecision =
  | { ask: true; trigger: "order_completed" | "positive_closing" | "high_satisfaction" }
  | { ask: false; reason: "disabled" | "no_link" | "negative_or_escalated" | "capped" | "no_trigger" };

/** Pure decision — the single place the hard rules live:
 *  never when disabled, never without a real link, NEVER after a
 *  negative/unresolved/escalated interaction, at most once per customer
 *  per REVIEW_ASK_MIN_INTERVAL_DAYS, and only on a genuine success
 *  signal (order completed / clearly positive closing / satisfaction
 *  rating of 4+). */
export function evaluateReviewAsk(s: ReviewAskSignals): ReviewAskDecision {
  if (!s.enabled) return { ask: false, reason: "disabled" };
  if (!s.reviewLink) return { ask: false, reason: "no_link" };
  if (s.negative || s.escalated) return { ask: false, reason: "negative_or_escalated" };
  if (s.lastAskedAt) {
    const elapsedMs = s.now.getTime() - s.lastAskedAt.getTime();
    if (elapsedMs < REVIEW_ASK_MIN_INTERVAL_DAYS * 24 * 60 * 60 * 1000) {
      return { ask: false, reason: "capped" };
    }
  }
  if (s.orderTaken) return { ask: true, trigger: "order_completed" };
  if (s.positiveClosing) return { ask: true, trigger: "positive_closing" };
  if (s.satisfaction !== null && s.satisfaction >= 4) {
    return { ask: true, trigger: "high_satisfaction" };
  }
  return { ask: false, reason: "no_trigger" };
}

/** The business's REAL review destination, from its own records only:
 *  1) the review link the business itself set in Settings (`reviewUrl`);
 *  2) its primary website — the first entry of its website list (the
 *     legacy `websiteUrl` is kept in sync with that entry), else the
 *     legacy websiteUrl alone.
 *  Null when the business has recorded neither — then no ask is made:
 *  a customer is never sent to an invented destination. */
export function resolveReviewLink(
  business: {
    websiteUrl?: string | null;
    websites?: Array<{ url?: string | null }> | null;
  } | null,
  behaviour: BehaviourSettings
): string | null {
  if (behaviour.reviewUrl) return behaviour.reviewUrl;
  const first = business?.websites?.find(
    (w) => typeof w?.url === "string" && w.url.trim() !== ""
  );
  if (first?.url) return first.url.trim();
  const legacy = business?.websiteUrl?.trim();
  return legacy ? legacy : null;
}

/** The ask itself (appended to the agent's reply when it fires). */
export function reviewAskText(
  lang: BehaviourLang,
  businessName: string,
  link: string
): string {
  return lang === "bn"
    ? `${businessName}-কে বেছে নেওয়ার জন্য ধন্যবাদ! আমাদের সেবায় খুশি হয়ে থাকলে একটি ছোট্ট রিভিউ দিয়ে জানালে আমরা খুব উপকৃত হব: ${link}`
    : `Thank you for choosing ${businessName}! If you're happy with our service, we'd really appreciate a short review: ${link}`;
}

/** Stable per-customer key for the ask cap: the platform customer id
 *  when the conversation is linked to one, else the conversation's
 *  contact (phone / email / channel handle). Scoped to the business by
 *  the tenant data layer — this key never crosses tenants. */
/** Canonicalise a contact for cap keying (attack-test 2026-10-21,
 *  finding F-3): the previous key was the raw contact lowercased, so
 *  the SAME phone written "+8801712345678", "01712345678" or
 *  "+880 1712-345678" produced three different keys and the 30-day
 *  cap reset on a reformat. Phone-shaped contacts collapse to digits
 *  with the Bangladeshi local trunk form (01…) normalised to the
 *  international form (8801…) that channel handlers record; anything
 *  else (emails, channel handles, visitor ids) is trimmed/lowercased
 *  as before. */
export function normalizeContactKey(raw: string): string {
  const t = (raw || "").trim().toLowerCase();
  if (/^\+?[\d\s\-()]+$/.test(t)) {
    const digits = t.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("01")) {
      return `880${digits.slice(1)}`;
    }
    if (digits.length >= 7) return digits;
  }
  return t;
}

export function customerKeyFor(conversation: {
  customerId?: string | null;
  customerContact?: string | null;
}): string {
  if (conversation.customerId) return `cust:${conversation.customerId}`;
  return `contact:${normalizeContactKey(conversation.customerContact || "")}`;
}

/**
 * Engine hook: decide + append + record a review ask for a finished
 * turn. Fail-soft by design — any failure returns the agent's response
 * untouched; a review ask must never break a customer reply.
 */
export async function maybeAppendReviewAsk(args: {
  conversation: {
    id: string;
    customerId?: string | null;
    customerContact?: string | null;
    satisfaction?: number | null;
    status?: string | null;
  };
  response: string;
  customerMessage: string;
  orderTaken: boolean;
  escalated: boolean;
  behaviour: BehaviourSettings;
  business: { websiteUrl?: string | null; websites?: Array<{ url?: string | null }> | null } | null;
  businessName: string;
  lang: BehaviourLang;
}): Promise<string> {
  try {
    if (!args.behaviour.reviewRequestsEnabled) return args.response;
    const link = resolveReviewLink(args.business, args.behaviour);
    if (!link) return args.response;

    const key = customerKeyFor(args.conversation);
    const last = await prisma.reviewAsk.findFirst({
      where: { customerKey: key },
      orderBy: { askedAt: "desc" },
    });

    const decision = evaluateReviewAsk({
      enabled: true,
      reviewLink: link,
      orderTaken: args.orderTaken,
      positiveClosing: detectPositiveClosing(args.customerMessage),
      satisfaction:
        typeof args.conversation.satisfaction === "number"
          ? args.conversation.satisfaction
          : null,
      negative: isNegativeMessage(args.customerMessage),
      escalated: args.escalated || args.conversation.status === "escalated",
      lastAskedAt: last?.askedAt ? new Date(last.askedAt) : null,
      now: new Date(),
    });
    if (!decision.ask) return args.response;

    // Team J owner gate (block-only): the generic ask is appended to
    // an ordinary reply, so the review doctrine above still decides
    // FIRST (combineWithDoctrine order — doctrine reasons stand).
    // On top of it, an owner-disabled reviewAsks family, a master or
    // "generic"-scope pause suppresses the ask: the reply goes out
    // untouched and no reviewAsk record is created. No override text
    // is applied here — the ask text below is unchanged. A settings
    // read failure or a cross-tenant doc suppresses the ASK only
    // (fail-closed for the ask, fail-soft for the reply itself).
    try {
      const askSettings = await prisma.settings.findFirst();
      const askBusinessId = getBusinessId();
      const askDocBusinessId =
        askSettings &&
        typeof (askSettings as { businessId?: unknown }).businessId === "string"
          ? ((askSettings as { businessId: string }).businessId as string)
          : null;
      const askControls =
        askSettings &&
        (askSettings as { messageControls?: unknown }).messageControls !==
          undefined
          ? normalizeControls(
              (askSettings as { messageControls?: unknown }).messageControls
            )
          : null;
      const askGate = resolveMessageControl({
        family: "reviewAsks",
        scope: "generic",
        businessId: askBusinessId ?? "",
        controlBusinessId: askDocBusinessId,
        controls: askControls,
        record: null,
        text: reviewAskText(args.lang, args.businessName, link),
        nowMs: Date.now(),
      });
      if (!askGate.allowed) {
        logger.warn("[behaviour] review ask suppressed by owner gate", {
          conversationId: args.conversation.id,
          reason: askGate.reason,
        });
        return args.response;
      }
    } catch (err) {
      logger.warn("[behaviour] review ask owner-gate read failed; ask suppressed", {
        conversationId: args.conversation.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      return args.response;
    }

    await prisma.reviewAsk.create({
      data: withBusinessId({
        customerKey: key,
        conversationId: args.conversation.id,
        trigger: decision.trigger,
        askedAt: new Date(),
      }),
    });

    const ask = reviewAskText(args.lang, args.businessName, link);
    return args.response.trim() ? `${args.response}\n\n${ask}` : ask;
  } catch (err) {
    logger.warn("[behaviour] review ask failed (reply unaffected)", {
      conversationId: args.conversation.id,
      reason: err instanceof Error ? err.message : String(err),
    });
    return args.response;
  }
}

// ---------------------------------------------------------------------------
// 4. Follow-up message templates (proactive touches)
// ---------------------------------------------------------------------------

/** Post-order check-in, scheduled by the engine when an order is taken
 *  and delivered by lib/followups.ts through the conversation's channel. */
export function orderCheckInText(
  lang: BehaviourLang,
  businessName: string,
  customerName: string | null,
  orderRef: string
): string {
  const name =
    customerName && customerName !== "Unknown" ? ` ${customerName}` : "";
  const ref = orderRef ? ` (${orderRef})` : "";
  return lang === "bn"
    ? `হ্যালো${name}, আমি ${businessName} থেকে বলছি। আপনার অর্ডার${ref} আমাদের কাছে পৌঁছেছে — সবকিছু ঠিকঠাক আছে কিনা জানতে এই বার্তা। যেকোনো প্রয়োজনে এখানেই উত্তর দিলেই আমরা সাথে সাথে সাহায্য করব।`
    : `Hello${name}, this is ${businessName}. We're checking in about your order${ref} — we hope everything is going well. If you need anything at all, just reply here and we'll help right away.`;
}

/** Dropped-conversation revival: one polite nudge when a conversation
 *  went quiet with the agent's message last. Sent at most once per
 *  conversation (enforced by the follow-up processor). */
export function droppedRevivalText(
  lang: BehaviourLang,
  businessName: string,
  customerName: string | null
): string {
  const name =
    customerName && customerName !== "Unknown" ? ` ${customerName}` : "";
  return lang === "bn"
    ? `হ্যালো${name}, আমি ${businessName} থেকে বলছি। আমাদের আগের কথোপকথনটা থেমে গিয়েছিল — এখনও কোনো সাহায্য লাগলে বা কোনো প্রশ্ন থাকলে এখানেই উত্তর দিন, আমরা ঠিক সেখান থেকেই আবার সাহায্য করব।`
    : `Hello${name}, this is ${businessName}. Our conversation paused a little while ago — if you still need help or have any question, just reply here and we'll pick up right where we left off.`;
}

/**
 * Engine hook: when an order is taken, schedule the post-order check-in
 * follow-up (delivered later by the follow-up processor through the
 * conversation's own channel). Fail-soft — a scheduling failure never
 * affects the customer's reply or their order.
 */
export async function scheduleOrderCheckIn(args: {
  conversationId: string;
  customerName: string | null;
  orderRef: string;
  behaviour: BehaviourSettings;
  businessName: string;
  lang: BehaviourLang;
}): Promise<void> {
  if (!args.behaviour.followUpsEnabled) return;
  try {
    const dueAt = new Date(
      Date.now() + args.behaviour.followUpOrderCheckInHours * 60 * 60 * 1000
    );
    await prisma.followUp.create({
      data: withBusinessId({
        conversationId: args.conversationId,
        message: orderCheckInText(
          args.lang,
          args.businessName,
          args.customerName,
          args.orderRef
        ),
        dueAt,
        status: "pending",
        kind: "order_checkin",
      }),
    });
  } catch (err) {
    logger.warn("[behaviour] order check-in scheduling failed", {
      conversationId: args.conversationId,
      businessId: getBusinessId(),
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Human handoff (owner addition 2026-10-21 12:24, doctrine-gated
// 2026-11-02)
//
// When the customer explicitly asks for a human / a support ticket,
// the agent must STOP being a bot in that thread: recognise it,
// create the support ticket itself (via the platform's create_ticket
// tool), tell the customer plainly that a human agent will continue
// in THIS SAME conversation, and yield — the platform's handoff state
// (conversation.aiEnabled = false, the same state the dashboard's
// human-takeover uses) makes every later message store silently for
// the human team. When the customer is in a serious/important problem
// WITHOUT an explicit request, the agent instead PROPOSES a ticket
// first and hands off only if the visitor accepts (see the engine
// handoff block). Detection is deterministic engine code over the
// customer's actual words, never a model guess.
// ---------------------------------------------------------------------------

export type HandoffKind = "explicit_human" | "ticket_request" | "serious_problem";

export interface HandoffDetection {
  needed: boolean;
  kind: HandoffKind | null;
  /** What matched (pattern or approval keyword) — recorded on the
   *  conversation + ticket so the human team sees why it was handed off. */
  matched: string | null;
}

/** The customer explicitly asks for a human being. Multi-word phrases
 *  only — a passing mention of people must never trigger a handoff. */
const HUMAN_REQUEST_PATTERNS: readonly string[] = [
  // English
  "talk to a human",
  "speak to a human",
  "talk to a person",
  "speak to a person",
  "talk to someone",
  "speak to someone",
  "talk to an agent",
  "speak to an agent",
  "talk to your team",
  "speak to your team",
  "real person",
  "human agent",
  "human please",
  "human support",
  "connect me to a",
  "transfer me to",
  "call me back",
  // Bengali (script + common romanised forms)
  "মানুষের সাথে কথা",
  "মানুষের সঙ্গে কথা",
  "মানব প্রতিনিধি",
  "প্রতিনিধির সাথে কথা",
  "কর্মকর্তার সাথে কথা",
  "কোনো মানুষের সাথে",
  "মানুষ চাই",
  "manusher sathe kotha",
  "ekjon manush",
  "manush chai",
];

/** The customer explicitly asks for a support ticket / to complain
 *  formally. */
const TICKET_REQUEST_PATTERNS: readonly string[] = [
  "support ticket",
  "open a ticket",
  "create a ticket",
  "raise a ticket",
  "file a ticket",
  "ticket please",
  "file a complaint",
  "lodge a complaint",
  "সাপোর্ট টিকিট",
  "টিকিট খুলুন",
  "টিকিট করুন",
  "অভিযোগ করতে চাই",
  "অভিযোগ জানাতে চাই",
];

/** Serious/important problems in the customer's own words (the
 *  platform's human-approval keywords refund/cancellation/legal are
 *  layered on top in detectHandoff). */
const SERIOUS_PROBLEM_PATTERNS: readonly string[] = [
  // English
  "fraud",
  "scam",
  "cheated",
  "stolen",
  "cancel my order",
  "cancel the order",
  "cancel my booking",
  "charged twice",
  "double charged",
  "charged double",
  "deducted twice",
  "money deducted",
  "payment deducted",
  "took my money",
  "never received",
  "not delivered",
  "didn't receive",
  "did not receive",
  "wrong product",
  "wrong item",
  "damaged product",
  "product is damaged",
  "broken product",
  "expired product",
  "legal action",
  "my lawyer",
  "police",
  "emergency",
  // Bengali (script + common romanised forms)
  "প্রতারণা",
  "প্রতারিত",
  "টাকা কেটে নিয়েছে",
  "ডাবল চার্জ",
  "দুইবার চার্জ",
  "পণ্য পাইনি",
  "অর্ডার পাইনি",
  "ভাঙা পণ্য",
  "নষ্ট পণ্য",
  "আইনি ব্যবস্থা",
  "পুলিশ",
  "জরুরি",
  "অর্ডার বাতিল",
  "বাতিল করতে চাই",
];

/** Human-approval keywords that negotiate rather than escalate to a
 *  full handoff on their own: a discount ask is normal agent work
 *  (retention), and compensation claims surface inside complaints that
 *  carry their own serious signals. They still get the platform's
 *  existing metadata escalation in the engine — just not a handoff. */
const NEGOTIATION_ONLY_APPROVAL_KEYWORDS: ReadonlySet<string> = new Set([
  "discount",
  "compensation",
]);

function matchAny(lower: string, patterns: readonly string[]): string | null {
  for (const p of patterns) {
    if (lower.includes(p)) return p;
  }
  return null;
}

/** Pure detector over the customer's message. Order matters: an
 *  explicit human ask outranks a ticket ask, which outranks a serious
 *  problem (the ticket text/reason records the strongest signal). */
export function detectHandoff(message: string): HandoffDetection {
  const lower = (message || "").toLowerCase();

  const human = matchAny(lower, HUMAN_REQUEST_PATTERNS);
  if (human) return { needed: true, kind: "explicit_human", matched: human };

  const ticket = matchAny(lower, TICKET_REQUEST_PATTERNS);
  if (ticket) return { needed: true, kind: "ticket_request", matched: ticket };

  const approval = requiresHumanApproval(message || "");
  if (approval.required && approval.reason && !NEGOTIATION_ONLY_APPROVAL_KEYWORDS.has(approval.reason)) {
    return { needed: true, kind: "serious_problem", matched: `approval:${approval.reason}` };
  }

  const serious = matchAny(lower, SERIOUS_PROBLEM_PATTERNS);
  if (serious) return { needed: true, kind: "serious_problem", matched: serious };

  return { needed: false, kind: null, matched: null };
}

function handoffTicketTitle(kind: HandoffKind): string {
  switch (kind) {
    case "explicit_human":
      return "Customer asked for a human agent";
    case "ticket_request":
      return "Customer asked for a support ticket";
    case "serious_problem":
      return "Serious problem — customer needs a human agent";
  }
}

/** The plain statement the customer receives on the handoff turn: a
 *  human agent will continue in THIS SAME conversation. `reference` is
 *  the ticket's readable recording reference (see ticketReference) —
 *  never a raw UUID. */
export function handoffText(lang: BehaviourLang, reference: string | null): string {
  const ref = reference || null;
  if (lang === "bn") {
    return ref
      ? `আপনাকে এই সমস্যায় পড়তে হলো বলে দুঃখিত। আমি আমাদের টিমের জন্য একটি সাপোর্ট টিকিট তৈরি করেছি (রেফারেন্স ${ref}) এবং এই কথোপকথনটি একজন মানব এজেন্টের কাছে হস্তান্তর করেছি। তিনি এই একই কথোপকথনেই আপনার সাথে কথা চালিয়ে যাবেন — আপনাকে কিছু আবার বলতে হবে না, আমাদের পুরো কথোপকথন তিনি দেখতে পাবেন। আপনার ধৈর্যের জন্য ধন্যবাদ।`
      : `আপনাকে এই সমস্যায় পড়তে হলো বলে দুঃখিত। আমি বিষয়টি আমাদের টিমের কাছে পাঠিয়ে দিয়েছি এবং এই কথোপকথনটি একজন মানব এজেন্টের কাছে হস্তান্তর করেছি। তিনি এই একই কথোপকথনেই আপনার সাথে কথা চালিয়ে যাবেন — আপনাকে কিছু আবার বলতে হবে না, আমাদের পুরো কথোপকথন তিনি দেখতে পাবেন। আপনার ধৈর্যের জন্য ধন্যবাদ।`;
  }
  return ref
    ? `I'm sorry you're dealing with this. I've created a support ticket for our team (reference ${ref}) and handed this conversation over to a human agent. They will continue with you right here in this same conversation — you don't need to repeat anything, they can see our full conversation. Thank you for your patience.`
    : `I'm sorry you're dealing with this. I've raised this with our team and handed this conversation over to a human agent. They will continue with you right here in this same conversation — you don't need to repeat anything, they can see our full conversation. Thank you for your patience.`;
}

/** Pending ticket proposal after a serious-problem detection (owner rule
 *  2026-11-02): the agent proposed a ticket and is waiting for the
 *  visitor's answer. Stored on conversation.metadata.ticketProposal. A
 *  proposal NEVER creates a ticket and NEVER flips aiEnabled — only an
 *  explicit request, or the visitor's acceptance after a proposal, may
 *  call performHandoff. Any other next message clears the proposal. */
export interface TicketProposal {
  kind: "serious_problem" | "provider_failure";
  matched: string | null;
  proposedAt: string;
}

/** Visitor acceptance of a proposed ticket. English short answers use
 *  word boundaries (so "yesterday" never matches "yes"); Bengali phrases
 *  match by inclusion. A bare "ticket" / "টিকিট" after a proposal also
 *  counts as acceptance. */
export function detectTicketAcceptance(message: string): boolean {
  const text = (message || "").trim().toLowerCase();
  if (!text) return false;
  if (text === "ticket" || text === "টিকিট") return true;
  if (/^(yes|yeah|yep|ok|okay|sure|please|haan)\b/.test(text)) return true;
  if (/\b(please do|go ahead|create it|make it|yes please|please create|do it)\b/.test(text)) return true;
  const bn = [
    "হ্যাঁ",
    "ঠিক আছে",
    "করে দিন",
    "করে দাও",
    "করে দেন",
    "টিকিট করুন",
    "টিকিট খুলুন",
    "টিকিট করে দিন",
    "বানিয়ে দিন",
    "খুলে দিন",
  ];
  for (const p of bn) if (text.includes(p)) return true;
  return false;
}

/** Language-aware ticket-proposal wording (visitor's own language). */
export function ticketProposalText(lang: BehaviourLang): string {
  if (lang === "bn") {
    return "আপনি চাইলে আমি আপনার জন্য একটি সাপোর্ট টিকিট করে দিতে পারি, আর আমাদের টিমের একজন সদস্য আপনার সাথে যোগাযোগ করবেন। আপনি কি চান আমি টিকিটটি করে দিই?";
  }
  return "If you want, I can make a support ticket for you, and a member of our team will contact you. Would you like me to create the ticket?";
}

/** Readable, site-prefixed ticket recording reference — NOT a raw UUID.
 *  SITE = the first segment of the business slug (or name) after
 *  stripping a leading "ride-bangla" (with or without its trailing
 *  hyphen — the bare slug "ride-bangla" itself strips to empty and
 *  falls back to "RB"; a plain "ride-bangla-" prefix strip would
 *  wrongly yield "RIDE" for the Main business) — lowercase,
 *  non-alphanumerics become hyphens, first hyphen segment, uppercased,
 *  max 8 chars, fallback "RB"; suffix = first 8 chars of the ticket
 *  id, uppercased.
 *  Distinct per ticket (the underlying ticket id is unique). The
 *  reference is id-derived by construction: it is computed AFTER the
 *  ticket exists, never before, and stored on the ticket row (see
 *  performHandoff's follow-up update) — never computed on read.
 *  Examples: "ride-bangla-it-team-45465d" -> IT;
 *  "ride-bangla-studio-cbaa59" -> STUDIO; "ride-bangla-tools-96de70"
 *  -> TOOLS; "ride-bangla" -> RB; "Ride Bangla Tools" -> TOOLS. */
export function ticketReference(
  slugOrName: string | null | undefined,
  ticketId: string
): string {
  const normalized = (slugOrName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const stripped = normalized.replace(/^ride-bangla-?/, "");
  const first = stripped.split("-")[0] || "";
  const site =
    first.replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 8) || "RB";
  return `${site}-${ticketId.slice(0, 8).toUpperCase()}`;
}

/**
 * Execute the handoff: create the support ticket through the
 * platform's own create_ticket tool (reusing the conversation's open
 * ticket when one already exists — never a duplicate), then flip the
 * conversation into the platform's handoff state (aiEnabled=false +
 * status escalated + handoff metadata) so the bot yields and a human
 * continues in the same thread. The ticket record carries the visitor's
 * FULL message (never truncated), explicit source attribution (business
 * + channel) and the readable recording reference. A pending ticket
 * proposal is cleared here: reaching performHandoff means the ticket
 * was requested or its proposal was accepted.
 * Returns the ticket id + reference (reference null only when ticket
 * creation itself failed — the state flip still happens: the
 * conversation IS the human channel, the ticket is its tracking
 * artefact, and a failed artefact must not strand the customer with a
 * bot). Throws only when the state flip itself fails, so the caller
 * can fall back to a normal reply rather than stranding the thread.
 */
export async function performHandoff(args: {
  conversation: { id: string; metadata?: unknown };
  customerMessage: string;
  detection: { kind: HandoffKind; matched: string | null };
}): Promise<{ ticketId: string | null; reference: string | null }> {
  const conversationId = args.conversation.id;
  const { kind, matched } = args.detection;

  // Source attribution + reference inputs (best-effort: a lookup
  // failure must never block the handoff itself).
  let businessSlug: string | null = null;
  let businessName = "";
  let channel = "";
  try {
    const conv = (await prisma.conversation.findUnique({
      where: { id: conversationId },
    })) as unknown as Record<string, unknown> | null;
    channel = typeof conv?.channel === "string" ? (conv.channel as string) : "";
    const businessId =
      typeof conv?.businessId === "string" ? (conv.businessId as string) : null;
    if (businessId) {
      const biz = (await prisma.business.findUnique({
        where: { id: businessId },
      })) as unknown as Record<string, unknown> | null;
      businessSlug =
        typeof biz?.slug === "string" ? (biz.slug as string) : null;
      businessName =
        typeof biz?.name === "string"
          ? (biz.name as string)
          : businessSlug || "";
    }
  } catch {
    /* attribution is best-effort */
  }

  let ticketId: string | null = null;
  try {
    const existing = await prisma.ticket.findFirst({
      where: { conversationId, status: "open" },
      orderBy: { createdAt: "desc" },
    });
    if (existing?.id) {
      ticketId = existing.id;
    } else {
      const raw = await executeToolCall(
        "create_ticket",
        {
          title: handoffTicketTitle(kind),
          description:
            `The agent handed this conversation to the human team (${kind}` +
            (matched ? `: "${matched}"` : "") +
            `). Source: ${businessName || "this business"}${
              channel ? ` via ${channel}` : ""
            }. ` +
            `Customer's FULL message: "${args.customerMessage}" ` +
            `The full conversation is attached to this ticket — please continue with the customer in the same conversation.`,
          priority: "high",
        },
        conversationId
      );
      try {
        const parsed = JSON.parse(raw) as { success?: unknown; ticketId?: unknown };
        if (parsed.success === true && typeof parsed.ticketId === "string") {
          ticketId = parsed.ticketId;
        }
      } catch {
        /* tool returned non-JSON: ticket state unknown, handoff proceeds */
      }
    }
  } catch (err) {
    logger.warn("[behaviour] handoff ticket creation failed (handoff proceeds)", {
      conversationId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // Recording reference (id-derived, stored-only — never computed on
  // read): a reused ticket keeps its stored reference when one exists;
  // otherwise it is computed from the ticket id + business slug and
  // stored by the follow-up update below, in the SAME update call that
  // appends it to the description. Pre-change tickets without a stored
  // reference keep showing "--" in the queue until reused. The
  // visitor's reference NEVER depends on this read: it is computed
  // from the ticket id up front, so an unreadable row (ambient /
  // business mismatch, or a caller that cannot read the row back)
  // still leaves the visitor with a recording number, as doctrine
  // rule 5 requires. A stored reference, when the row IS readable,
  // wins over the computed one. The record update itself is
  // best-effort: a failed update must not fail the handoff, and the
  // description is never overwritten with a bare reference line.
  let reference: string | null = ticketId
    ? ticketReference(businessSlug, ticketId)
    : null;
  if (ticketId && reference) {
    try {
      const current = (await prisma.ticket.findUnique({
        where: { id: ticketId },
      })) as unknown as Record<string, unknown> | null;
      if (current) {
        const storedRef =
          typeof current.reference === "string" ? current.reference : null;
        if (storedRef) reference = storedRef;
        const curDesc =
          typeof current.description === "string"
            ? (current.description as string)
            : "";
        // One update call: reference ALWAYS (when it exists), the
        // description line appended only when not already present.
        await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            reference,
            ...(!curDesc.includes(reference)
              ? {
                  description: `${curDesc}\nRecording reference: ${reference}`,
                }
              : {}),
          },
        });
      }
    } catch {
      /* reference already reaches the visitor; record update is best-effort */
    }
  }

  const baseMetadata =
    args.conversation.metadata &&
    typeof args.conversation.metadata === "object" &&
    !Array.isArray(args.conversation.metadata)
      ? (args.conversation.metadata as Record<string, unknown>)
      : {};
  const restMetadata = { ...baseMetadata };
  delete restMetadata.ticketProposal;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      aiEnabled: false,
      status: "escalated",
      metadata: {
        ...restMetadata,
        handoff: true,
        handoffReason: matched ? `${kind}:${matched}` : kind,
        ticketId,
        reference,
        handedOffAt: new Date().toISOString(),
      },
    },
  });

  logger.info("[behaviour] conversation handed off to human team", {
    conversationId,
    kind,
    matched,
    ticketId,
    reference,
  });
  return { ticketId, reference };
}

