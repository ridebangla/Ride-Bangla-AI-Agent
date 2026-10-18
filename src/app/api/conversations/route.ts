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

      const [conversations, total] = await Promise.all([
        prisma.conversation.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip,
          take,
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
        }),
        prisma.conversation.count({ where }),
      ]);

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
