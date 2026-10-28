/**
 * order-rating-requests.ts — LEG I (staged-only): the IO side of
 * post-order star ratings + next-day delivered-order review requests.
 *
 * MECHANISM (no new channel code, no new meter, no new push infra):
 * a confirm / delivered observation creates a follow-up record and the
 * EXISTING follow-up processor (./followups, POST /api/followups/process
 * cron) delivers it through the conversation's own channel — exactly
 * the precedent of the post-order check-in (`order_checkin`, ./ai/behaviour)
 * and Leg C's `order_status_update`. Channel honesty carries over:
 * WhatsApp/SMS/email/Telegram send through their real channels (and fail
 * honestly outside delivery windows, e.g. WhatsApp's 24h rule — never
 * faked as sent); the website widget has no push, so the message lands
 * as an assistant message the visitor sees on their next visit.
 *
 * TESTABILITY (Leg C pattern): all data access goes through the
 * injected `store`, so the guards are provable against a fake store.
 * The production store is built by the caller from the already-imported
 * prisma client (`prismaRatingStore`) — this module itself imports no
 * data layer at top level (logger + the pure module only), so importing
 * it can never initialise Firestore. Tenancy is the caller's scoped
 * prisma client: every read/write below runs inside the business's own
 * tenant context, and the conversation check additionally rejects a
 * conversation belonging to another business.
 *
 * WHAT THIS NEVER DOES
 * - Never confirms, mutates the order's status/items/total, or
 *   re-opens anything. The ONLY order writes are: the star rating
 *   itself (`rating`, `ratingAt`) on capture — never status, never
 *   money. Rating/review queueing writes ONLY follow-up records.
 * - Never sends on a human-takeover thread (`aiEnabled === false`):
 *   the human owns that thread (same guard as Leg C; Leg D's delivery-
 *   side deferral covers the queue-to-delivery window once applied).
 * - Never double-sends: one request per order per kind. Dedupe counts
 *   a request follow-up of that kind in ANY status (pending, sending,
 *   sent, even failed) — one shot per order, mirroring the platform's
 *   "at most ONE revival ever" precedent. A failed delivery is visible
 *   to the team in the follow-up list; re-queueing after failure is an
 *   open owner decision (LEG-REPORT.md §7).
 * - Never throws into its callers: every entry point returns
 *   `{ queued | captured: false, reason }` instead of throwing, so a
 *   notification/rating failure can never break a confirm, a chat turn,
 *   or the cron run.
 *
 * METERING (verified, not invented): `recordAiMessage` is called only
 * by the chat engine's normal reply tail and /api/public/ai/generate;
 * followups.ts never calls it. So under the EXISTING metering these
 * follow-up deliveries do NOT consume the tenant's AI-message quota,
 * and the deterministic rating confirmation (which returns before the
 * engine's metering tail, like the handoff path) is not metered either.
 * No new meter is invented — whether pushes SHOULD count is an owner
 * decision (LEG-REPORT.md §7).
 */

import { logger } from "./logger";
import {
  ORDER_RATING_REQUEST_KIND,
  ORDER_REVIEW_REQUEST_KIND,
  ORDER_REVIEW_DELAY_MS,
  ORDER_REVIEW_SCAN_TAKE,
  buildRatingConfirmationMessage,
  buildRatingRequestMessage,
  buildReviewRequestMessage,
  decideRatingRequest,
  decideReviewRequest,
  orderRef,
  parseRatingReply,
  validReviewUrl,
  type RatingLang,
} from "./order-ratings";

// ---------------------------------------------------------------------------
// Store (injected; production store built by prismaRatingStore below)
// ---------------------------------------------------------------------------

export interface RatingConversation {
  id: string;
  businessId: string;
  aiEnabled?: boolean | null;
}

export interface RatingOrderLike {
  id: string;
  businessId: string;
  status: string;
  conversationId?: string | null;
  /** Star rating already recorded on this order, if any. */
  rating?: number | null;
}

export interface RatingFollowUpLike {
  id: string;
  conversationId: string;
  kind?: string | null;
  status: string;
  message: string;
  createdAt?: Date | string | null;
}

export interface RatingSettingsLike {
  orderReviewRequestsEnabled?: unknown;
  reviewUrl?: unknown;
  businessName?: unknown;
  language?: unknown;
}

