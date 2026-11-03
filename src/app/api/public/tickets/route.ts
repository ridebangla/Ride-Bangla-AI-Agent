/**
 * POST /api/public/tickets — public Help Center ticket intake (ONE queue).
 *
 * Auth: the business's public `siteKey` in the JSON body (same auth model
 * as /api/public/reviews: the key identifies the business and grants no
 * admin powers). Business-scoped via runWithBusiness + withBusinessId,
 * exactly like the create_ticket tool path. Writes Prisma Ticket rows —
 * the queue the dashboard Tickets page reads (GET /api/tickets).
 *
 * This endpoint is for EXPLICIT visitor submissions only (Help Center
 * forms). It is never invoked by AI code and never ingests AI-generated
 * problem reports — reports belong to the separate Reports section.
 * Do NOT route this intake through /api/contact: that would create
 * second-queue tickets in the Firestore `support_tickets` store.
 *
 * CORS: POST/OPTIONS accept cross-origin requests ONLY from the five
 * company origins below (+ localhost for development). No Origin header
 * (same-origin fetch / server-to-server) is allowed, mirroring /api/contact.
 * Any other Origin header => 403.
 *
 * Rate limit: 10/hour per IP (RATE_LIMITS.publicTicket), mirroring the
 * public contact form. The store is in-memory per instance, same known
 * limitation as /api/contact — not redesigned here.
 *
 * Validation mirrors /api/contact closely (name 2–100, contact = valid
 * email OR phone, topic enum, message 10–5000, max 3 attachments, mime
 * allow-list, 700KB base64 cap each) so the page forms share one rule set.
 * Differences from /api/contact, deliberate: no payment-claim lookup
 * (no refCode parameter; forms append a payment reference into the
 * message text instead), no topic=payment special-casing beyond priority
 * "high", and the response returns the recording `reference` — forms
 * display the reference, never the raw ticket id. Priority vocabulary
 * also differs deliberately: this endpoint uses the Prisma queue's
 * vocabulary ("medium" for non-payment; the dashboard priority list is
 * low/medium/high/urgent), while /api/contact uses "normal" — "medium"
 * here is CORRECT for the Prisma queue, not a mismatch to fix.
 *
 * Recording number (unification, owner rule 2026-11-02): the reference
 * is ID-DERIVED via the shared ticketReference helper (SITE-XXXXXXXX,
 * first-segment site code + first 8 chars of the ticket id) — the same
 * scheme the chat handoff path uses. It is therefore computed AFTER
 * create (the id does not exist pre-create) and stored by a follow-up
 * update, never placed in the create data and never computed on read.
 * The random generateTicketReference helper from the ticket-build
 * package §1A is NOT used here: id-derived is collision-free (the id
 * is unique) and reuse-consistent for free.
 *
 * No GET on this route: there is no visitor ticket-tracking page in the
 * approved plan (chat-thread reference remains the follow-up path).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness, withBusinessId } from "@/lib/prisma";
import { getBusinessBySiteKey } from "@/lib/tenant";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { ticketReference } from "@/lib/ai/behaviour";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const COMPANY_ORIGINS = new Set([
  "https://ai.ridebangla.bd",
  "https://it.ridebangla.bd",
  "https://studio.ridebangla.bd",
  "https://tools.ridebangla.bd",
  "https://ridebangla.bd",
  "http://localhost:3000",
]);

const TOPICS = ["general", "payment", "technical", "feedback"] as const;
type Topic = (typeof TOPICS)[number];

const SUBJECT_BY_TOPIC: Record<Topic, string> = {
  general: "General enquiry",
  payment: "Payment issue",
  technical: "Technical issue",
  feedback: "Feedback",
};

const ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);
// 700KB base64 per file (server rule, same as /api/contact).
const MAX_ATTACHMENT_B64 = 700 * 1024;
const MAX_ATTACHMENTS = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9\s\-()]{5,19}$/;

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** The allowed Origin for CORS, or null when the request carries no Origin
 *  (same-origin/server-to-server, allowed) — callers must still check the
 *  rejected case separately via isOriginRejected(). */
function requestOrigin(request: NextRequest): string | null {
  return request.headers.get("origin");
}

function isOriginRejected(request: NextRequest): boolean {
  const origin = requestOrigin(request);
  return origin !== null && !COMPANY_ORIGINS.has(origin);
}

