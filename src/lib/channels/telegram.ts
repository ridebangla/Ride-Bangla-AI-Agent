import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { createNewConversation } from "@/lib/ai/engine";
import { processChannelMessage } from "@/lib/channels/inbound";
import { reportActivity, clearActivity } from "@/lib/ai/activity";
import { resolveCustomer } from "@/lib/customer-resolver";
import { logger } from "@/lib/logger";
import { enterBusinessContext, resolveChannelBusiness } from "@/lib/tenant";

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
    caption?: string;
    photo?: { file_id: string; width: number; height: number }[];
    voice?: { file_id: string; mime_type?: string };
    video?: { file_id: string; mime_type?: string };
    date: number;
  };
}

/** Download a Telegram file_id into bytes via the Bot API. */
async function downloadTelegramFile(
  token: string,
  fileId: string
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) return null;
  const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string } };
  const filePath = info.result?.file_path;
  if (!filePath) return null;
  const dlRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!dlRes.ok) return null;
  const bytes = Buffer.from(await dlRes.arrayBuffer());
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mimeType =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "mp4"
          ? "video/mp4"
          : ext === "ogg" || ext === "oga"
            ? "audio/ogg"
            : "application/octet-stream";
  return { bytes, mimeType };
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
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  businessSlug?: string | null
): Promise<string | null> {
  const businessId = await resolveChannelBusiness(businessSlug);
  enterBusinessContext(businessId);
  const message = update.message;
  if (!message) return null;

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

    // Text, photo, voice or video — media goes through the brain's real
    // perception path (vision / Whisper), never just a label.
    const token = await getTelegramToken();
    let text = message.text ?? message.caption ?? "";
    let media: { kind: "image" | "video" | "audio"; mimeType: string; bytes: Buffer } | undefined;

    if (!text && token) {
      const fileId = message.photo?.length
        ? message.photo[message.photo.length - 1].file_id
        : message.voice?.file_id ?? message.video?.file_id;
      const kind = message.photo?.length ? "image" : message.voice ? "audio" : message.video ? "video" : null;
      if (fileId && kind) {
        const dl = await downloadTelegramFile(token, fileId).catch(() => null);
        if (dl && dl.bytes.length > 0 && dl.bytes.length < 15 * 1024 * 1024) {
          media = { kind: kind as "image" | "video" | "audio", mimeType: dl.mimeType, bytes: dl.bytes };
          text = message.caption ?? "";
        }
      }
    }

    if (!text && !media) return null;

    // Phase 5: shared inbound pipeline — subscription hard-stop (user
    // decision 16) first, then the engine (honors per-conversation +
    // global aiEnabled, user decision 17). On human takeover or an
    // inactive subscription the pipeline stored the message — send nothing.
    const chatResult = await processChannelMessage(
      conversation.id,
      businessId,
      text,
      media ? { media } : undefined
    );

    // Send reply via Telegram API
    if (!chatResult.silent) {
      if (token) {
        // Live activity: caption the real Telegram send while it runs.
        await reportActivity(conversation.id, "sending_reply", { channel: "telegram" });
        try {
          await sendTelegramMessage(token, message.chat.id, chatResult.response);
        } finally {
          await clearActivity(conversation.id);
        }
      }
      return chatResult.response;
    }
    return null;
  } catch (error) {
    logger.error("[Telegram] Failed to process update:", error);
    return null;
  }
}

/**
 * Send a message via Telegram Bot API. Exported for the follow-up dispatcher.
 */
export async function sendTelegramMessage(
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

