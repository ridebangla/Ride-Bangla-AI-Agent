import { NextRequest, NextResponse } from "next/server";
import { chat } from "@/lib/ai/engine";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBusinessBySiteKey, enterBusinessContext } from "@/lib/tenant";
import { getSubscription } from "@/lib/subscription";
import { prisma, withBusinessId } from "@/lib/prisma";
import { checkMessageLimitExceeded } from "@/lib/billing-usage";
import { parseActivityToken, bindActivityToken } from "@/lib/ai/activity";
import type { MediaInput } from "@/lib/ai/media";

/**
 * Public website-widget chat endpoint.
 *
 * Auth: the business's public `siteKey` (issued at seed/setup, shown in the
 * dashboard widget page). The site key identifies the business but grants no
 * admin powers — it can only chat as a website visitor.
 *
 * Strict rate limit: 20 requests/minute per (siteKey + visitor). Body size
 * is capped by Next.js defaults; base64 images are limited to ~4 MB.
 *
 * Streaming (2026-10-22): a request with `stream: true` in the body gets
 * an SSE response — `meta` (conversation id), `token` deltas as the
 * reply is generated, `retract` (discard a partial bubble that turned
 * out to precede tool calls), then a terminal `done` carrying the exact
 * payload the JSON response would have carried. A failed turn also ends
 * with `done` — carrying the graceful in-language failure reply (see
 * the turn-failure guarantee below) — never a raw `error` payload. Streaming
 * is strictly opt-in: every gate below still answers plain JSON, and
 * non-streaming callers (the Help-Center server adapters read
 * `response` verbatim) are byte-identical to before.
 */
const WIDGET_RATE_LIMIT = { maxRequests: 20, windowMs: 60 * 1000 };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Turn-failure guarantee (agent-quality Defect 8, 2026-10-22)
// ---------------------------------------------------------------------------
// A widget turn must NEVER die in front of the visitor as a raw English
// server error ("Failed to process message") or as a dropped connection
// ("Connection problem"). Production logs for 2026-10-22 01:02 Dhaka show
// why it did: the data layer threw `8 RESOURCE_EXHAUSTED: Quota exceeded`
// (Firestore) mid-turn and the exception escaped chat() into this route's
// catch; other turns wedged inside downstream retry backoff until the
// platform killed the function and the widget's fetch rejected. URL
// messages were not special-cased anywhere in the pipeline — they simply
// landed in the failure window (plain turns failed the same way), which
// is why the fix is at the turn boundary, not URL handling:
//
//  1. ANY exception escaping a turn is converted into a COMPLETED turn:
//     HTTP 200 with a graceful, in-language `response` (language follows
//     the visitor's own message), so the widget renders a normal bot
//     reply and server-side adapters keep working. The real error is
//     still logged server-side above.
//  2. A turn is raced against a soft deadline (default 50s — healthy
//     turns complete in ~15–20s). A wedged turn settles with the same
//     graceful response instead of hanging until the platform severs
//     the connection. The underlying work may still finish server-side;
//     the thread sync then shows the saved reply.
// ---------------------------------------------------------------------------
/** Soft per-turn deadline, read per request so ops can tune it via
 *  WIDGET_TURN_DEADLINE_MS without a code change. */
function turnDeadlineMs(): number {
  const n = Number(process.env.WIDGET_TURN_DEADLINE_MS);
  return Number.isFinite(n) && n >= 1000 && n <= 120_000 ? n : 50_000;
}

class TurnDeadlineError extends Error {
  constructor(ms: number) {
    super(`widget turn exceeded ${ms}ms deadline`);
    this.name = "TurnDeadlineError";
  }
}

