/**
 * Hot/Warm follow-up classification, platform-window discipline and
 * broadcast discipline — LEG F (booking batch), STAGED ONLY.
 *
 * Pure, dependency-free module. No database, no network, no channel
 * sender, no copy generation: every user-facing reminder/broadcast text
 * is supplied by the caller (owner-approved wording), never invented
 * here. This module decides ONLY whether a follow-up or a broadcast
 * may be created / delivered, and why not.
 *
 * Doctrines enforced here (from the task, not from any competitor):
 * - Per-surface identity is untouched: nothing here names a business.
 * - The agent NEVER confirms an order: ordering is not a function here;
 *   "has ordered" is only a SUPPRESSION signal (a reminder must never
 *   chase a customer who already ordered).
 * - The agent NEVER quotes fares: no price, charge or currency value is
 *   produced here. classifyIntent only records THAT a price was
 *   mentioned; it never reads, stores or repeats a price figure.
 * - Consent/window discipline, NOT prospecting: this module can only
 *   address an existing conversation. There is no import path, no
 *   phone-number input and no cold list anywhere in this leg, and it
 *   shares no store or code path with the outbound client-finding
 *   system. Any recipient without an existing conversation is rejected
 *   as cold outreach (see evaluateBroadcastRecipient).
 * - Patterns only: nothing here copies a competitor's branding, assets,
 *   UI text, prompts or code. The 24h/23h windows are platform rules
 *   (WhatsApp/Meta), not a competitor's feature.
 */

// ---------------------------------------------------------------------------
// 1. Hot / Warm classification
// ---------------------------------------------------------------------------

export type IntentClass = "none" | "warm" | "hot";

/**
 * Explicit intent signals. The classifier takes signals, not raw text,
 * so the classification rule itself is deterministic and testable.
 * extractIntentSignals (below) is one conservative signal extractor;
 * a future extractor (e.g. model-labelled intent) may feed the same
 * signals without changing the rule.
 */
export interface IntentSignals {
  /** The customer named a specific product/service from the catalog. */
  mentionsSpecificProduct: boolean;
  /** The customer asked about a price. The figure itself is NOT kept. */
  mentionsPrice: boolean;
  /** The customer asked about delivery (charge, area, timing). */
  mentionsDelivery: boolean;
  /** The customer discussed a quantity they would take. */
  mentionsQuantity: boolean;
  /** The customer discussed payment (method, advance, COD, wallet). */
  mentionsPayment: boolean;
  /** The customer gave their delivery address. */
  gaveAddress: boolean;
  /** The customer said they will order / buy / book. */
  saysWillOrder: boolean;
}

export interface ClassifyResult {
  intent: IntentClass;
  /** Human-readable audit trail of which rule fired (not user copy). */
  reasons: string[];
}

/**
 * Task rule, applied literally:
 * - general question (no signal at all) -> "none": NO follow-up.
 * - specific product / price -> "warm": exactly ONE reminder.
 * - price + delivery/quantity/payment, an address, or "will order"
 *   -> "hot": follow-up reminders (count is business-configurable,
 *   see planClassifiedFollowUps — no firm count is invented here).
 *
 * Interpretation decisions, stated so they can be corrected:
 * (a) "price + delivery/quantity/payment" is read as price TOGETHER
 *     with delivery or quantity. Payment alone is ALSO hot: naming a
 *     payment method is buying intent on its own, not a general
 *     question. Delivery alone or quantity alone (no price) is warm,
 *     not hot: "do you deliver here?" / "how many are in a pack?"
 *     without a price is a product question, not an order signal.
 * (b) An address or "will order" is hot even without a price.
 */
export function classifyIntent(s: IntentSignals): ClassifyResult {
  if (s.gaveAddress) {
    return { intent: "hot", reasons: ["gave_address"] };
  }
  if (s.saysWillOrder) {
    return { intent: "hot", reasons: ["says_will_order"] };
  }
  if (s.mentionsPayment) {
    return { intent: "hot", reasons: ["mentions_payment"] };
  }
  if (s.mentionsPrice && (s.mentionsDelivery || s.mentionsQuantity)) {
    return {
      intent: "hot",
      reasons: ["mentions_price_and_delivery_or_quantity"],
    };
  }
  if (
    s.mentionsSpecificProduct ||
    s.mentionsPrice ||
    s.mentionsDelivery ||
    s.mentionsQuantity
  ) {
    return { intent: "warm", reasons: ["specific_product_or_price_question"] };
  }
  return { intent: "none", reasons: ["general_question_no_buying_signal"] };
}

