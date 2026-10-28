/**
 * order-ratings.ts — LEG I (staged-only): post-order star ratings +
 * next-day delivered-order review requests.
 *
 * PURE module: zero runtime imports, so every rule below is provable
 * without Firestore, without a model, and without a network call.
 *
 * WHAT THIS IS (exactly the assigned scope, nothing else)
 * 1. STAR RATING — after an order the agent itself took is confirmed by
 *    the human team, the customer gets a rating request in the SAME chat
 *    (1 to 5 stars) and the rating is stored with that order (see
 *    ./order-rating-requests.ts for the write). A rating is recorded
 *    ONLY from the customer's own reply in that order's conversation,
 *    parsed deterministically here — never from model arguments, never
 *    guessed, never clamped ("6 stars" is not a rating, it is chat).
 * 2. REVIEW LINK — one day after the courier's "delivered" is known, a
 *    review request goes with the BUSINESS'S OWN tenant-configured
 *    review link. The switch (`orderReviewRequestsEnabled`) stays OFF
 *    until the tenant switches it on, and the request goes ONLY to
 *    orders whose customer's chat is linked to the order (an order with
 *    no conversationId never gets one).
 * 3. REVIEWS ARE NOT COLLECTED HERE. Reviews are written on the
 *    business's own page (Google/Facebook/whatever link the tenant
 *    configured). This system sends the request + link and records the
 *    STAR RATING only. It never collects, stores, or displays review
 *    text, and it never shows a review list anywhere.
 * 4. TENANT SCOPING lives in the callers (tenant-scoped stores in
 *    ./order-rating-requests.ts): every decision here is per-order and
 *    per-business, and no rating/review request is ever sent for
 *    another business's orders.
 *
 * WHAT THIS NEVER DOES
 * - Never confirms, changes, re-opens, or cancels an order. The agent
 *   still cannot confirm anything; only the dashboard PATCH (human
 *   team, `tickets:update`) changes status.
 * - Never quotes a fare, a price, or a total: no message built here
 *   carries money, and no decision reads `order.total`.
 * - Never invents a review destination: without a valid tenant-
 *   configured http(s) review link there is no review request (no
 *   website fallback — see decideReviewRequest; the fallback question
 *   is an open owner decision, LEG-REPORT.md §7).
 * - Never invents a delivered state: the review scan fires only on a
 *   courier phase of exactly "delivered" (see the scan in
 *   ./order-rating-requests.ts). Own-delivery orders have no delivered
 *   signal at HEAD, so they never get a review request from this leg.
 *
 * USER-FACING WORDING: every message builder below returns PROPOSAL
 * text for owner approval (standing no-invented-copy rule). Nothing
 * here ships copy silently.
 */

/** Language of a proactive message. The rating request at confirm time
 *  uses the business's settings language (no customer text exists at
 *  that moment); the rating confirmation uses the customer's own reply
 *  language, resolved by the engine caller. */
export type RatingLang = "en" | "bn";

export const ORDER_RATING_MIN = 1;
export const ORDER_RATING_MAX = 5;

/** Follow-up kinds (delivered by the EXISTING follow-up processor
 *  through the conversation's own channel — same mechanism as the
 *  post-order check-in `order_checkin` and Leg C's
 *  `order_status_update`). No new channel, no new push infra. */
export const ORDER_RATING_REQUEST_KIND = "order_rating_request";
export const ORDER_REVIEW_REQUEST_KIND = "order_review_request";

/** "One day later" = 24h after the delivered state is FIRST OBSERVED by
 *  the scan (the ops docs carry no trusted delivery timestamp at HEAD,
 *  so first-observation is the honest anchor; see LEG-REPORT.md §4). */
export const ORDER_REVIEW_DELAY_MS = 24 * 60 * 60 * 1000;

/** Bound on confirmed orders examined per business per scan run, so
 *  one cron run can never fan out into an unbounded courier-read
 *  storm. Oldest confirmed orders first. */
export const ORDER_REVIEW_SCAN_TAKE = 50;

/**
 * Order reference shown to customers: the 8-char prefix convention
 * `take_order` already gives customers ("Order reference: <first 8>").
 * The follow-up dedupe below matches on this same reference inside the
 * request message, so a request is sent at most once per order.
 */
