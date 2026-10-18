import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, withBusinessIdMany } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { emitConversationUpdate } from "@/lib/realtime";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
        customer: true,
        tags: {
          include: { tag: true },
        },
        tickets: {
          include: {
            department: true,
            assignedTo: true,
          },
        },
        _count: {
          select: { messages: true },
        },
      },
    });

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(conversation);
  } catch (error) {
    logger.error("Failed to fetch conversation:", error);
    return NextResponse.json(
      { error: "Failed to fetch conversation" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;
    const body = await request.json();
    const { status, customerName, customerContact, summary, satisfaction, tagIds } = body;

    const validStatuses = ["active", "resolved", "closed", "escalated", "snoozed"];
    if (status !== undefined && !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    if (satisfaction !== undefined && satisfaction !== null) {
      if (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) {
        return NextResponse.json(
          { error: "Satisfaction must be an integer between 1 and 5" },
          { status: 400 }
        );
      }
    }

    const existing = await prisma.conversation.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const conversation = await prisma.conversation.update({
      where: { id },
      data: {
        ...(status !== undefined && { status }),
        ...(customerName !== undefined && { customerName: customerName.trim() }),
        ...(customerContact !== undefined && { customerContact: customerContact.trim() }),
        ...(summary !== undefined && { summary: summary.trim() }),
        ...(satisfaction !== undefined && { satisfaction }),
      },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
        tags: {
          include: { tag: true },
        },
        _count: {
          select: { messages: true },
        },
      },
    });

    if (tagIds && Array.isArray(tagIds)) {
      await prisma.conversationTag.deleteMany({
        where: { conversationId: id },
      });

      if (tagIds.length > 0) {
        await prisma.conversationTag.createMany({
          data: withBusinessIdMany(
            tagIds.map((tagId: string) => ({
              conversationId: id,
              tagId,
            }))
          ),
        });
      }

      const updated = await prisma.conversation.findUnique({
        where: { id },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
          tags: { include: { tag: true } },
          _count: { select: { messages: true } },
        },
      });

      return NextResponse.json(updated);
    }

    emitConversationUpdate(id, { status, customerName });

    return NextResponse.json(conversation);
  } catch (error) {
    logger.error("Failed to update conversation:", error);
    return NextResponse.json(
      { error: "Failed to update conversation" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:delete");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;

    const existing = await prisma.conversation.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    await prisma.conversation.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete conversation:", error);
    return NextResponse.json(
      { error: "Failed to delete conversation" },
      { status: 500 }
    );
  }
}
