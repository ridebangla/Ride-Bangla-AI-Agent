/**
 * Phase 5: owner-reply delivery for the inbox live-chat view
 * (user decision 17).
 *
 * When the business owner replies from a thread, the reply is ALWAYS stored
 * in the conversation first. Then delivery back through the channel's send
 * API is attempted — but ONLY when that channel is actually connected
 * (env-gated / token-gated). When the channel is not connected the reply
 * is stored honestly as a "dashboard-only reply" and the UI says so.
 *
 * Never throws — a send failure is a delivery note, not a 500.
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { sendWhatsAppMessage } from "@/lib/channels/whatsapp";
import {
  isWhatsAppCloudConfigured,
  sendWhatsAppCloudMessage,
} from "@/lib/channels/whatsapp-cloud";
import { sendTelegramMessage } from "@/lib/channels/telegram";
import { sendSms } from "@/lib/channels/sms";
import { sendEmail } from "@/lib/channels/email";
import { sendMetaMessage } from "@/lib/channels/meta";
import { sendXDM, isXWriteConfigured } from "@/lib/social/x";

export interface DeliveryAttempt {
  delivered: boolean;
  /** Honest, UI-safe note: "delivered via whatsapp" or the reason it stayed dashboard-only. */
  deliveryNote: string;
}

interface ConversationForDelivery {
  channel: string;
  customerContact: string;
  metadata?: unknown;
}

/**
 * Attempt to deliver an owner reply through the conversation's channel.
 * Must run inside the business's tenant context (settings reads).
 */
export async function deliverOwnerReply(
  conversation: ConversationForDelivery,
  text: string
): Promise<DeliveryAttempt> {
  const channel = conversation.channel;
  const to = conversation.customerContact;

  try {
    switch (channel) {
      case "whatsapp": {
        // Prefer the official Cloud API when configured; fall back to the
        // connected WhatsApp Web session.
        if (isWhatsAppCloudConfigured()) {
          const ok = await sendWhatsAppCloudMessage(to, text);
          return ok
            ? { delivered: true, deliveryNote: "delivered via WhatsApp" }
            : { delivered: false, deliveryNote: "WhatsApp send failed — stored as dashboard-only reply" };
        }
        const ok = await sendWhatsAppMessage(to, text).catch(() => false);
        return ok
          ? { delivered: true, deliveryNote: "delivered via WhatsApp" }
          : {
              delivered: false,
              deliveryNote: "dashboard-only reply (WhatsApp not connected)",
            };
      }

      case "telegram": {
        const settings = await prisma.settings.findFirst({
          select: { telegramBotToken: true },
        });
        const token = settings?.telegramBotToken || "";
        const chatId = Number(to);
        if (!token || !Number.isFinite(chatId)) {
          return {
            delivered: false,
            deliveryNote: "dashboard-only reply (Telegram bot not connected)",
          };
        }
        const ok = await sendTelegramMessage(token, chatId, text);
        return ok
          ? { delivered: true, deliveryNote: "delivered via Telegram" }
          : { delivered: false, deliveryNote: "Telegram send failed — stored as dashboard-only reply" };
      }

      case "sms": {
        const ok = await sendSms(to, text);
        return ok
          ? { delivered: true, deliveryNote: "delivered via SMS" }
          : {
              delivered: false,
              deliveryNote: "dashboard-only reply (SMS/Twilio not connected)",
            };
      }

      case "email": {
        const ok = await sendEmail(to, "Re: your message", text);
        return ok
          ? { delivered: true, deliveryNote: "delivered via email" }
          : {
              delivered: false,
              deliveryNote: "dashboard-only reply (email not connected)",
            };
      }

      case "messenger":
      case "instagram": {
        const meta = (conversation.metadata || {}) as { metaPageId?: string };
        const pageId = meta.metaPageId;
        if (!pageId) {
          return {
            delivered: false,
            deliveryNote: `dashboard-only reply (no connected ${channel} account for this thread)`,
          };
        }
        const ok = await sendMetaMessage(pageId, to, text);
        return ok
          ? { delivered: true, deliveryNote: `delivered via ${channel === "instagram" ? "Instagram" : "Messenger"}` }
          : {
              delivered: false,
              deliveryNote: `dashboard-only reply (${channel} send failed or account disconnected)`,
            };
      }

      case "x": {
        if (!isXWriteConfigured()) {
          return {
            delivered: false,
            deliveryNote: "dashboard-only reply (X not connected)",
          };
        }
        const ok = await sendXDM(to, text);
        return ok
          ? { delivered: true, deliveryNote: "delivered via X DM" }
          : { delivered: false, deliveryNote: "X DM send failed — stored as dashboard-only reply" };
      }

      default:
        // widget / api / phone / facebook: no outbound send path for owner
        // replies — the website widget polls the thread, so the reply is
        // visible there on next refresh.
        return {
          delivered: false,
          deliveryNote:
            channel === "widget" || channel === "api"
              ? "stored — visible in the website chat on refresh"
              : "dashboard-only reply (no send path for this channel)",
        };
    }
  } catch (err) {
    logger.warn("[deliver] owner reply send threw", {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      delivered: false,
      deliveryNote: "dashboard-only reply (send error — see logs)",
    };
  }
}
