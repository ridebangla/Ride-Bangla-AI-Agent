import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

/**
 * Phase 5: unified inbox data.
 *
 * GET /api/inbox?channel=<tab>&status=&search=
 *
 * Tabs map to conversation channel values:
 *   website    -> "widget" + "api"   (public website chat + dashboard API)
 *   whatsapp   -> "whatsapp"         (WhatsApp Web + Cloud API)
 *   messenger  -> "messenger"        (Facebook Page messages)
 *   facebook   -> "facebook"
 *   instagram  -> "instagram"
 *   x          -> "x"
 *
 * Each conversation carries:
 *   - lastMessage (latest, for the preview line)
 *   - unread: customer messages newer than the latest admin/assistant
 *     message (honest unread definition — what the team hasn't answered)
 *   - aiEnabled: the per-conversation human-takeover switch
 */
const TAB_CHANNELS: Record<string, string[]> = {
  website: ["widget", "api"],
  whatsapp: ["whatsapp"],
  messenger: ["messenger"],
  facebook: ["facebook"],
  instagram: ["instagram"],
  x: ["x"],
};

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const tab = searchParams.get("channel") || "all";
      const status = searchParams.get("status");
      const search = searchParams.get("search");

      const where: Record<string, unknown> = {};

      if (tab !== "all") {
        const channels = TAB_CHANNELS[tab];
        if (!channels) {
          return NextResponse.json(
            { error: `Unknown inbox tab: ${tab}` },
            { status: 400 }
          );
        }
        where.channel = { in: channels };
      }

      if (status && status !== "all") {
        where.status = status;
      }

      if (search && search.trim()) {
        where.OR = [
          { customerName: { contains: search.trim(), mode: "insensitive" } },
          { customerContact: { contains: search.trim(), mode: "insensitive" } },
        ];
      }

      const [conversations, total] = await Promise.all([
        prisma.conversation.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip,
          take,
          select: {
            id: true,
            channel: true,
            customerName: true,
            customerContact: true,
            status: true,
            aiEnabled: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { messages: true } },
          },
        }),
        prisma.conversation.count({ where }),
      ]);

      // Per-conversation unread + last message. Batched: one messages query
      // per conversation is N+1, so fetch recent messages for the page in
      // a single query and compute in memory.
      const ids = conversations.map((c) => c.id);
      const recent =
        ids.length > 0
          ? await prisma.message.findMany({
              where: { conversationId: { in: ids } },
              orderBy: { createdAt: "desc" },
              take: ids.length * 40,
              select: {
                conversationId: true,
                role: true,
                content: true,
                createdAt: true,
              },
            })
          : [];

      const byConv = new Map<string, typeof recent>();
      for (const m of recent) {
        const list = byConv.get(m.conversationId) || [];
        list.push(m);
        byConv.set(m.conversationId, list);
      }

      const items = conversations.map((c) => {
        const msgs = byConv.get(c.id) || [];
        // Unread = customer messages newer than the latest admin/assistant
        // message. Messages arrive newest-first; stop at the first reply.
        let unread = 0;
        for (const m of msgs) {
          if (m.role === "customer") unread++;
          else break;
        }
        return {
          ...c,
          unread,
          lastMessage: msgs[0]
            ? {
                role: msgs[0].role,
                content: (msgs[0].content || "").slice(0, 140),
                createdAt: msgs[0].createdAt,
              }
            : null,
        };
      });

      return NextResponse.json({
        ...paginatedResponse(items, total, page, limit),
        unreadTotal: items.reduce((sum, i) => sum + i.unread, 0),
      });
    } catch (error) {
      logger.error("Failed to fetch inbox:", error);
      return NextResponse.json(
        { error: "Failed to fetch inbox" },
        { status: 500 }
      );
    }
  });
}
