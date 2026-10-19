import { prisma } from "@/lib/prisma";
import { createNewConversation } from "@/lib/ai/engine";
import { processChannelMessage } from "@/lib/channels/inbound";
import { resolveCustomer } from "@/lib/customer-resolver";
import { logger } from "@/lib/logger";
import { enterBusinessContext, resolveChannelBusiness } from "@/lib/tenant";

interface SmsConfig {
  twilioSid: string;
  twilioToken: string;
  twilioPhone: string;
}

async function getSmsConfig(): Promise<SmsConfig | null> {
  const settings = await prisma.settings.findFirst();
  if (!settings?.twilioSid || !settings?.twilioToken || !settings?.twilioPhone) return null;

  return {
    twilioSid: settings.twilioSid,
    twilioToken: settings.twilioToken,
    twilioPhone: settings.twilioPhone,
  };
}

/**
 * Handle incoming SMS message from Twilio webhook.
 */
export async function handleIncomingSms(
  from: string,
  body: string
): Promise<string> {
  const businessId = await resolveChannelBusiness();
  enterBusinessContext(businessId);
  try {
    if (!body || !body.trim()) {
      return "Please send a message and we'll be happy to help!";
    }

    const customerId = await resolveCustomer("sms", from, "SMS User");

    let conversation = await prisma.conversation.findFirst({
      where: {
        channel: "sms",
        status: { in: ["active", "escalated"] },
        OR: [{ customerId }, { customerContact: from }],
      },
    });

    if (!conversation) {
      conversation = await createNewConversation("sms", "SMS User", from, customerId);
    }

    // Phase 5: shared inbound pipeline — subscription hard-stop (user
    // decision 16) first, then the engine (honors per-conversation +
    // global aiEnabled, user decision 17). On human takeover or an
    // inactive subscription the pipeline stored the message — the route
    // answers with empty TwiML so no reply SMS goes out (pure silence).
    const chatResult = await processChannelMessage(conversation.id, businessId, body.trim());
    return chatResult.silent ? "" : chatResult.response;
  } catch (error) {
    logger.error("[SMS] Failed to process incoming message:", error);
    return "Sorry, we're experiencing issues. Please try again later.";
  }
}

/**
 * Send an outbound SMS via Twilio.
 */
export async function sendSms(
  to: string,
  message: string
): Promise<boolean> {
  const config = await getSmsConfig();
  if (!config) {
    logger.warn("[SMS] Not configured");
    return false;
  }

  try {
    const { default: twilio } = await import("twilio");
    const client = twilio(config.twilioSid, config.twilioToken);

    await client.messages.create({
      body: message,
      from: config.twilioPhone,
      to,
    });

    return true;
  } catch (error) {
    logger.error("[SMS] Failed to send message:", error);
    return false;
  }
}

