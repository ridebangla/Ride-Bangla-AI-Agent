import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getAdminDb } from "@/lib/firestore";
import { getCurrentUser } from "@/lib/auth";
import { FieldValue } from "firebase-admin/firestore";

const serverTimestamp = () => FieldValue.serverTimestamp();
const clampText = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/contact/thread — the support chat for a visitor who has no account.
 * The ticket id + the secret `k` returned at ticket creation prove ownership
 * (only sha256(k) is stored on the ticket). Reads the same
 * support_tickets/{id}/messages thread Admin Console staff reply into.
 */

const STAFF = new Set([
  "support", "admin", "super_admin", "finance", "kyc", "website",
  "operations", "moderator", "support_admin", "staff", "system",
]);

function ip(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Owner by session (account tickets) or by secret token (Tools visitors). */
async function authorize(ticketId: string, token: string, uid: string) {
  if (!ticketId || ticketId.length > 200 || ticketId.includes("/")) return null;
  const ref = getAdminDb().collection("support_tickets").doc(ticketId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if (uid && String(snap.get("requesterId") || "") === uid) {
    return { ref, ticket: snap.data() ?? {}, uid };
  }
  if (token.length < 20) return null;
  const stored = String(snap.get("accessTokenHash") || "");
  const given = createHash("sha256").update(token).digest("hex");
  if (stored.length !== given.length) return null;
  if (!timingSafeEqual(Buffer.from(stored), Buffer.from(given))) return null;
  return { ref, ticket: snap.data() ?? {}, uid: "" };
}

export async function GET(request: NextRequest) {
  const rl = checkRateLimit(`contact-thread:${ip(request)}`, RATE_LIMITS.api);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const id = request.nextUrl.searchParams.get("id") || "";
  const k = request.nextUrl.searchParams.get("k") || "";
  const user = await getCurrentUser();
  try {
    if (!id) {
      if (!user) return NextResponse.json({ error: "login_required" }, { status: 401 });
      const mine = await getAdminDb()
        .collection("support_tickets")
        .where("requesterId", "==", user.id)
        .limit(50)
        .get();
      const tickets = mine.docs
        .map((d) => ({
          id: d.id,
          subject: String(d.get("subject") || "Support ticket"),
          status: String(d.get("status") || "open"),
          updatedAt: d.get("updatedAt")?.toMillis?.() ?? d.get("createdAt")?.toMillis?.() ?? 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return NextResponse.json({ ok: true, tickets });
    }
    const auth = await authorize(id, k, user?.id ?? "");
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const snap = await auth.ref.collection("messages").orderBy("createdAt", "asc").limit(200).get();
    const messages = snap.docs
      .map((d) => {
        const data = d.data();
        const role = String(data.senderRole || data.sender_role || "").toLowerCase();
        const created = data.createdAt?.toMillis?.() ?? 0;
        return {
          id: d.id,
          text: String(data.text || data.message || ""),
          fromStaff: STAFF.has(role) || data.senderType === "staff" || data.isStaff === true,
          createdAt: created,
        };
      })
      .filter((m) => m.text);
    // Opening ticket text, when the thread has no first message yet.
    if (messages.length === 0 && auth.ticket.description) {
      messages.push({ id: "first", text: String(auth.ticket.description), fromStaff: false, createdAt: 0 });
    }
    return NextResponse.json({
      ok: true,
      subject: String(auth.ticket.subject || ""),
      status: String(auth.ticket.status || "open"),
      messages,
    });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const rl = checkRateLimit(`contact-thread-post:${ip(request)}`, RATE_LIMITS.contact);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const id = clampText(body.id, 200);
  const k = clampText(body.k, 200);
  const text = clampText(body.message, 2000).trim();
  const user = await getCurrentUser();
  if (text.length < 2) return NextResponse.json({ error: "message_too_short" }, { status: 400 });
  try {
    const auth = await authorize(id, k, user?.id ?? "");
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await auth.ref.collection("messages").add({
      ticketId: id,
      message: text,
      text,
      senderId: auth.uid || "visitor",
      senderRole: auth.uid ? "user" : "visitor",
      sender_role: auth.uid ? "user" : "visitor",
      createdAt: serverTimestamp(),
    });
    const status = String(auth.ticket.status || "open").toLowerCase();
    await auth.ref.set(
      {
        status: status === "resolved" || status === "closed" ? "open" : status,
        unreadBySupport: true,
        lastMessage: text.slice(0, 240),
        lastMessageByRole: auth.uid ? "user" : "visitor",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