function withTurnDeadline<T>(work: Promise<T>): Promise<T> {
  const ms = turnDeadlineMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnDeadlineError(ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const GRACEFUL_TURN_TEXT = {
  bn: "দুঃখিত, এই মুহূর্তে আপনার বার্তাটির উত্তর দিতে একটু সমস্যা হচ্ছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন, অথবা জরুরি হলে আমাদের টিমের সঙ্গে সরাসরি যোগাযোগ করুন।",
  en: "I'm sorry, I'm having a little trouble answering your message right now. Please try again in a moment, or contact our team directly if it's urgent.",
} as const;

/** Graceful turn-failure text in the visitor's language (Bengali script
 *  in their message → Bengali; anything else → English). */
export function gracefulTurnResponseText(messageText: string): string {
  return /[\u0980-\u09FF]/.test(messageText || "")
    ? GRACEFUL_TURN_TEXT.bn
    : GRACEFUL_TURN_TEXT.en;
}

export async function POST(request: NextRequest) {
  // Identifiers captured as the turn progresses so the failure path can
  // still hand back a completed-turn payload for the right conversation.
  let failureText = "";
  let failureConversationId = "";
  let failureVisitorId = "";
  try {
    const body = await request.json();
    const { siteKey, message, visitorId, conversationId, image } = body as {
      siteKey?: string;
      message?: string;
      visitorId?: string;
      conversationId?: string;
      image?: { mimeType?: string; base64?: string };
    };
    // Seam fix (agent-quality round, 2026-10-22): bind the failure text
    // from the INCOMING message at request parse — BEFORE any Firestore
    // data gate runs (getBusinessBySiteKey / getSubscription /
    // checkMessageLimitExceeded below). Language detection needs no
    // database, and a turn dying AT those gates (e.g. quota throw) used
    // to reach the catch with an empty failure text, so the graceful
    // reply fell back to English even for a Bengali message. Binding
    // here makes every failure stage — gates, engine, deadline — answer
    // in the customer's language, in both the JSON and streaming modes
    // (a gate death settles through this same catch; the stream's own
    // terminal `done` derives from the same message text).
    failureText = typeof message === "string" ? message.trim() : "";
    // Live-activity caption channel (see lib/ai/activity.ts): the embed
    // polls /api/chat/activity with this token while a reply is pending.
    const activityToken = parseActivityToken(
      (body as { activityToken?: unknown }).activityToken
    );
    const wantsStream = (body as { stream?: unknown }).stream === true;

    if (!siteKey || typeof siteKey !== "string") {
      return NextResponse.json({ error: "siteKey is required" }, { status: 401 });
    }

    const business = await getBusinessBySiteKey(siteKey);
    if (!business) {
      return NextResponse.json({ error: "Invalid site key" }, { status: 401 });
    }
    // PHASE 3 (user decision 16 — airtight): subscription hard-stop BEFORE
    // any LLM tokens are spent, conversations are created, or media is
    // processed. Inactive trial/subscription => HTTP 402 +
    // { error: "subscription_paused" }; the widget renders a beautiful
    // "Subscription paused" state and sends nothing further.
    const sub = await getSubscription(business.id);
    if (!sub.isActive) {
      logger.warn(
        `[billing] blocked widget chat for business ${business.id}: subscription inactive`
      );
      return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
    }
    if (await checkMessageLimitExceeded(business.id)) {
      return NextResponse.json({ error: "message_limit_reached" }, { status: 402 });
    }
    enterBusinessContext(business.id);

    // Visitor identity is the thread-ownership proof (the thread endpoint
    // requires customerContact === visitorId), so it must never be a
    // publicly known constant: "anonymous" was the shared default, which
    // made every no-visitorId conversation readable/appendable by anyone
    // who knew that string + the conversationId (attack test 2026-10-21).
    // A missing or reserved visitorId gets a server-generated unguessable
    // identity instead; it is returned in the response so a caller that
    // omitted one can still own and read back its own thread.
    const suppliedVisitor =
      typeof visitorId === "string" ? visitorId.trim().slice(0, 64) : "";
    const visitor =
      suppliedVisitor && suppliedVisitor.toLowerCase() !== "anonymous"
        ? suppliedVisitor
        : `anon-${crypto.randomUUID()}`;
    failureVisitorId = visitor;
    // visitorId is client-supplied and rotatable — a second bucket keyed by
    // (siteKey + IP) caps total abuse per network regardless of rotation.
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const rl = checkRateLimit(`widget:${siteKey}:${visitor}`, WIDGET_RATE_LIMIT);
    const rlIp = checkRateLimit(`widget-ip:${siteKey}:${clientIp}`, { maxRequests: 60, windowMs: 60 * 1000 });
    if (!rl.allowed || !rlIp.allowed) {
      return NextResponse.json(
        { error: "Too many messages. Please wait a moment and try again." },
        { status: 429 }
      );
    }

    const text = typeof message === "string" ? message.trim() : "";
    failureText = text;
    if (!text && !image?.base64) {
      return NextResponse.json({ error: "Message or image is required" }, { status: 400 });
    }
    if (text.length > 5000) {
      return NextResponse.json({ error: "Message too long" }, { status: 400 });
    }

    // Optional photo attachment from the widget.
    let media: MediaInput | undefined;
    if (image?.base64) {
      const mimeType = typeof image.mimeType === "string" ? image.mimeType : "image/jpeg";
      if (!mimeType.startsWith("image/")) {
        return NextResponse.json({ error: "Only image attachments are supported" }, { status: 400 });
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(image.base64, "base64");
      } catch {
        return NextResponse.json({ error: "Invalid image data" }, { status: 400 });
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "Image too large (max 4 MB)" }, { status: 400 });
      }
      media = { kind: "image", mimeType, bytes };
    }

    // Find or create the visitor's conversation.
    let convId = typeof conversationId === "string" ? conversationId : "";
    if (convId) {
      const existing = await prisma.conversation.findUnique({ where: { id: convId } });
      // Scoped to this business by the tenant proxy; also require the same
      // visitor so one visitor cannot read another's thread.
      if (!existing || existing.customerContact !== visitor) {
        convId = "";
      } else if (activityToken) {
        await bindActivityToken(convId, activityToken, existing.activityToken);
      }
    }
    if (!convId) {
      // Multi-site identity (A-to-Z audit 2026-10-20): when ONE business's
      // widget is embedded on several of the owner's sites, the Origin /
      // Referer host is the only reliable per-site signal — record it on
      // the conversation so the Inbox can tell which site a chat came
      // from. An explicit body.source (sanitized) wins when provided.
      const explicitSource =
        typeof (body as { source?: unknown }).source === "string"
          ? (body as { source: string }).source.trim().slice(0, 60)
          : "";
      let sourceSite = explicitSource;
      if (!sourceSite) {
        const originHost =
          request.headers.get("origin") || request.headers.get("referer") || "";
        try {
          sourceSite = new URL(originHost).hostname.slice(0, 60);
        } catch {
          sourceSite = "";
        }
      }
      const conv = await prisma.conversation.create({
        data: withBusinessId({
          channel: "widget",
          customerName: "Website Visitor",
          customerContact: visitor,
          status: "open",
          ...(activityToken ? { activityToken } : {}),
          ...(sourceSite ? { metadata: { sourceSite } } : {}),
          // Phase 3 (user decision 17): AI replies ON by default; the Phase
          // 5 dashboard switch flips this to false for human takeover.
          aiEnabled: true,
        }),
      });
      convId = conv.id;
    }
    failureConversationId = convId;

    if (wantsStream) {
      const encoder = new TextEncoder();
      const sseStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: Record<string, unknown>) => {
            try {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
              );
            } catch {
              /* client disconnected — the turn still completes server-side */
            }
          };
          try {
            send("meta", { conversationId: convId });
            const result = await withTurnDeadline(
              chat(convId, text || "(sent a photo)", {
                media,
                onToken: (tokenText) => send("token", { text: tokenText }),
                onRetract: () => send("retract", {}),
              })
            );
            // Terminal payload: the exact shape the JSON response carries.
            send("done", {
              conversationId: convId,
              visitorId: visitor,
              response: result.response,
              products: result.products,
              silent: result.silent,
              aiConfigured: result.aiConfigured !== false,
            });
          } catch (error) {
            logger.error("Widget chat (stream) failed:", error);
            // Turn-failure guarantee: settle the stream with a completed,
            // graceful, in-language turn — never a raw server error. If
            // tokens already streamed, the embed replaces the partial
            // bubble with this text; if the wedged turn still finishes
            // server-side, the thread sync shows its saved reply after.
            send("done", {
              conversationId: convId,
              visitorId: visitor,
              response: gracefulTurnResponseText(text),
              products: [],
              silent: false,
            });
          } finally {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        },
      });
      return new Response(sseStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const result = await withTurnDeadline(
      chat(convId, text || "(sent a photo)", { media })
    );

    return NextResponse.json({
      conversationId: convId,
      visitorId: visitor,
      response: result.response,
      products: result.products,
      silent: result.silent,
      // Help-Center adapter support (2026-10-20): false only when the
      // business has no AI provider key configured (engine fallback path),
      // so server-side consumers can render their own honest degradation
      // instead of the widget-oriented fallback text. True otherwise.
      aiConfigured: result.aiConfigured !== false,
    });
  } catch (error) {
    logger.error("Widget chat failed:", error);
    // Turn-failure guarantee (see the Defect-8 note above): the visitor
    // gets a COMPLETED turn with a graceful in-language reply — the raw
    // server error never surfaces, whatever stage threw (data-layer
    // quota, provider parse, deadline). Gates that answer explicitly
    // (401/402/429/validation) are unaffected: they return before here.
    return NextResponse.json({
      ...(failureConversationId
        ? { conversationId: failureConversationId }
        : {}),
      ...(failureVisitorId ? { visitorId: failureVisitorId } : {}),
      response: gracefulTurnResponseText(failureText),
      products: [],
      silent: false,
    });
  }
}