export function orderRef(orderId: string): string {
  return (orderId || "").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Star-rating reply parsing (deterministic — the ONLY way a rating is
// recognised). Anything that does not match one of the forms below is
// ordinary chat, and no rating is recorded for it.
// ---------------------------------------------------------------------------

const BENGALI_DIGITS: Record<string, string> = {
  "০": "0",
  "১": "1",
  "২": "2",
  "৩": "3",
  "৪": "4",
  "৫": "5",
  "৬": "6",
  "৭": "7",
  "৮": "8",
  "৯": "9",
};

/** Bengali digits become ASCII digits so "৫" and "5" parse alike. */
export function normalizeRatingDigits(text: string): string {
  return (text || "").replace(/[০-৯]/g, (d) => BENGALI_DIGITS[d] ?? d);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  // Bengali number words, for the "N stars" phrase form only.
  "এক": 1,
  "দুই": 2,
  "তিন": 3,
  "চার": 4,
  "পাঁচ": 5,
};

/** Filled-star glyphs (★ U+2605, ⭐ U+2B50) and empty-star glyphs
 *  (☆ U+2606). A star-only reply "★★★☆☆" rates 3: filled count. */
const FILLED_STAR_RE = /[★⭐]/g;
const STAR_ONLY_RE = /^[\s★⭐☆]+$/;

/**
 * Parse a customer reply as a 1–5 star rating, or null when it is not
 * unambiguously a rating. Accepted forms (and ONLY these):
 *  - a lone digit 1–5 ("5", Bengali "৫");
 *  - a star-only string of at most 5 glyphs ("★★★★★", "★★★☆☆");
 *  - one number + a star word ("5 stars", "I give it 5 stars",
 *    "৫ তারা") — valid only when the message holds no OTHER number,
 *    so "Room 5, 5 stars" stays chat instead of a guessed rating.
 * Out-of-range numbers ("6 stars", "0") return null — never clamped.
 * "5/5", "excellent, 5", and bare praise return null: strictness is
 * deliberate (a false rating is worse than a missed one), and the
 * accepted forms are an open owner decision to extend (LEG-REPORT.md).
 */
export function parseRatingReply(text: string): number | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  const msg = normalizeRatingDigits(raw);

  // Lone digit.
  if (/^[1-5]$/.test(msg)) return Number(msg);

  // Star-only string.
  if (STAR_ONLY_RE.test(msg)) {
    const filled = msg.match(FILLED_STAR_RE);
    const glyphs = msg.replace(/\s/g, "").length;
    if (filled && filled.length >= 1 && filled.length <= 5 && glyphs <= 5) {
      return filled.length;
    }
    return null;
  }

  // Number + star word, with no other number in the message.
  const digitGroups = msg.match(/\d+/g) ?? [];
  // NOTE: no trailing \b on the Bengali patterns — \b only understands
  // ASCII word characters, so a boundary after "তারা" never matches.
  const starPhrase =
    msg.match(/\b(one|two|three|four|five)\s+stars?\b/i) ??
    msg.match(/(\d)\s+stars?\b/i) ??
    msg.match(/(\d)\s+তারা/) ??
    msg.match(/(এক|দুই|তিন|চার|পাঁচ)\s+তারা/);
  if (starPhrase) {
    const token = (starPhrase[1] ?? "").toLowerCase();
    const value = /^\d$/.test(token)
      ? Number(token)
      : (NUMBER_WORDS[token] ?? null);
    // A digit-phrase must be the message's ONLY number; a word-phrase
    // must coexist with NO number at all.
    const otherNumbers =
      /^\d$/.test(token) && digitGroups.length === 1
        ? 0
        : digitGroups.length;
    if (value !== null && value >= 1 && value <= 5 && otherNumbers === 0) {
      return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rating-request decision (confirm-time queue)
// ---------------------------------------------------------------------------

export interface RatingRequestInput {
  /** Current order status (must be "confirmed"). */
  status: string;
  /** Status before this setOrderStatus call (must differ). */
  previousStatus: string | null;
  /** Linked chat, or null for a hand-entered order. */
  conversationId: string | null | undefined;
  /** A rating request follow-up already exists for this order. */
  alreadyRequested: boolean;
}

export type RatingRequestDecision =
  | { request: true }
  | {
      request: false;
      reason: "no_transition" | "not_confirmed" | "no_conversation" | "already_requested";
    };

/**
 * Queue a rating request ONLY on a real move TO "confirmed", only for
 * an order with a linked chat, and at most once per order. A same-
 * status re-save, a move back to pending, and a re-confirm after a
 * pending round-trip all stay silent (the first request already went).
 */
export function decideRatingRequest(input: RatingRequestInput): RatingRequestDecision {
  if (input.previousStatus === input.status) {
    return { request: false, reason: "no_transition" };
  }
  if (input.status !== "confirmed") {
    return { request: false, reason: "not_confirmed" };
  }
  if (!input.conversationId) {
    return { request: false, reason: "no_conversation" };
  }
  if (input.alreadyRequested) {
    return { request: false, reason: "already_requested" };
  }
  return { request: true };
}

// ---------------------------------------------------------------------------
// Review-request decision (delivered scan)
// ---------------------------------------------------------------------------

export interface ReviewRequestInput {
  /** Current order status (must be "confirmed"). */
  status: string;
  /** Linked chat, or null for a hand-entered order. */
  conversationId: string | null | undefined;
  /** Courier phase from getCourierDeliveryStatus, or null if unknown. */
  courierPhase: string | null;
  /** Tenant switch — OFF until the tenant switches it on. */
  enabled: boolean;
  /** Tenant-configured review link (raw settings value). */
  reviewUrl: string;
  /** A review request follow-up already exists for this order. */
  alreadyRequested: boolean;
}

export type ReviewRequestDecision =
  | { request: true; link: string }
  | {
      request: false;
      reason:
        | "disabled"
        | "no_link"
        | "not_confirmed"
        | "no_conversation"
        | "not_delivered"
        | "already_requested";
    };

/** A review destination must be a real http(s) link the tenant set.
 *  Anything else (empty, relative, javascript:, plain text) is not a
 *  place to send a customer, so no request goes out. */
export function validReviewUrl(url: string): boolean {
  const u = (url || "").trim();
  return /^https?:\/\/\S+$/i.test(u);
}

/**
 * Queue a review request ONLY when every gate holds: the tenant
 * switched it on, a valid tenant-configured link exists, the order is
 * confirmed AND linked to a chat, the courier phase is exactly
 * "delivered", and no review request already exists for this order.
 * Gate order is deliberate: the tenant's own switch and link are
 * checked before any courier read is trusted.
 */
export function decideReviewRequest(input: ReviewRequestInput): ReviewRequestDecision {
  if (!input.enabled) return { request: false, reason: "disabled" };
  const link = (input.reviewUrl || "").trim();
  if (!validReviewUrl(link)) return { request: false, reason: "no_link" };
  if (input.status !== "confirmed") {
    return { request: false, reason: "not_confirmed" };
  }
  if (!input.conversationId) {
    return { request: false, reason: "no_conversation" };
  }
  if (input.courierPhase !== "delivered") {
    return { request: false, reason: "not_delivered" };
  }
  if (input.alreadyRequested) {
    return { request: false, reason: "already_requested" };
  }
  return { request: true, link };
}

// ---------------------------------------------------------------------------
// Message builders — PROPOSAL text for owner approval (never shipped
// copy). English source strings; the engine voices tool results in the
// customer's language per the existing prompt style, and these
// proactive texts exist in EN + BN like the behaviour package.
// ---------------------------------------------------------------------------

/** " from <name>" when a business name is known, else "". */
function businessFrom(businessName: string): string {
  const name = (businessName || "").trim();
  return name ? ` from ${name}` : "";
}

/** "<name> থেকে " when a business name is known, else "". */
function businessFromBn(businessName: string): string {
  const name = (businessName || "").trim();
  return name ? `${name} থেকে ` : "";
}

/** PROPOSAL: the star-rating request sent in the order's own chat. */
export function buildRatingRequestMessage(
  lang: RatingLang,
  businessName: string,
  ref: string
): string {
  const refPart = ref ? ` (${ref})` : "";
  return lang === "bn"
    ? `${businessFromBn(businessName)}আপনার অর্ডার${refPart} কনফার্ম হয়েছে — ধন্যবাদ! অর্ডারটি কেমন লেগেছে, ১ থেকে ৫ স্টার দিয়ে জানাবেন কি? যেমন, ৫ স্টারের জন্য ★★★★★ লিখে পাঠান।`
    : `Your order${refPart}${businessFrom(businessName)} is confirmed — thank you! How would you rate it? Please reply with 1 to 5 stars — for example, send ★★★★★ for 5 stars.`;
}

/** PROPOSAL: the next-day review request, carrying the business's OWN
 *  review link. No review text is asked for in-chat: the link is where
 *  the review is written, on the business's own page. */
export function buildReviewRequestMessage(
  lang: RatingLang,
  businessName: string,
  ref: string,
  link: string
): string {
  const refPart = ref ? ` (${ref})` : "";
  return lang === "bn"
    ? `${businessFromBn(businessName)}আপনার অর্ডার${refPart} ডেলিভার হয়েছে — ধন্যবাদ! একটু সময় থাকলে এখানে একটি রিভিউ দিয়ে জানাবেন কি: ${link}`
    : `Your order${refPart}${businessFrom(businessName)} has been delivered — thank you! If you have a moment, we'd love a review here: ${link}`;
}

/** PROPOSAL: the confirmation when a star rating is recorded. */
export function buildRatingConfirmationMessage(
  lang: RatingLang,
  stars: number
): string {
  return lang === "bn"
    ? `ধন্যবাদ! আপনার দেওয়া রেটিং: ${stars}/5 স্টার।`
    : `Thanks! You rated this order ${stars} out of 5 stars.`;
}