// ---------------------------------------------------------------------------
// 2. Conservative keyword signal extractor (English / Bangla / Banglish)
// ---------------------------------------------------------------------------

function containsAny(text: string, phrases: string[]): string[] {
  const hits: string[] = [];
  for (const p of phrases) {
    if (text.includes(p)) hits.push(p);
  }
  return hits;
}

/**
 * Conservative extractor: it only reports signals it can see as explicit
 * words/phrases. It never guesses a product (product names must be
 * supplied by the caller from the tenant catalog), never reads a price
 * figure, and a bare ambiguous word is deliberately NOT a signal:
 * e.g. "koto" alone (how many / how much / how long) is not a price
 * signal — "koto taka" is. When the extractor is unsure, it reports
 * nothing and the classifier returns "none": a missed reminder is
 * always safer than a nagging message the customer never invited.
 * The model may override these signals with its own intent judgement
 * at the call site; the classifier rule above does not change.
 */
export function extractIntentSignals(
  text: string,
  productNames: string[] = []
): { signals: IntentSignals; matched: string[] } {
  const t = ` ${text.toLowerCase()} `;
  const matched: string[] = [];
  const push = (hits: string[]) => {
    for (const h of hits) matched.push(h);
  };

  push(containsAny(t, ["price", "dam ", "daam", "koto taka", "taka", "৳", "$", "cost", "rate "]));
  const mentionsPrice = matched.length > 0;

  const deliveryHits = containsAny(t, [
    "delivery",
    "pathano",
    "courier",
    "home delivery",
    "delivery charge",
  ]);
  push(deliveryHits);

  const quantityHits = containsAny(t, ["koyta", "koy ti", "quantity", "pieces", "piece"]);
  const quantityNumber = /\b\d+\s*(ta|ti|pcs|packet|kg)\b/.test(t);
  if (quantityNumber) quantityHits.push("number+unit");
  push(quantityHits);

  const paymentHits = containsAny(t, [
    "bkash",
    "nagad",
    "rocket",
    "cash on delivery",
    "cod ",
    "payment",
    "advance",
    "pay korbo",
    "payment korbo",
  ]);
  push(paymentHits);

  const addressHits = containsAny(t, [
    "address",
    "thikana",
    "amar address",
    "location pathabo",
    "location dichhi",
  ]);
  push(addressHits);

  const willOrderHits = containsAny(t, [
    "order korbo",
    "order korchi",
    "order dibo",
    "order korte chai",
    "nibo",
    "kinbo",
    "book korbo",
    "confirm korbo",
    "i will order",
    "i want to order",
    "place an order",
  ]);
  push(willOrderHits);

  let mentionsSpecificProduct = false;
  for (const name of productNames) {
    const n = name.trim().toLowerCase();
    if (n.length >= 3 && t.includes(n)) {
      mentionsSpecificProduct = true;
      matched.push(`product:${name}`);
      break;
    }
  }

  return {
    signals: {
      mentionsSpecificProduct,
      mentionsPrice,
      mentionsDelivery: deliveryHits.length > 0,
      mentionsQuantity: quantityHits.length > 0,
      mentionsPayment: paymentHits.length > 0,
      gaveAddress: addressHits.length > 0,
      saysWillOrder: willOrderHits.length > 0,
    },
    matched,
  };
}

// ---------------------------------------------------------------------------
// 3. Follow-up kinds (existing kinds are untouched)
// ---------------------------------------------------------------------------

export const FOLLOWUP_KINDS = {
  /** Pre-existing (HEAD): dropped-conversation revival, one ever. */
  droppedRevival: "dropped_revival",
  /** Pre-existing (HEAD): post-order check-in. */
  orderCheckin: "order_checkin",
  /** This leg: exactly one reminder for a Warm conversation. */
  warm: "warm_followup",
  /** This leg: configurable reminders for a Hot conversation. */
  hot: "hot_followup",
  /** This leg: one broadcast delivery record per recipient. */
  broadcast: "broadcast",
  /** This leg: the mandatory test-send record for a broadcast text. */
  broadcastTest: "broadcast_test",
} as const;

// ---------------------------------------------------------------------------
// 4. Scheduling plan (creation time — "each reminder goes only once")
// ---------------------------------------------------------------------------

