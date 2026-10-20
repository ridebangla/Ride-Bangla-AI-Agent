/**
 * GET /api/notifications — the dashboard bell feed.
 *
 * A-to-Z audit 2026-10-20 (owner: "the notification bar doesn't work"):
 * the header bell was a dead button with a HARDCODED red dot — no panel,
 * no API, no data source, nothing that could ever arrive or clear.
 *
 * This feed aggregates the tenant's REAL, already-produced events —
 * no new collection and no invented data:
 *   - adminNotice posted by the platform team (business doc, via the
 *     Admin Console) + billing countdown warnings (trial/usage),
 *   - the tenant's own payment claims and their status changes
 *     (payment_claims — pending / approved / rejected),
 *   - open support/order tickets (tickets, latest first),
 *   - recent customer conversations (conversations, latest first).
 * The bell's unread dot is driven by `latestAt` vs the client's stored
 * seen-watermark, so it lights up on genuinely new items and clears
 * when the panel is opened. Super Admin (businessId null) sees pending
 * payment claims across the platform — their review queue.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { getAdminDb } from "@/lib/admin-db";
import { getBillingCountdown, toDate } from "@/lib/billing-usage";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface NotificationItem {
  id: string;
  kind: "notice" | "billing" | "payment" | "ticket" | "conversation";
  text: string;
  at: string | null;
  href: string;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!isAuthenticated(auth)) return auth;

  const items: NotificationItem[] = [];
  try {
    // ---- Payment claims (Admin SDK collection, not a prisma model) ----
    try {
      const db = getAdminDb();
      let q = db.collection("payment_claims").orderBy("createdAt", "desc").limit(10);
      if (auth.businessId) q = q.where("businessId", "==", auth.businessId);
      const snap = await q.get();
      for (const doc of snap.docs) {
        const c = doc.data() as Record<string, unknown>;
        const status = typeof c.status === "string" ? c.status : "pending";
        const at = toDate(c.reviewedAt) ?? toDate(c.createdAt);
        const label =
          c.kind === "wallet_deposit" ? "Wallet deposit claim" : "Payment claim";
        items.push({
          id: `claim-${doc.id}`,
          kind: "payment",
          text:
            status === "approved"
              ? `${label} approved — your plan/balance is updated.`
              : status === "rejected"
                ? `${label} was rejected${c.rejectReason ? `: ${String(c.rejectReason)}` : ""}.`
                : auth.businessId
                  ? `${label} submitted — waiting for verification.`
                  : `${label} from a business is waiting for review.`,
          at: iso(at),
          href: auth.businessId ? "/billing" : "/admin",
        });
      }
    } catch (err) {
      logger.warn("notifications: claims read failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (auth.businessId) {
      const businessId = auth.businessId;
      // ---- Billing warnings + team notice (same source as the banner) ----
      const countdown = await getBillingCountdown(businessId).catch(() => null);
      if (countdown?.adminNotice?.message) {
        items.push({
          id: "admin-notice",
          kind: "notice",
          text: `Notice from our team: ${countdown.adminNotice.message}`,
          at: iso(countdown.adminNotice.createdAt ?? null),
          href: "/billing",
        });
      }
      for (const [i, n] of (countdown?.notices ?? []).entries()) {
        items.push({
          id: `billing-${n.type}-${i}`,
          kind: "billing",
          text:
            n.type === "days"
              ? n.daysRemaining <= 0
                ? "Your billing period ends today."
                : `Your billing period ends in ${n.daysRemaining} day${n.daysRemaining === 1 ? "" : "s"}.`
              : `You have used ${n.percentUsed}% of your AI messages this period.`,
          at: null,
          href: "/billing",
        });
      }

      await runWithBusiness(businessId, async () => {
        const db = getUnscopedPrisma();
        const tickets = (await db.ticket.findMany({
          where: { status: "open" },
          orderBy: { createdAt: "desc" },
          take: 5,
        })) as unknown as Array<{ id: string; title: string; createdAt: Date }>;
        for (const t of tickets) {
          items.push({
            id: `ticket-${t.id}`,
            kind: "ticket",
            text: `Open ticket: ${t.title}`,
            at: iso(t.createdAt instanceof Date ? t.createdAt : toDate(t.createdAt)),
            href: "/tickets",
          });
        }
        const convs = (await db.conversation.findMany({
          orderBy: { updatedAt: "desc" },
          take: 5,
        })) as unknown as Array<{
          id: string;
          customerName: string;
          channel: string;
          updatedAt: Date;
          createdAt: Date;
        }>;
        for (const c of convs) {
          const at = c.updatedAt ?? c.createdAt;
          items.push({
            id: `conv-${c.id}`,
            kind: "conversation",
            text: `Conversation with ${c.customerName || "a customer"} (${c.channel})`,
            at: iso(at instanceof Date ? at : toDate(at)),
            href: "/inbox",
          });
        }
      });
    }

    items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
    const latestAt = items.find((i) => i.at)?.at ?? null;
    return NextResponse.json({ items: items.slice(0, 20), latestAt });
  } catch (err) {
    logger.error("notifications feed failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to load notifications." },
      { status: 500 }
    );
  }
}
