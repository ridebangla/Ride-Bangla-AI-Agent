/**
 * /api/orders — Phase 2: tenant-scoped order list (dashboard).
 * GET — latest 100 orders, newest first. Permission: tickets:read
 * (operational queue, same audience as tickets).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  CHANNEL_FILTERS,
  filterOrdersByChannel,
  resolveChannel,
  type ChannelFilter,
} from "@/lib/order-dashboard";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const status = request.nextUrl.searchParams.get("status");
      const where: Record<string, unknown> = {};
      if (status && ["pending", "confirmed", "cancelled"].includes(status)) {
        where.status = status;
      }
      // LEG E: channel filter, resolved from RECORDED sources only
      // (order.channel when present, else the linked conversation's
      // channel, else "unknown"). An invalid value is ignored, mirroring
      // the existing status handling above — never a 500, never a guess.
      const channelParam = request.nextUrl.searchParams.get("channel");
      const channelFilter: ChannelFilter =
        channelParam !== null &&
        (CHANNEL_FILTERS as string[]).includes(channelParam) &&
        channelParam !== "all"
          ? (channelParam as ChannelFilter)
          : "all";
      // The channel join cannot be expressed in the where clause (the
      // mapping messenger->facebook etc. lives in order-dashboard.ts),
      // so when a channel filter is active the newest 1000 are pooled,
      // filtered in memory, and the newest 100 are returned. Without a
      // channel filter the original newest-100 query is unchanged.
      // Counters over the FULL set live in /api/orders/summary, not here.
      const pool = await prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: channelFilter === "all" ? 100 : 1000,
      });
      const conversationIds = [
        ...new Set(
          (pool as Array<{ conversationId?: unknown }>)
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
      const withChannel = (pool as Array<Record<string, unknown>>).map((o) => {
        const resolved = resolveChannel({
          id: String(o.id ?? ""),
          status: String(o.status ?? ""),
          channel: typeof o.channel === "string" ? o.channel : null,
          conversationChannel:
            typeof o.conversationId === "string"
              ? (conversationChannelById.get(o.conversationId) ?? null)
              : null,
        });
        return { ...o, channel: resolved.channel };
      });
      const orders =
        channelFilter === "all"
          ? withChannel.slice(0, 100)
          : filterOrdersByChannel(
              withChannel.map((o) => ({
                ...o,
                id: String((o as { id?: unknown }).id ?? ""),
                status: String((o as { status?: unknown }).status ?? ""),
                channel: o.channel as string,
              })),
              channelFilter,
            ).slice(0, 100);
      // Courier bridge: attach the LIVE delivery status (read back from
      // the ops courier doc) for orders that have a booking, so the
      // dashboard shows real rider-side state. Best-effort by design —
      // any bridge failure returns the plain list untouched.
      let enriched: unknown = orders;
      try {
        const { getCourierDeliveryStatus, readBookingLink } = await import(
          "@/lib/courier-bridge"
        );
        enriched = await Promise.all(
          (orders as Array<{ id: string; courierBooking?: unknown }>).map(
            async (o) => {
              if (!readBookingLink(o)?.courierOrderId) return o;
              const courierDelivery = await getCourierDeliveryStatus(
                o.id
              ).catch(() => null);
              return courierDelivery ? { ...o, courierDelivery } : o;
            }
          )
        );
      } catch {
        enriched = orders;
      }
      return NextResponse.json({ orders: enriched });
    } catch (error) {
      logger.error("Failed to fetch orders:", error);
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 });
    }
  });
}
