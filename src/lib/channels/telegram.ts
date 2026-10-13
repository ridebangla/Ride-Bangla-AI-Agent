import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { chat, createNewConversation } from "@/lib/ai/engine";
import { resolveCustomer } from "@/lib/customer-resolver";
import { logger } from "@/lib/logger";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    date: number;
  };
}

async function getTelegramToken(): Promise<string> {
  const settings = await prisma.settings.findFirst({
    select: { telegramBotToken: true },
  });
  return settings?.telegramBotToken || "";
}

async function getTelegramWebhookSecret(): Promise<string> {
  const settings = await prisma.settings.findFirst({
    select: { telegramWebhookSecret: true },
  });
  return settings?.telegramWebhookSecret || "";
}

/**
 * Verify the `X-Telegram-Bot-Api-Secret-Token` header Telegram sends with
 * every webhook update (H-16). Fail-closed: if no secret is configured in
 * Settings, or the header is missing/mismatched, the update is rejected.
 * The comparison is timing-safe.
 *
 * Operator setup (user action, once): generate a long random secret, store
 * it in Settings as `telegramWebhookSecret` (Settings API), then register
 * the webhook with the same secret — e.g. via `setupTelegramWebhook()` below
 * or Telegram's setWebhook API with `secret_token`.
 */
export async function verifyTelegramSecretToken(
  provided: string | null
): Promise<boolean> {
  const expected = await getTelegramWebhookSecret();
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handle incoming Telegram webhook update.
 */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<string | null> {
  const message = update.message;
  if (!message?.text) return null;

  try {
    const chatId = String(message.chat.id);
    const userName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
    const contact = message.from.username ? `@${message.from.username}` : chatId;

    const customerId = await resolveCustomer("telegram", contact, userName);

    let conversation = await prisma.conversation.findFirst({
      where: {
        channel: "telegram",
        status: { in: ["active", "escalated"] },
        OR: [{ customerId }, { customerContact: contact }],
      },
    });

    if (!conversation) {
      conversation = await createNewConversation("telegram", userName, contact, customerId);
    }

    const aiResponse = await chat(conversation.id, message.text);

    // Send reply via Telegram API
    const token = await getTelegramToken();
    if (token) {
      await sendTelegramMessage(token, message.chat.id, aiResponse);
    }

    return aiResponse;
  } catch (error) {
    logger.error("[Telegram] Failed to process update:", error);
    return null;
  }
}

/**
 * Send a message via Telegram Bot API.
 */
async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    logger.error("[Telegram] Failed to send message:", error);
    return false;
  }
}

/**
 * Set up Telegram webhook URL.
 *
 * When `secret` is provided it is sent as Telegram's `secret_token`, so
 * Telegram includes it in the `X-Telegram-Bot-Api-Secret-Token` header of
 * every update and the route can verify the update really came from
 * Telegram. Pass the same secret stored in Settings as
 * `telegramWebhookSecret`. Registering a webhook WITHOUT a secret leaves
 * the inbound endpoint rejecting all updates (fail-closed).
 */
export async function setupTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secret?: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          ...(secret ? { secret_token: secret } : {}),
        }),
      }
    );

    const data = await response.json();
    return data.ok === true;
  } catch (error) {
    logger.error("[Telegram] Failed to set webhook:", error);
    return false;
  }
}