export interface PlannedFollowUp {
  kind: string;
  /** 0-based sequence within this intent's reminder series. */
  sequence: number;
}

export interface FollowUpPlan {
  schedule: PlannedFollowUp[];
  /**
   * Set only when nothing is scheduled for a reason the caller must
   * surface (never silently swallowed): "hot_count_unset" means the
   * business has not configured a Hot reminder count, so NO Hot
   * reminder is scheduled rather than an invented number being used.
   */
  blockedReason?: "hot_count_unset" | "hot_count_zero" | "already_scheduled";
}

/**
 * @param existingKinds kinds already recorded for this conversation
 *   (any status except a record the caller has explicitly cancelled —
 *   the caller filters; a failed record still consumed its slot, so a
 *   failed reminder is never silently re-queued by this planner).
 * @param hotMaxReminders business-configurable Hot count. null/undefined
 *   = NOT CONFIGURED: Hot scheduling is blocked, not defaulted.
 *   This is an OWNER DECISION (see LEG-REPORT): the repo gives no clean
 *   Hot count (the only evidenced count is the dropped-revival "one
 *   ever", which is a different feature and is NOT reused as a Hot
 *   default).
 */
export function planClassifiedFollowUps(args: {
  intent: IntentClass;
  existingKinds: string[];
  hotMaxReminders: number | null | undefined;
}): FollowUpPlan {
  const { intent, existingKinds } = args;
  if (intent === "none") return { schedule: [] };

  if (intent === "warm") {
    if (
      existingKinds.includes(FOLLOWUP_KINDS.warm) ||
      existingKinds.includes(FOLLOWUP_KINDS.hot)
    ) {
      return { schedule: [], blockedReason: "already_scheduled" };
    }
    return { schedule: [{ kind: FOLLOWUP_KINDS.warm, sequence: 0 }] };
  }

  // Hot.
  const max = args.hotMaxReminders;
  if (max === null || max === undefined) {
    return { schedule: [], blockedReason: "hot_count_unset" };
  }
  if (!Number.isFinite(max) || max <= 0) {
    return { schedule: [], blockedReason: "hot_count_zero" };
  }
  const already = existingKinds.filter((k) => k === FOLLOWUP_KINDS.hot).length;
  const schedule: PlannedFollowUp[] = [];
  for (let seq = already; seq < Math.floor(max); seq++) {
    schedule.push({ kind: FOLLOWUP_KINDS.hot, sequence: seq });
  }
  return { schedule };
}

// ---------------------------------------------------------------------------
// 5. Platform windows (hard rules)
// ---------------------------------------------------------------------------

export const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
export const BROADCAST_WINDOW_23H_MS = 23 * 60 * 60 * 1000;

export type WindowOutcome = "allow" | "template_only" | "suppress";

export interface WindowDecision {
  outcome: WindowOutcome;
  reason: string;
}

/**
 * Hard window rules:
 * - Promotions NEVER after 24 hours. Broadcasts are stricter still
 *   (23h eligibility, see evaluateBroadcastRecipient), so a broadcast
 *   can never reach this function past its window.
 * - Instagram: NOTHING after 24 hours — no template fallback, ever.
 * - WhatsApp / Messenger: free-form inside 24h; past 24h only a
 *   platform template may go out (templateConfigured = the business
 *   has a template configured for this purpose). Without a template,
 *   suppress — never send free-form past the window.
 * - Website widget: no push exists; a follow-up is only STORED for the
 *   visitor's next visit, so no platform window applies.
 * - SMS / email / Telegram: no 24h platform window in this model.
 * - Any other channel: fail closed (suppress) — an unknown channel
 *   must never be assumed to be window-free.
 * - lastCustomerMessageAtMs === null on a windowed channel: the window
 *   cannot be proven, so suppress. Never assume recency.
 */
