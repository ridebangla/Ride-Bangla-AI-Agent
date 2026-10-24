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
 *   - confirmed orders routed to the owner instead of riders
 *     (orders with an `owner_notified` courier link, R3-ai-2),
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
  kind: "notice" | "billing" | "payment" | "ticket" | "conversation" | "website" | "order";
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

    // ---- Website-creation requests (Super Admin queue) ----
    // A business without a website applied for the IT Team to build one
    // (Settings > Websites). New ones belong in the platform team's
    // bell, next to the payment-claim review queue.
    if (!auth.businessId) {
      try {
        const apps = (await getUnscopedPrisma().websiteCreationRequest.findMany({
          orderBy: { createdAt: "desc" },
          take: 10,
        })) as unknown as Array<{
          id: string;
          businessName: string;
          status: string;
          createdAt: Date;
        }>;
        for (const app of apps) {
          if (app.status !== "new") continue;
          items.push({
            id: `website-request-${app.id}`,
            kind: "website",
            text: `Website creation request from ${app.businessName || "a business"} — waiting for the IT team.`,
            at: iso(app.createdAt ?? null),
            href: "/admin",
          });
        }
      } catch (err) {
        logger.warn("notifications: website requests read failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
        // ---- Confirmed orders routed to the owner (no courier leg) ----
        // The courier bridge records these as `owner_notified` links on
        // the order itself (re-audit #3, R3-ai-2): the order news must
        // reach the shop owner directly, so the bell surfaces them with
        // the items and the pickup → delivery addresses, like the other
        // real events in this feed. No new collection, no invented data.
        const recentOrders = (await db.order.findMany({
          orderBy: { updatedAt: "desc" },
          take: 10,
        })) as unknown as Array<{
          id: string;
          status: string;
          updatedAt: Date;
          courierBooking?: {
            state?: string;
            reason?: string;
            ownerNotification?: {
              items?: Array<{ name: string; qty: number }>;
              from?: string;
              to?: string;
            };
          } | null;
        }>;
        for (const o of recentOrders) {
          if (o.status !== "confirmed") continue;
          const link = o.courierBooking;
          if (!link || link.state !== "owner_notified") continue;
          const note = link.ownerNotification;
          const itemsText = (note?.items ?? [])
            .map((it) => `${it.qty}× ${it.name}`)
            .join(", ");
          items.push({
            id: `owner-order-${o.id}`,
            kind: "order",
            text:
              `New order confirmed — courier not available` +
              (itemsText ? ` (${itemsText})` : "") +
              (note?.from || note?.to
                ? ` — ${note?.from || "?"} → ${note?.to || "?"}`
                : "") +
              `. Please arrange delivery yourself.`,
            at: iso(o.updatedAt instanceof Date ? o.updatedAt : toDate(o.updatedAt)),
            href: "/orders",
          });
        }
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
