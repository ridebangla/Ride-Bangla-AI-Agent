import { NextRequest, NextResponse } from "next/server";
import { chat, createNewConversation } from "@/lib/ai/engine";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  // C-07: /api/chat previously had no auth — anyone could burn LLM tokens
  // and create conversations. Require an authenticated caller that may
  // create messages.
  const auth = await requireAuth(request, "messages:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { message, conversationId, channel, customerName, customerContact } = body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    if (message.length > 10000) {
      return NextResponse.json({ error: "Message exceeds maximum length of 10000 characters" }, { status: 400 });
    }

    let convId = conversationId;

    if (!convId) {
      const conversation = await createNewConversation(
        channel || "api",
        customerName || "API User",
        customerContact || ""
      );
      convId = conversation.id;
    }

    const response = await chat(convId, message.trim());

    return NextResponse.json({
      conversationId: convId,
      response,
    });
  } catch (error) {
    logger.error("Failed to process chat message:", error);
    return NextResponse.json(
      { error: "Failed to process message" },
      { status: 500 }
    );
  }
}
