/**
 * /api/contact — public Help Center contact API (marketing site).
 *
 * GET  — { email, phone, hotline } read from `site_contacts/platform` via
 *        the Admin SDK (bypasses rules). Empty strings when the doc is
 *        missing. Cached in memory for 5 minutes (platform contacts change
 *        rarely; the Admin Console editor updates the same doc).
 *
 * POST — public support-ticket intake (rate-limited per IP):
 *        body { name, contact, topic, message, refCode?, pageUrl?, attachments?[] }
 *        Validated strictly, then written to `support_tickets` via the
 *        Admin SDK with source "ai" (marketing site) or "tools" when the
 *        request comes from https://tools.ridebangla.bd.
 *        topic=payment + a refCode that matches a `payment_claims` doc
 *        (by refCode) sets relatedClaimId and priority "high".
 *
 * CORS: POST accepts cross-origin requests ONLY from
 * https://tools.ridebangla.bd (source forced to "tools") and from the
 * site's own origin (source "ai"). Any other Origin header => 403.
 *
 * NOTE (Storage migration): attachments are stored base64 in Firestore
 * until Firebase Blaze is enabled, then migrate to Firebase Storage and
 * store only download URLs here. See the client-side compression in
 * src/app/contact/page.tsx (canvas -> max 1280px JPEG q0.75; video <=700KB).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getAdminDb } from "@/lib/firestore";
import { logger } from "@/lib/logger";
import { FieldValue } from "firebase-admin/firestore";

export const dynamic = "force-dynamic";

const SELF_ORIGINS = new Set([
  "https://ai.ridebangla.bd",
  "http://localhost:3000",
]);
const TOOLS_ORIGIN = "https://tools.ridebangla.bd";
const CONTACTS_DOC = "site_contacts/platform";
const CACHE_TTL_MS = 5 * 60 * 1000;

const TOPICS = ["general", "payment", "technical", "feedback"] as const;
type Topic = (typeof TOPICS)[number];

const ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);
// 700KB base64 per SPEC (client compresses images; video must already fit).
const MAX_ATTACHMENT_B64 = 700 * 1024;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9\s\-()]{5,19}$/;
const REFCODE_RE = /^RB-[A-Za-z0-9]{4,16}$/;

interface CachedContacts {
  email: string;
  phone: string;
  hotline: string;
  fetchedAt: number;
}
let contactsCache: CachedContacts | null = null;

function emptyContacts(): { email: string; phone: string; hotline: string } {
  return { email: "", phone: "", hotline: "" };
}

async function readContacts() {
  if (contactsCache && Date.now() - contactsCache.fetchedAt < CACHE_TTL_MS) {
    return {
      email: contactsCache.email,
      phone: contactsCache.phone,
      hotline: contactsCache.hotline,
    };
  }
  const db = getAdminDb();
  const snap = await db.doc(CONTACTS_DOC).get();
  const data = snap.exists ? snap.data() || {} : {};
  const contacts = {
    email: typeof data.email === "string" ? data.email : "",
    phone: typeof data.phone === "string" ? data.phone : "",
    hotline: typeof data.hotline === "string" ? data.hotline : "",
  };
  contactsCache = { ...contacts, fetchedAt: Date.now() };
  return contacts;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** Returns the source for this request, or null when the Origin is rejected. */
function resolveSource(request: NextRequest): "ai" | "tools" | null {
  const origin = request.headers.get("origin");
  if (!origin) return "ai"; // same-origin fetch / server-to-server: no Origin
  if (origin === TOOLS_ORIGIN) return "tools";
  if (SELF_ORIGINS.has(origin)) return "ai";
  return null;
}

function corsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  const allowOrigin =
    origin === TOOLS_ORIGIN || (origin && SELF_ORIGINS.has(origin))
      ? origin
      : TOOLS_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export async function OPTIONS(request: NextRequest) {
  if (resolveSource(request) === null) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

// ---------------------------------------------------------------------------
// GET — platform contact info
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const contacts = await readContacts();
    return NextResponse.json(contacts, { headers: corsHeaders(request) });
  } catch (err) {
    logger.warn(
      `[contact] GET failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    // Honest fallback — the page renders without contact info rather than
    // showing fake numbers.
    return NextResponse.json(emptyContacts(), {
      headers: corsHeaders(request),
    });
  }
}

// ---------------------------------------------------------------------------
// POST — ticket intake
// ---------------------------------------------------------------------------

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
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

const SUBJECT_BY_TOPIC: Record<Topic, string> = {
  general: "General enquiry",
  payment: "Payment issue",
  technical: "Technical issue",
  feedback: "Feedback",
};

export async function POST(request: NextRequest) {
  const source = resolveSource(request);
  if (source === null) {
    return NextResponse.json(
      { error: "Origin not allowed." },
      { status: 403, headers: corsHeaders(request) }
    );
  }

  // Rate-limit per IP (public, spam-prone).
  const rl = checkRateLimit(`contact:${clientIp(request)}`, RATE_LIMITS.contact);
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

  // ---- validate ----
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const refCode =
    typeof body.refCode === "string" ? body.refCode.trim().toUpperCase() : "";
  const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.trim().slice(0, 500) : "";
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
  if (topic === "payment" && refCode && !REFCODE_RE.test(refCode)) {
    return NextResponse.json(
      { error: "Payment reference must look like RB-XXXXXXXX." },
      { status: 400, headers: corsHeaders(request) }
    );
  }
  if (rawAttachments.length > 3) {
    return NextResponse.json(
      { error: "You can attach at most 3 files." },
      { status: 400, headers: corsHeaders(request) }
    );
  }
  for (let i = 0; i < rawAttachments.length; i++) {
    const err = validateAttachment(
      rawAttachments[i] as AttachmentInput,
      i
    );
    if (err) {
      return NextResponse.json(
        { error: err },
        { status: 400, headers: corsHeaders(request) }
      );
    }
  }

  // ---- payment claim lookup ----
  let relatedClaimId: string | null = null;
  let priority: "normal" | "high" = topic === "payment" ? "high" : "normal";
  if (topic === "payment" && refCode) {
    try {
      const db = getAdminDb();
      const claimSnap = await db
        .collection("payment_claims")
        .where("refCode", "==", refCode)
        .limit(1)
        .get();
      if (!claimSnap.empty) {
        relatedClaimId = claimSnap.docs[0].id;
        priority = "high";
      }
    } catch (err) {
      logger.warn(
        `[contact] payment claim lookup failed: ${
          err instanceof Error ? err.message : "unknown"
        }`
      );
      // Continue without the link — the ticket itself must not be lost.
    }
  }

  const subject =
    SUBJECT_BY_TOPIC[topic as Topic] +
    (topic === "payment" && refCode ? ` — ${refCode}` : "");

  const attachments = rawAttachments.map((a) => {
    const x = a as AttachmentInput;
    return {
      name:
        typeof x.name === "string" ? x.name.slice(0, 120) : "attachment",
      mimeType: typeof x.mimeType === "string" ? x.mimeType : "",
      size: typeof x.size === "number" && Number.isFinite(x.size) ? Math.floor(x.size) : 0,
      // NOTE: base64 in Firestore is TEMPORARY — migrate to Firebase Storage
      // (download URLs) once Blaze billing is enabled.
      dataBase64: typeof x.dataBase64 === "string" ? x.dataBase64 : "",
    };
  });

  const ticket = {
    subject: subject.slice(0, 140),
    description: message,
    audience: "website_visitor",
    priority,
    status: "open",
    category: topic,
    requesterName: name,
    requesterEmail: isEmail ? contact : "",
    requesterPhone: isPhone ? contact : "",
    source,
    sourceUrl: pageUrl,
    attachments,
    ...(relatedClaimId ? { relatedClaimId } : {}),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  try {
    const db = getAdminDb();
    const docRef = await db.collection("support_tickets").add(ticket);
    logger.warn(`[contact] ticket ${docRef.id} created (source=${source}, topic=${topic})`);
    return NextResponse.json(
      { ok: true, ticketId: docRef.id },
      { headers: corsHeaders(request) }
    );
  } catch (err) {
    logger.error(
      `[contact] ticket write failed: ${
        err instanceof Error ? err.message : "unknown"
      }`
    );
    return NextResponse.json(
      { error: "Couldn't send your message. Please try again later." },
      { status: 500, headers: corsHeaders(request) }
    );
  }
}