/** Reads/writes the rating queue + capture need. */
export interface RatingStore {
  findConversation(
    conversationId: string
  ): Promise<RatingConversation | null>;
  /** All follow-ups of one kind in one conversation (any status). */
  findFollowUps(
    conversationId: string,
    kind: string
  ): Promise<RatingFollowUpLike[]>;
  createFollowUp(input: {
    conversationId: string;
    message: string;
    dueAt: Date;
    kind: string;
  }): Promise<void>;
  /** Orders linked to one conversation, newest first. */
  findOrdersByConversation(
    conversationId: string
  ): Promise<RatingOrderLike[]>;
  updateOrder(
    orderId: string,
    data: { rating: number; ratingAt: Date }
  ): Promise<void>;
}

/** Everything the delivered-review scan needs, on top of RatingStore. */
export interface ReviewScanStore extends RatingStore {
  /** Confirmed orders, oldest first, bounded by the scan cap. */
  findConfirmedOrders(take: number): Promise<RatingOrderLike[]>;
  readSettings(): Promise<RatingSettingsLike | null>;
  /** Courier phase for one order, or null when unknown/unreadable. */
  readCourierPhase(orderId: string): Promise<string | null>;
}

export interface RatingRequestContext {
  businessName: string;
  lang: RatingLang;
}

export type QueueRatingResult =
  | { queued: true }
  | { queued: false; reason: string };

export type CaptureRatingResult =
  | {
      captured: true;
      stars: number;
      orderId: string;
      orderRef: string;
      confirmation: string;
    }
  | { captured: false; reason: string };