export function decideWindow(args: {
  channel: string;
  lastCustomerMessageAtMs: number | null;
  nowMs: number;
  templateConfigured?: boolean;
}): WindowDecision {
  const { channel, lastCustomerMessageAtMs, nowMs } = args;
  const templateConfigured = args.templateConfigured === true;

  if (channel === "widget") {
    return { outcome: "allow", reason: "widget_store_only" };
  }
  if (channel === "sms" || channel === "email" || channel === "telegram") {
    return { outcome: "allow", reason: "no_platform_window" };
  }
  if (
    channel === "whatsapp" ||
    channel === "messenger" ||
    channel === "instagram"
  ) {
    if (lastCustomerMessageAtMs === null) {
      return { outcome: "suppress", reason: "window_unknown" };
    }
    const ageMs = nowMs - lastCustomerMessageAtMs;
    if (ageMs < 0) {
      // Clock skew / future timestamp: do not trust the window.
      return { outcome: "suppress", reason: "window_unknown" };
    }
    if (ageMs <= WINDOW_24H_MS) {
      return { outcome: "allow", reason: "within_24h_window" };
    }
    // Past 24h.
    if (channel === "instagram") {
      return { outcome: "suppress", reason: "instagram_nothing_after_24h" };
    }
    if (templateConfigured) {
      return { outcome: "template_only", reason: "past_24h_template_only" };
    }
    return { outcome: "suppress", reason: "past_24h_no_template" };
  }
  return { outcome: "suppress", reason: "unknown_channel" };
}

// ---------------------------------------------------------------------------
// 6. Delivery-time suppression (checked on EVERY delivery, not just at
//    creation — a thread can be taken over, or an order placed, after a
//    reminder was scheduled)
// ---------------------------------------------------------------------------

export interface DeliveryGateInput {
  /** false = a human owns the thread (Leg D takeover). */
  aiEnabled: boolean;
  conversationStatus: string;
  /** A non-cancelled order exists on this conversation. */
  hasOrdered: boolean;
  /** The AI judged this reminder unneeded (set at scheduling time). */
  aiDeemsUnneeded: boolean;
  isBlocked: boolean;
  channel: string;
  lastCustomerMessageAtMs: number | null;
  nowMs: number;
  templateConfigured?: boolean;
  /**
   * Kind of the follow-up being delivered. This scopes the sales
   * suppressions so they can never silence a message that is NOT a
   * sales reminder (see decideFollowUpDelivery): order-status pushes
   * (the tracking leg, kind "order_status_update"), post-order
   * check-ins and customer-requested reminders (schedule_followup,
   * which stores NO kind at HEAD) must still deliver after an order
   * — suppressing them for "already ordered" would be exactly
   * backwards. Unknown/absent kind is treated as non-sales.
   */
  followUpKind?: string | null;
}

/** Kinds this leg's sales-reminder suppressions apply to. */
export const SALES_REMINDER_KINDS: readonly string[] = [
  "warm_followup",
  "hot_followup",
];

export interface DeliveryGateDecision {
  /** false = do NOT send. The record stays pending (deferred), never
   *  marked sent and never marked failed — the next run re-evaluates.
   *  This mirrors the Leg D deferred pattern for taken-over threads. */
  send: boolean;
  outcome: WindowOutcome | "suppressed";
  reason: string;
}

export function decideFollowUpDelivery(input: DeliveryGateInput): DeliveryGateDecision {
  if (input.isBlocked) {
    return { send: false, outcome: "suppressed", reason: "customer_blocked" };
  }
  if (input.aiEnabled === false) {
    return { send: false, outcome: "suppressed", reason: "human_hands" };
  }
  // Scoping (critical — see followUpKind above): the "already ordered"
  // and "AI deems unneeded" suppressions exist for SALES reminders
  // only. An order-status push exists BECAUSE an order exists, and a
  // customer-requested reminder has no kind at all — applying these
  // suppressions to them would silence the wrong messages. Likewise
  // the closed-thread suppression applies to sales/broadcast/revival
  // nudges, not to order updates or customer-requested reminders.
  const kind = input.followUpKind ?? null;
  const isSales = kind !== null && (SALES_REMINDER_KINDS as readonly string[]).includes(kind);
  const isNudge =
    isSales ||
    kind === "broadcast" ||
    kind === "dropped_revival";
  if (
    isNudge &&
    (input.conversationStatus === "closed" || input.conversationStatus === "escalated")
  ) {
    return { send: false, outcome: "suppressed", reason: "conversation_closed_or_escalated" };
  }
  if (isSales && input.hasOrdered) {
    return { send: false, outcome: "suppressed", reason: "already_ordered" };
  }
  if (isSales && input.aiDeemsUnneeded) {
    return { send: false, outcome: "suppressed", reason: "ai_deems_unneeded" };
  }
  const window = decideWindow({
    channel: input.channel,
    lastCustomerMessageAtMs: input.lastCustomerMessageAtMs,
    nowMs: input.nowMs,
    templateConfigured: input.templateConfigured,
  });
  if (window.outcome === "allow") {
    return { send: true, outcome: "allow", reason: window.reason };
  }
  if (window.outcome === "template_only") {
    // The rule exists, the send path does not: no template name, no
    // template sender and no template config exist at HEAD (NOT FOUND,
    // see LEG-REPORT). A template_only decision therefore suppresses
    // here rather than sending free-form text past the window — the
    // template send itself is a follow-up seam, never a silent send.
    return { send: false, outcome: "template_only", reason: "template_required_not_built" };
  }
  return { send: false, outcome: "suppressed", reason: window.reason };
}

