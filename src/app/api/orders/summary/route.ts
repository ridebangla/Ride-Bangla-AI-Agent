/**
 * /api/orders/summary — LEG E (Presswayy-video round 2): orders dashboard
 * counters, computed from REAL orders only.
 *
 * NEW FILE (no HEAD file modified). Tenant-scoped via runWithBusiness,
 * same audience as the orders list (tickets:read). A null-businessId
 * Super Admin gets the same fail-closed behaviour as the list route:
 * runWithBusiness with a null business throws rather than leaking
 * another tenant's orders (see the list route's existing pattern).
 *
 * WHY A SEPARATE ROUTE: the list route caps at the newest 100 orders.
 * Counters computed from that page would be wrong the moment a tenant
 * has 101 orders. This route therefore scans the tenant's full order
 * set (in-memory aggregation, the same pattern Leg F used for
 * attribution). Scale caveat, stated plainly: for very large order
 * histories this scan should move to a database aggregate; it is NOT
 * claimed to be a large-catalog solution (see LEG-REPORT.md §8).
 *
 * Response:
 *   { counters, channelCounts, ordersWithChannel }
 * where counters is computeCounters() over the full set, channelCounts
 * is countByChannel() over the full set, and ordersWithChannel is the
 * per-order resolved channel for the newest 100 (so the dashboard can
 * render a channel column without a second join). Channel resolution
 * follows src/lib/order-dashboard.ts: order.channel when present, else
 * the linked conversation's channel, else "unknown" — never guessed.
 * Shopify / WooCommerce counts are honestly 0 until a store integration
 * records that source; no HEAD code writes such a channel (see module
 * header + LEG-REPORT.md §1).
 *
 * Sales: per-currency buckets only, never merged, never converted
 * (see computeCounters). The dashboard must show the breakdown when
 * totalSales is null (2+ currencies).
 *
 * This route writes nothing, books nothing, and touches no courier
 * state. The invoice is rendered client-side from the order record;
 * this route is counters only.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  computeCounters,
  countByChannel,
  resolveChannel,
} from "@/lib/order-dashboard";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const orders = (await prisma.order.findMany({
        orderBy: { createdAt: "desc" },
      })) as Array<Record<string, unknown>>;

      // Resolve each order's channel from its linked conversation.
      // Tenant-scoped: the scoped prisma client only returns this
      // business's conversations, and an order whose conversation belongs
      // to another business resolves to "unknown" (never to that
      // conversation's channel) because the lookup simply finds nothing.
      const conversationIds = [
        ...new Set(
          orders
            .map((o) => o.conversationId)
            .filter((v): v is string => typeof v === "string" && v !== ""),
        ),
      ];
      const conversationChannelById = new Map<string, string>();
      if (conversationIds.length > 0) {
        const conversations = (await prisma.conversation.findMany({
          where: { id: { in: conversationIds } },
          select: { id: true, channel: true },
        })) as Array<{ id: string; channel?: unknown }>;
        for (const c of conversations) {
          if (typeof c.channel === "string") {
            conversationChannelById.set(c.id, c.channel);
          }
        }
      }

      const dashboardOrders = orders.map((o) => ({
        id: String(o.id ?? ""),
        status: String(o.status ?? ""),
        total: typeof o.total === "number" ? o.total : null,
        currency:
          typeof o.currency === "string" ? o.currency : null,
        channel: typeof o.channel === "string" ? o.channel : null,
        conversationChannel:
          typeof o.conversationId === "string"
            ? (conversationChannelById.get(o.conversationId) ?? null)
            : null,
        courierDeliveryPhase: null as string | null,
        courierDelivery: null as { phase?: unknown } | null,
      }));

      // Best-effort courier-phase enrichment (same pattern as the list
      // route): only orders with a booking link get a phase lookup, so
      // "completed" counts confirmed orders whose rider phase is exactly
      // "delivered". Any bridge failure leaves the phase null, which
      // computeCounters treats as in-progress — never as completed.
      // Own-delivery confirmed orders have no booking link and therefore
      // no phase: they stay in-progress honestly (see module header).
      try {
        const { getCourierDeliveryStatus, readBookingLink } = await import(
          "@/lib/courier-bridge"
        );
        const rawById = new Map(orders.map((o) => [String(o.id ?? ""), o]));
        await Promise.all(
          dashboardOrders.map(async (d) => {
            const raw = rawById.get(d.id);
            if (!raw || !readBookingLink(raw)?.courierOrderId) return;
            const delivery = await getCourierDeliveryStatus(d.id).catch(
              () => null,
            );
            if (delivery && typeof delivery === "object") {
              d.courierDelivery = delivery as { phase?: unknown };
            }
          }),
        );
      } catch {
        // Best-effort only: counters stay valid without phases.
      }

      const counters = computeCounters(dashboardOrders);
      const channelCounts = countByChannel(dashboardOrders);
      const ordersWithChannel = dashboardOrders.slice(0, 100).map((o) => ({
        id: o.id,
        channel: resolveChannel(o).channel,
        rawChannel: resolveChannel(o).rawChannel,
        channelSource: resolveChannel(o).source,
      }));

      return NextResponse.json({ counters, channelCounts, ordersWithChannel });
    } catch (error) {
      logger.error("Failed to compute orders summary:", error);
      return NextResponse.json(
        { error: "Failed to compute orders summary" },
        { status: 500 },
      );
    }
  });
}