export interface ReviewScanResult {
  scanned: number;
  queued: number;
  skipped: number;
  /** Per-skip-reason tallies (counts only — no customer data). */
  reasons: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when a request follow-up of this kind already exists for this
 *  order in this conversation (message carries the order reference). */
function hasRequestFollowUp(
  followUps: RatingFollowUpLike[],
  ref: string
): boolean {
  if (!ref) return false;
  return followUps.some(
    (fu) => typeof fu.message === "string" && fu.message.includes(ref)
  );
}

function asDate(value: Date | string | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** Resolve the review-scan settings from a raw Settings doc. The
 *  switch is OFF unless explicitly true (see getBehaviourSettings in
 *  ./ai/behaviour.ts — missing field = platform default = OFF). */
export function resolveReviewScanSettings(settings: RatingSettingsLike | null): {
  enabled: boolean;
  reviewUrl: string;
  businessName: string;
  lang: RatingLang;
} {
  const s = settings ?? {};
  return {
    enabled: s.orderReviewRequestsEnabled === true,
    reviewUrl:
      typeof s.reviewUrl === "string" ? s.reviewUrl.trim() : "",
    businessName:
      typeof s.businessName === "string" ? s.businessName : "",
    lang: s.language === "bn" ? "bn" : "en",
  };
}

// ---------------------------------------------------------------------------
// 1. Queue the star-rating request (called from setOrderStatus)
// ---------------------------------------------------------------------------

/**
 * Queue the rating request for a team-confirmed order. Guards, in
 * order: real transition TO confirmed; linked chat; conversation
 * exists and belongs to this business; thread not human-owned; no
 * earlier request for this order. Never throws.
 */
export async function queueOrderRatingRequest(
  order: RatingOrderLike,
  previousStatus: string | null,
  ctx: RatingRequestContext,
  store: RatingStore
): Promise<QueueRatingResult> {
  try {
    if (!order || typeof order.id !== "string" || !order.id) {
      return { queued: false, reason: "invalid_order" };
    }
    const conversationId = order.conversationId ?? null;
    if (!conversationId) {
      return { queued: false, reason: "no_conversation" };
    }
    const conversation = await store.findConversation(conversationId);
    if (!conversation) {
      return { queued: false, reason: "no_conversation" };
    }
    if (conversation.businessId !== order.businessId) {
      return { queued: false, reason: "cross_tenant" };
    }
    if (conversation.aiEnabled === false) {
      return { queued: false, reason: "takeover_paused" };
    }
    const ref = orderRef(order.id);
    const existing = await store.findFollowUps(
      conversationId,
      ORDER_RATING_REQUEST_KIND
    );
    const decision = decideRatingRequest({
      status: order.status,
      previousStatus,
      conversationId,
      alreadyRequested: hasRequestFollowUp(existing, ref),
    });
    if (!decision.request) {
      return { queued: false, reason: decision.reason };
    }
    await store.createFollowUp({
      conversationId,
      message: buildRatingRequestMessage(ctx.lang, ctx.businessName, ref),
      dueAt: new Date(),
      kind: ORDER_RATING_REQUEST_KIND,
    });
    return { queued: true };
  } catch (err) {
    logger.warn("[order-ratings] rating request queue failed", {
      orderId: order?.id ?? null,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { queued: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// 2. Capture a star rating from a customer reply (called from the
//    engine fast path — runs BEFORE the model, and before the
//    brain-offline fallback, so a rating is recorded even with no
//    provider key; it needs no LLM at all, like the handoff path)
// ---------------------------------------------------------------------------

/**
 * Record a star rating from the customer's OWN message in the order's
 * conversation. The message must parse deterministically
 * (parseRatingReply) — ordinary chat costs zero store reads, because
 * parsing happens before any read. The rating lands on the most
 * recently rating-requested order in this conversation that is still
 * confirmed and still unrated; a cancelled order, an already-rated
 * order, and a conversation with no pending rating request all stay
 * ordinary chat. First rating wins — a later stars reply does not
 * overwrite it. Never throws.
 */
export async function captureOrderRating(
  conversationId: string,
  customerMessage: string,
  ctx: RatingRequestContext,
  store: RatingStore
): Promise<CaptureRatingResult> {
  try {
    const stars = parseRatingReply(customerMessage);
    if (stars === null) {
      return { captured: false, reason: "no_rating" };
    }
    if (!conversationId) {
      return { captured: false, reason: "no_conversation" };
    }
    const conversation = await store.findConversation(conversationId);
    if (!conversation) {
      return { captured: false, reason: "no_conversation" };
    }
    if (conversation.aiEnabled === false) {
      return { captured: false, reason: "takeover_paused" };
    }
    const [orders, requests] = await Promise.all([
      store.findOrdersByConversation(conversationId),
      store.findFollowUps(conversationId, ORDER_RATING_REQUEST_KIND),
    ]);
    // Candidates: still confirmed, still unrated, rating requested,
    // belonging to this business. Newest request first (the customer
    // most plausibly rates the latest order they were asked about).
    const candidates = (orders ?? [])
      .filter(
        (o) =>
          o &&
          o.businessId === conversation.businessId &&
          o.status === "confirmed" &&
          (o.rating === null || o.rating === undefined) &&
          hasRequestFollowUp(requests, orderRef(o.id))
      )
      .map((o) => {
        const matching = requests.filter((fu) =>
          fu.message.includes(orderRef(o.id))
        );
        const latest = matching.reduce(
          (max, fu) => Math.max(max, asDate(fu.createdAt)),
          0
        );
        return { order: o, latest };
      })
      .sort((a, b) => b.latest - a.latest);
    const winner = candidates[0];
    if (!winner) {
      return { captured: false, reason: "no_pending_order" };
    }
    await store.updateOrder(winner.order.id, {
      rating: stars,
      ratingAt: new Date(),
    });
    return {
      captured: true,
      stars,
      orderId: winner.order.id,
      orderRef: orderRef(winner.order.id),
      confirmation: buildRatingConfirmationMessage(ctx.lang, stars),
    };
  } catch (err) {
    logger.warn("[order-ratings] rating capture failed", {
      conversationId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { captured: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// 3. Scan delivered orders and queue next-day review requests
//    (called per business from POST /api/followups/process)
// ---------------------------------------------------------------------------

/**
 * One scan run inside ONE tenant context. For each confirmed,
 * chat-linked order whose courier phase is exactly "delivered" and
 * which has no earlier review request, queue ONE review follow-up due
 * 24h after this first observation, carrying the business's OWN
 * tenant-configured review link. The tenant switch defaults OFF; a
 * missing/invalid link, a missing/foreign/paused conversation, an
 * own-delivery order (no courier phase — honestly "not delivered" by
 * this scan), and any per-order failure all skip that order only and
 * never abort the scan. Never throws.
 */
export async function scanBusinessDeliveredReviews(
  store: ReviewScanStore,
  now: Date = new Date()
): Promise<ReviewScanResult> {
  const result: ReviewScanResult = {
    scanned: 0,
    queued: 0,
    skipped: 0,
    reasons: {},
  };
  const skip = (reason: string) => {
    result.skipped += 1;
    result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
  };
  try {
    const settings = await store.readSettings();
    const { enabled, reviewUrl, businessName, lang } =
      resolveReviewScanSettings(settings);
    if (!enabled) {
      // Business-level skip (not a per-order skip): the tenant never
      // switched the delivered-review request on. Nothing is scanned.
      logger.info("[order-ratings] review scan skipped: disabled");
      return { scanned: 0, queued: 0, skipped: 0, reasons: {} };
    }
    if (!validReviewUrl(reviewUrl)) {
      logger.info("[order-ratings] review scan skipped: no_link");
      return { scanned: 0, queued: 0, skipped: 0, reasons: {} };
    }
    const orders = await store.findConfirmedOrders(ORDER_REVIEW_SCAN_TAKE);
    result.scanned = (orders ?? []).length;
    for (const order of orders ?? []) {
      try {
        if (!order || typeof order.id !== "string" || !order.id) {
          skip("invalid_order");
          continue;
        }
        const conversationId = order.conversationId ?? null;
        if (!conversationId) {
          skip("no_conversation");
          continue;
        }
        const conversation = await store.findConversation(conversationId);
        if (!conversation) {
          skip("no_conversation");
          continue;
        }
        if (conversation.businessId !== order.businessId) {
          skip("cross_tenant");
          continue;
        }
        if (conversation.aiEnabled === false) {
          skip("takeover_paused");
          continue;
        }
        const ref = orderRef(order.id);
        const existing = await store.findFollowUps(
          conversationId,
          ORDER_REVIEW_REQUEST_KIND
        );
        if (hasRequestFollowUp(existing, ref)) {
          skip("already_requested");
          continue;
        }
        let phase: string | null = null;
        try {
          phase = await store.readCourierPhase(order.id);
        } catch {
          phase = null;
        }
        const decision = decideReviewRequest({
          status: order.status,
          conversationId,
          courierPhase: phase,
          enabled: true,
          reviewUrl,
          alreadyRequested: false,
        });
        if (!decision.request) {
          skip(decision.reason);
          continue;
        }
        await store.createFollowUp({
          conversationId,
          message: buildReviewRequestMessage(
            lang,
            businessName,
            ref,
            decision.link
          ),
          dueAt: new Date(now.getTime() + ORDER_REVIEW_DELAY_MS),
          kind: ORDER_REVIEW_REQUEST_KIND,
        });
        result.queued += 1;
      } catch (err) {
        logger.warn("[order-ratings] review scan order failed", {
          orderId: order?.id ?? null,
          reason: err instanceof Error ? err.message : String(err),
        });
        skip("error");
      }
    }
    return result;
  } catch (err) {
    logger.warn("[order-ratings] review scan failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Production store (callers pass their already-imported prisma client)
// ---------------------------------------------------------------------------

/** Minimal structural shape of the prisma client this store needs. */
export interface PrismaRatingClient {
  conversation: {
    findUnique(args: unknown): Promise<RatingConversation | null>;
  };
  followUp: {
    findMany(args: unknown): Promise<RatingFollowUpLike[]>;
    create(args: unknown): Promise<unknown>;
  };
  order: {
    findMany(args: unknown): Promise<RatingOrderLike[]>;
    update(args: unknown): Promise<unknown>;
  };
  settings: {
    findFirst(args?: unknown): Promise<RatingSettingsLike | null>;
  };
}

export type WithBusinessIdFn = (
  data: Record<string, unknown>
) => Record<string, unknown>;

/**
 * Build the tenant-scoped store from the caller's prisma client. The
 * caller MUST already be inside its business's tenant context
 * (runWithBusiness) — this builder adds no tenancy of its own, it
 * inherits the caller's. `readCourierPhase` is NOT included: the scan
 * caller (the follow-ups process route) supplies it from the courier
 * bridge, so this module never imports the bridge.
 */
export function prismaRatingStore(
  prisma: PrismaRatingClient,
  withBusinessId: WithBusinessIdFn
): RatingStore & {
  findConfirmedOrders(take: number): Promise<RatingOrderLike[]>;
  readSettings(): Promise<RatingSettingsLike | null>;
} {
  return {
    findConversation: (conversationId: string) =>
      prisma.conversation.findUnique({ where: { id: conversationId } }),
    findFollowUps: (conversationId: string, kind: string) =>
      prisma.followUp.findMany({
        where: { conversationId, kind },
        orderBy: { createdAt: "desc" },
      }),
    createFollowUp: async (input) => {
      await prisma.followUp.create({
        data: withBusinessId({
          conversationId: input.conversationId,
          message: input.message,
          dueAt: input.dueAt,
          status: "pending",
          kind: input.kind,
        }),
      });
    },
    findOrdersByConversation: (conversationId: string) =>
      prisma.order.findMany({
        where: { conversationId },
        orderBy: { createdAt: "desc" },
      }),
    updateOrder: async (orderId: string, data) => {
      await prisma.order.update({ where: { id: orderId }, data });
    },
    findConfirmedOrders: (take: number) =>
      prisma.order.findMany({
        where: { status: "confirmed" },
        orderBy: { createdAt: "asc" },
        take,
      }),
    readSettings: () => prisma.settings.findFirst(),
  };
}
