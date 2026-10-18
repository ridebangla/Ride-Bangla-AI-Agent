import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "messages:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;

    const conversation = await prisma.conversation.findUnique({
      where: { id },
    });
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const notes = await prisma.internalNote.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(notes);
  } catch (error) {
    logger.error("Failed to fetch internal notes:", error);
    return NextResponse.json(
      { error: "Failed to fetch internal notes" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "messages:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;
    const body = await request.json();
    const { content, authorName } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id },
    });
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const note = await prisma.internalNote.create({
      data: withBusinessId({
        conversationId: id,
        content: content.trim(),
        authorName: authorName?.trim() || "Admin",
      }),
    });

    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    logger.error("Failed to create internal note:", error);
    return NextResponse.json(
      { error: "Failed to create internal note" },
      { status: 500 }
    );
  }
}
