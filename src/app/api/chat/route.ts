import { NextRequest, NextResponse } from "next/server";
import { chat, createNewConversation } from "@/lib/ai/engine";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness } from "@/lib/prisma";
import {
  requireActiveSubscription,
  SubscriptionInactiveError,
} from "@/lib/subscription";

export async function POST(request: NextRequest) {
  // C-07: /api/chat previously had no auth — anyone could burn LLM tokens
  // and create conversations. Require an authenticated caller that may
  // create messages.
  const auth = await requireAuth(request, "messages:create");
  if (!isAuthenticated(auth)) return auth;

  // PHASE 3 (user decision 16 — airtight): subscription hard-stop BEFORE any
  // LLM tokens are spent or conversations are created. Inactive trial /
  // subscription => HTTP 402 + { error: "subscription_paused" }; the caller
  // renders its own "paused" state. No AI reply, no spend, no exceptions.
  try {
    await requireActiveSubscription(auth.businessId);
  } catch (err) {
    if (err instanceof SubscriptionInactiveError) {
      logger.warn(`[billing] blocked /api/chat for business ${auth.businessId}: subscription inactive`);
      return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
    }
    throw err;
  }

  return runWithBusiness(auth.businessId, async () => {

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

      const result = await chat(convId, message.trim());

      return NextResponse.json({
        conversationId: convId,
        response: result.response,
        products: result.products,
        silent: result.silent,
      });
    } catch (error) {
      logger.error("Failed to process chat message:", error);
      return NextResponse.json(
        { error: "Failed to process message" },
        { status: 500 }
      );
    }

  });
}


