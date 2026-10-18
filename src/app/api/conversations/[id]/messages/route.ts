import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { emitNewMessage } from "@/lib/realtime";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "messages:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

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

      const messages = await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" },
      });

      return NextResponse.json(messages);
    } catch (error) {
      logger.error("Failed to fetch messages:", error);
      return NextResponse.json(
        { error: "Failed to fetch messages" },
        { status: 500 }
      );
    }

  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "messages:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { content, role } = body;

      if (!content || typeof content !== "string" || content.trim().length === 0) {
        return NextResponse.json(
          { error: "Message content is required" },
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

      const validRoles = ["customer", "assistant", "system"];
      const messageRole = validRoles.includes(role) ? role : "assistant";

      const message = await prisma.message.create({
        data: withBusinessId({
          conversationId: id,
          role: messageRole,
          content: content.trim(),
        }),
      });

      await prisma.conversation.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      emitNewMessage(id, { id: message.id, role: messageRole, content: content.trim() });

      return NextResponse.json(message, { status: 201 });
    } catch (error) {
      logger.error("Failed to create message:", error);
      return NextResponse.json(
        { error: "Failed to create message" },
        { status: 500 }
      );
    }

  });
}