function corsHeaders(request: NextRequest): HeadersInit {
  const origin = requestOrigin(request);
  if (origin && COMPANY_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  if (isOriginRejected(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

interface AttachmentInput {
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  dataBase64?: unknown;
}

function validateAttachment(a: AttachmentInput, i: number): string | null {
  const mimeType = typeof a.mimeType === "string" ? a.mimeType : "";
  const dataBase64 = typeof a.dataBase64 === "string" ? a.dataBase64 : "";
  if (!ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return `Attachment ${i + 1}: unsupported file type.`;
  }
  if (dataBase64.length > MAX_ATTACHMENT_B64) {
    return `Attachment ${i + 1}: file too large (max 700KB).`;
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest) {
  if (isOriginRejected(request)) {
    return NextResponse.json(
      { error: "Origin not allowed." },
      { status: 403, headers: corsHeaders(request) }
    );
  }

  // Rate-limit per IP (public, spam-prone).
  const rl = checkRateLimit(
    `public-ticket:${clientIp(request)}`,
    RATE_LIMITS.publicTicket
  );
  if (!rl.allowed) {
    const res = NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many messages. Please wait a while and try again.",
      },
      { status: 429, headers: corsHeaders(request) }
    );
    res.headers.set(
      "Retry-After",
      String(Math.ceil((rl.resetAt - Date.now()) / 1000))
    );
    return res;
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400, headers: corsHeaders(request) }
    );
  }

  // ---- siteKey auth (public key: identifies the business, no admin powers) ----
  const siteKey = typeof body.siteKey === "string" ? body.siteKey.trim() : "";
  if (!siteKey) {
    return NextResponse.json(
      { error: "Site key is required." },
      { status: 401, headers: corsHeaders(request) }
    );
  }
  const business = await getBusinessBySiteKey(siteKey);
  if (!business) {
    return NextResponse.json(
      { error: "Invalid site key." },
      { status: 401, headers: corsHeaders(request) }
    );
  }

  // ---- validate (mirrors /api/contact) ----
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const pageUrl =
    typeof body.pageUrl === "string" ? body.pageUrl.trim().slice(0, 500) : "";
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (name.length < 2 || name.length > 100) {
    return NextResponse.json(
      { error: "Please enter your name (2–100 characters)." },
      { status: 400, headers: corsHeaders(request) }
    );
  }
  const isEmail = EMAIL_RE.test(contact);
  const isPhone = PHONE_RE.test(contact);
  if (!isEmail && !isPhone) {
    return NextResponse.json(
      { error: "Please enter a valid email address or phone number." },
      { status: 400, headers: corsHeaders(request) }
    );
  }
  if (!TOPICS.includes(topic as Topic)) {
    return NextResponse.json(
      { error: "Please choose a topic." },
      { status: 400, headers: corsHeaders(request) }
    );
  }
  if (message.length < 10 || message.length > 5000) {
    return NextResponse.json(
      { error: "Please write a message between 10 and 5000 characters." },
      { status: 400, headers: corsHeaders(request) }
    );
  }
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    return NextResponse.json(
      { error: "You can attach at most 3 files." },
      { status: 400, headers: corsHeaders(request) }
    );
  }
  for (let i = 0; i < rawAttachments.length; i++) {
    const err = validateAttachment(rawAttachments[i] as AttachmentInput, i);
    if (err) {
      return NextResponse.json(
        { error: err },
        { status: 400, headers: corsHeaders(request) }
      );
    }
  }

  const origin = requestOrigin(request);
  const sourceWebsite =
    (origin ? hostOf(origin) : "") || hostOf(pageUrl) || "";

  return runWithBusiness(business.id, async () => {
    try {
      // A supplied conversationId must belong to THIS business, else the
      // ticket could be linked to another business's thread. The scoped
      // read returns null for foreign ids, which we reject honestly.
      if (conversationId) {
        const conv = await prisma.conversation.findFirst({
          where: { id: conversationId },
          select: { id: true },
        });
        if (!conv) {
          return NextResponse.json(
            { error: "Unknown conversation." },
            { status: 400, headers: corsHeaders(request) }
          );
        }
      }

      const singleLine = message.replace(/\s+/g, " ");
      const title = `${SUBJECT_BY_TOPIC[topic as Topic]}: ${singleLine.slice(0, 80)}`;
      // FULL details in the record itself — never a stub. The description
      // repeats every structured field in text form so the ticket stays
      // fully readable even if a future reader ignores the extra fields.
      const description =
        `Source: ${business.name} — ${sourceWebsite} (help-center-form)\n` +
        `Visitor: ${name} (${contact})\n` +
        `Topic: ${topic}\n` +
        (pageUrl ? `Page: ${pageUrl}\n` : "") +
        `\n${message}`;

      const attachments = rawAttachments.map((a) => {
        const x = a as AttachmentInput;
        return {
          name:
            typeof x.name === "string" ? x.name.slice(0, 120) : "attachment",
          mimeType: typeof x.mimeType === "string" ? x.mimeType : "",
          size:
            typeof x.size === "number" && Number.isFinite(x.size)
              ? Math.floor(x.size)
              : 0,
          // NOTE: base64 in the ticket record is TEMPORARY — migrate to
          // Firebase Storage (download URLs) once Blaze billing is
          // enabled, same as /api/contact.
          dataBase64: typeof x.dataBase64 === "string" ? x.dataBase64 : "",
        };
      });

      // The recording reference is id-derived (unification): it cannot
      // be placed in the create data because the id does not exist
      // pre-create. Create first, then store it by follow-up update.
      // getBusinessBySiteKey selects only { id, name, isInternalAccount }
      // — NO slug exists at runtime, so the reference derives from
      // business.name directly; the name fallback yields the correct
      // codes for all five known businesses. Note for reviewers: tsc
      // cannot see a runtime select — never "confirm at tsc" that a
      // record carries a field the select does not include.
      // TEAM B NOTE (doctrine §5, fault-vs-ticket — DECISION PENDING,
      // do not reroute here without it): topics "technical" and
      // "feedback" currently land in the SAME support-ticket queue as
      // "general"/"payment". Per the owner doctrine a customer-reported
      // fault / feedback is a TEAM REPORT in its own Admin Panel
      // section, never a support ticket — but no team-report store
      // exists in this repo yet (see Reports-spec decision, BLOCKED:
      // separate team_reports collection vs staged Admin kind-slice).
      // Until that decision lands, this intake keeps every explicit
      // form submission (nothing is silently dropped) and tags the
      // record below so the future Reports leg can split the queue
      // without re-reading free text. Rerouting technical/feedback
      // away from this queue before the Reports section exists would
      // strand visitor reports with nowhere to be seen.
      const isTeamReportTopic = topic === "technical" || topic === "feedback";

      const ticket = await prisma.ticket.create({
        data: withBusinessId({
          title: title.slice(0, 200),
          description,
          priority: topic === "payment" ? "high" : "medium",
          status: "open",
          sourceWebsite,
          sourceChannel: "help-center-form",
          visitorName: name,
          visitorContact: contact,
          pageUrl,
          attachments,
          // Queryable source attribution (the description above
          // already carries the same facts in text form): the source
          // team is this business (business.name), the source website
          // is sourceWebsite, and the intake kind tag lets the future
          // Reports leg separate team-report topics from support
          // tickets without changing this intake's behaviour.
          metadata: {
            sourceTeam: business.name,
            sourceWebsite,
            intake: "help-center-form",
            topic,
            kind: isTeamReportTopic ? "team_report" : "support_ticket",
          },
          ...(conversationId ? { conversationId } : {}),
        }),
      });

      const reference = ticketReference(business.name || "", ticket.id);
      try {
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { reference },
        });
      } catch (err) {
        // Best-effort: the reference is deterministic from the ticket
        // id, so the visitor still receives the correct recording
        // number below, and a later reuse backfills the stored field.
        // The ticket itself is already created — never fail it here.
        logger.warn("[public-tickets] reference store failed:", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info(
        `[public-tickets] ticket ${reference} created (business=${business.id}, topic=${topic})`
      );
      return NextResponse.json(
        { ok: true, reference, status: "open" },
        { status: 201, headers: corsHeaders(request) }
      );
    } catch (err) {
      logger.error("[public-tickets] ticket write failed:", err);
      return NextResponse.json(
        { error: "Couldn't send your message. Please try again later." },
        { status: 500, headers: corsHeaders(request) }
      );
    }
  });
}