// ---------------------------------------------------------------------------
// 7. Broadcast discipline
// ---------------------------------------------------------------------------

/**
 * Channels a broadcast may use in this batch. WhatsApp and website
 * chat (widget) are EXCLUDED by the task in this batch — no broadcast
 * record is ever created for them, however recent the chat is.
 * Everything not listed here is excluded (fail closed).
 */
export const BROADCAST_CHANNELS: readonly string[] = [
  "sms",
  "email",
  "telegram",
  "messenger",
  "instagram",
];

export function isBroadcastChannelAllowed(channel: string): boolean {
  return (BROADCAST_CHANNELS as readonly string[]).includes(channel);
}

export type RecipientSource = "conversation" | "import" | "cold_list" | "unknown";

export interface BroadcastRecipientInput {
  conversationId: string;
  /** The tenant the conversation belongs to; must match the caller. */
  tenantMatch: boolean;
  channel: string;
  aiEnabled: boolean;
  conversationStatus: string;
  isBlocked: boolean;
  lastCustomerMessageAtMs: number | null;
  nowMs: number;
  /** This conversation already received a broadcast (any broadcast). */
  alreadyReceivedBroadcast: boolean;
  /**
   * Where this recipient came from. Anything other than "conversation"
   * is cold outreach and is blocked, full stop — including imported
   * lists and old-customer lists, which the task forbids in this batch.
   */
  source: RecipientSource;
}

export interface BroadcastEligibility {
  eligible: boolean;
  reasons: string[];
}

export function evaluateBroadcastRecipient(
  input: BroadcastRecipientInput
): BroadcastEligibility {
  const reasons: string[] = [];
  if (!input.tenantMatch) reasons.push("cross_tenant");
  if (input.source !== "conversation") reasons.push("cold_outreach_blocked");
  if (!isBroadcastChannelAllowed(input.channel)) {
    reasons.push(
      input.channel === "whatsapp" || input.channel === "widget"
        ? "channel_excluded_this_batch"
        : "channel_not_allowed"
    );
  }
  if (input.aiEnabled === false) reasons.push("human_hands");
  if (input.conversationStatus === "closed" || input.conversationStatus === "escalated") {
    // Extension beyond the task's three mandated conditions, flagged
    // in LEG-REPORT for owner confirmation: a closed/escalated thread
    // is not a live conversation to promote into.
    reasons.push("conversation_closed_or_escalated");
  }
  if (input.isBlocked) reasons.push("customer_blocked");
  if (input.alreadyReceivedBroadcast) reasons.push("already_received_broadcast");
  if (input.lastCustomerMessageAtMs === null) {
    reasons.push("window_unknown");
  } else {
    const ageMs = input.nowMs - input.lastCustomerMessageAtMs;
    if (ageMs < 0) {
      reasons.push("window_unknown");
    } else if (ageMs > BROADCAST_WINDOW_23H_MS) {
      // 23h is stricter than the 24h promotion ban, so the ban is
      // satisfied by construction; a broadcast past 24h is impossible
      // through this gate even if the 23h value is later relaxed.
      reasons.push("outside_23h_window");
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Change detection for the mandatory test-send rule: a broadcast may
 * only go out after a test-send of the EXACT message text to the
 * business's own chat. If the message changes by even one character,
 * the hash changes and the old test no longer validates — the
 * business must test again. FNV-1a is used for change detection only,
 * never as a security hash.
 */
export function hashMessage(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * The test-send gate, in pure form: the send step may proceed only
 * when a test record exists whose message is byte-identical to the
 * send message and whose status is "sent". A queued/pending test
 * proves nothing — the test must actually have gone out.
 */
export function isTestSendValid(args: {
  testMessage: string | null;
  testStatus: string | null;
  sendMessage: string;
}): boolean {
  if (!args.testMessage || args.testMessage.length === 0) return false;
  if (args.testStatus !== "sent") return false;
  return args.testMessage === args.sendMessage;
}
