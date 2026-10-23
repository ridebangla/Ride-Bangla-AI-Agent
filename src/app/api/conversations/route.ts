import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const channel = searchParams.get("channel");
      const status = searchParams.get("status");
      const search = searchParams.get("search");

      const where: Record<string, unknown> = {};

      if (channel && channel !== "all") {
        where.channel = channel;
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

      // Q-QUOTA (2026-10-23): this list used to be ONE findMany with
      // messages + _count + tags includes. Through the data layer each
      // include re-fetched the child collection PER ROW (20 rows × the
      // business's whole message set, twice — include and _count —
      // plus a conversationTags scan per row): ~64,600 reads/load at
      // audit sizes. The list UI (conversations/page.tsx) actually
      // shows, per row: the LATEST message only (messages[0]), the
      // message count, and the row's tags. So the enrichment is now
      // batched and bounded, with the identical response shape:
      //  - messages: one FK-prefiltered, server-limited query per row
      //    (where conversationId ==, newest first, take 1) → ≤1 read/row
      //  - _count.messages: one count per row (Firestore aggregation
      //    in the data layer for equality wheres; ~1 read/row)
      //  - tags: ONE conversationTag query for the whole page
      //    (conversationId IN page ids; business-prefiltered in the
      //    data layer) + ONE tag query for the referenced tag ids,
      //    assembled in memory — no per-row scans.
      const [conversations, total] = await Promise.all([
        prisma.conversation.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip,
          take,
        }),
        prisma.conversation.count({ where }),
      ]);

      const rows = conversations as unknown as Array<
        Record<string, unknown> & { id: string }
      >;
      if (rows.length > 0) {
        const ids = rows.map((c) => c.id);
        const [tagRows, ...perRow] = await Promise.all([
          prisma.conversationTag.findMany({
            where: { conversationId: { in: ids } },
          }),
          ...rows.flatMap((c) => [
            prisma.message.findMany({
              where: { conversationId: c.id },
              orderBy: { createdAt: "desc" },
              take: 1,
            }),
            prisma.message.count({ where: { conversationId: c.id } }),
          ]),
        ]);
        const latestByConv = new Map<string, unknown[]>();
        const countByConv = new Map<string, number>();
        rows.forEach((c, i) => {
          latestByConv.set(c.id, (perRow[i * 2] as unknown[]) ?? []);
          countByConv.set(c.id, (perRow[i * 2 + 1] as number) ?? 0);
        });
        const ctRows = (tagRows ?? []) as Array<
          Record<string, unknown> & { conversationId: string; tagId: string }
        >;
        const tagIds = [...new Set(ctRows.map((ct) => ct.tagId))];
        const tagDocs =
          tagIds.length > 0
            ? ((await prisma.tag.findMany({
                where: { id: { in: tagIds } },
              })) as unknown as Array<
                Record<string, unknown> & { id: string }
              >)
            : [];
        const tagById = new Map(tagDocs.map((t) => [t.id, t]));
        const tagsByConv = new Map<string, unknown[]>();
        for (const ct of ctRows) {
          const list = tagsByConv.get(ct.conversationId) ?? [];
          list.push({ ...ct, tag: tagById.get(ct.tagId) ?? null });
          tagsByConv.set(ct.conversationId, list);
        }
        for (const c of rows) {
          c.messages = latestByConv.get(c.id) ?? [];
          c._count = { messages: countByConv.get(c.id) ?? 0 };
          c.tags = tagsByConv.get(c.id) ?? [];
        }
      }

      return NextResponse.json(paginatedResponse(conversations, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch conversations:", error);
      return NextResponse.json(
        { error: "Failed to fetch conversations" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "conversations:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const body = await request.json();
      const { channel, customerName, customerContact, status } = body;

      if (!channel || typeof channel !== "string") {
        return NextResponse.json(
          { error: "Channel is required" },
          { status: 400 }
        );
      }

      const conversation = await prisma.conversation.create({
        data: withBusinessId({
          channel: channel.trim(),
          customerName: customerName?.trim() || "Unknown",
          customerContact: customerContact?.trim() || "",
          status: status || "active",
        }),
        include: {
          messages: {
            take: 1,
            orderBy: { createdAt: "desc" },
          },
          _count: {
            select: { messages: true },
          },
          tags: {
            include: { tag: true },
          },
        },
      });

      return NextResponse.json(conversation, { status: 201 });
    } catch (error) {
      logger.error("Failed to create conversation:", error);
      return NextResponse.json(
        { error: "Failed to create conversation" },
        { status: 500 }
      );
    }

  });
}
