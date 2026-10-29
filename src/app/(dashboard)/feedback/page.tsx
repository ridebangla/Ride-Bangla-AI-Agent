import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getRefreshCookieName,
  verifySessionToken,
  verifyToken,
} from "@/lib/auth";
import { getUnscopedPrisma, prisma, runWithBusiness } from "@/lib/prisma";

/**
 * Reply Feedback — admin view (widget media+feedback batch, 2026-10-29).
 *
 * Every like / dislike tap a visitor leaves under an AI reply lands
 * here, so the owner can judge whether the agent answers wrongly:
 * disliked replies are listed FIRST, then newest first. No form, no
 * write actions on this page — it is a read view only; a tap is
 * recorded from the widget, never edited here.
 *
 * Auth mirrors the billing page: a valid session is required, and a
 * tenant admin sees ONLY their own business's feedback. The Super
 * Admin (businessId null) sees every business's feedback. The
 * (dashboard) layout around this page adds its own session gate and
 * the trial/subscription redirect; this page's own checks are the
 * backstop, not the only gate.
 *
 * Data: `chatFeedback` via the Firestore-backed prisma shim (Admin
 * SDK server-side). No client-side Firestore read, so this page does
 * not depend on the client rules for the collection.
 */
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Reply Feedback — Ride Bangla AI Agent",
  robots: { index: false, follow: false },
};

type FeedbackRow = {
  id: string;
  conversationId: string;
  visitorId: string;
  value: string;
  replyText: string;
  createdAt: Date | string;
  businessId?: string;
};

function fmtDate(d: Date | string): string {
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

export default async function FeedbackPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("rbai-token")?.value;
  const payload = token ? await verifySessionToken(token) : null;
  if (!payload) {
    const refreshToken = cookieStore.get(getRefreshCookieName())?.value;
    const accessExpired = !token || verifyToken(token) === null;
    if (refreshToken && accessExpired) {
      redirect("/api/auth/restore?next=/feedback");
    }
    redirect("/login");
  }

  const admin = await getUnscopedPrisma().admin.findUnique({
    where: { id: payload.userId },
    select: { businessId: true, name: true, role: true },
  });
  if (!admin) redirect("/login");

  const isSuperAdmin = admin.businessId === null;
  let rows: FeedbackRow[];
  if (isSuperAdmin) {
    rows = (await getUnscopedPrisma().chatFeedback.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    })) as FeedbackRow[];
  } else if (admin.businessId) {
    rows = await runWithBusiness(admin.businessId, async () => {
      return (await prisma.chatFeedback.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
      })) as FeedbackRow[];
    });
  } else {
    rows = [];
  }

  const likes = rows.filter((r) => r.value === "like").length;
  const dislikes = rows.filter((r) => r.value === "dislike").length;
  // Disliked first (the owner reads wrong answers first), then newest.
  const sorted = [...rows].sort((a, b) => {
    const aBad = a.value === "dislike" ? 0 : 1;
    const bBad = b.value === "dislike" ? 0 : 1;
    if (aBad !== bBad) return aBad - bBad;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold">Reply Feedback</h1>
      <p className="text-sm text-gray-500 mt-1">
        Like and dislike taps visitors leave under AI replies. Disliked
        replies are listed first, so wrong answers are seen first.
      </p>

      <div className="flex gap-4 mt-6">
        <div className="bg-white border rounded-lg px-4 py-3">
          <div className="text-xs text-gray-500">Total taps</div>
          <div className="text-2xl font-bold">{rows.length}</div>
        </div>
        <div className="bg-white border rounded-lg px-4 py-3">
          <div className="text-xs text-gray-500">Liked (good answers)</div>
          <div className="text-2xl font-bold text-green-700">{likes}</div>
        </div>
        <div className="bg-white border rounded-lg px-4 py-3">
          <div className="text-xs text-gray-500">Disliked (wrong answers)</div>
          <div className="text-2xl font-bold text-red-700">{dislikes}</div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="mt-8 text-gray-500">
          No feedback yet. Taps appear here as soon as visitors rate a reply.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {sorted.map((r) => (
            <article
              key={r.id}
              className="bg-white border rounded-lg p-4"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={
                    r.value === "dislike"
                      ? "text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700"
                      : "text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700"
                  }
                >
                  {r.value === "dislike" ? "Disliked" : "Liked"}
                </span>
                <span className="text-xs text-gray-500">
                  {fmtDate(r.createdAt)}
                </span>
                {isSuperAdmin && r.businessId && (
                  <span className="text-xs text-gray-500">
                    Business: {r.businessId.slice(0, 8)}
                  </span>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap">{r.replyText}</p>
              <p className="mt-2 text-xs text-gray-500">
                Conversation:{" "}
                <span title={r.conversationId}>
                  {r.conversationId.slice(0, 12)}…
                </span>{" "}
                · Visitor: {r.visitorId.slice(0, 12)}… ·{" "}
                <Link
                  href="/conversations"
                  className="text-blue-600 hover:underline"
                >
                  Open conversations
                </Link>
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
