import { getUnscopedPrisma, runWithBusiness, prisma, withBusinessId } from "./prisma";
import { sendWhatsAppMessage } from "./channels/whatsapp";
import { sendSms } from "./channels/sms";
import { sendEmail } from "./channels/email";
import { sendTelegramMessage } from "./channels/telegram";
import { logger } from "./logger";

export interface FollowUpResult {
  processed: number;
  sent: number;
  failed: number;
}

/**
 * Deliver due follow-ups. Called by POST /api/followups/process (cron).
 * Iterates every active business (unscoped) and processes each business's
 * due follow-ups inside its own tenant context — one business's follow-ups
 * can never be sent as another's.
 */
export async function processDueFollowUps(): Promise<FollowUpResult> {
  const raw = getUnscopedPrisma();
  const businesses = await raw.business.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const total: FollowUpResult = { processed: 0, sent: 0, failed: 0 };
  for (const b of businesses) {
    const r = await runWithBusiness(b.id, () => processBusinessFollowUps());
    total.processed += r.processed;
    total.sent += r.sent;
    total.failed += r.failed;
  }
  return total;
}

async function processBusinessFollowUps(): Promise<FollowUpResult> {
  const due = await prisma.followUp.findMany({
    where: { status: "pending", dueAt: { lte: new Date() } },
    orderBy: { dueAt: "asc" },
    take: 20,
  });

  let sent = 0;
  let failed = 0;
  for (const fu of due) {
    try {
      await prisma.followUp.update({
        where: { id: fu.id },
        data: { status: "sending" },
      });

      const conv = await prisma.conversation.findUnique({
        where: { id: fu.conversationId },
      });
      if (!conv) throw new Error("Conversation not found");

      const delivered = await deliverToChannel(conv.channel, conv.customerContact, fu.message);

      // Keep the conversation history complete: the follow-up is stored as
      // an assistant message either way.
      await prisma.message.create({
        data: withBusinessId({
          conversationId: conv.id,
          role: "assistant",
          content: fu.message,
        }),
      });

      await prisma.followUp.update({
        where: { id: fu.id },
        data: { status: delivered ? "sent" : "failed" },
      });
      delivered ? sent++ : failed++;
    } catch (err) {
      logger.warn("[followups] delivery failed", {
        followUpId: fu.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await prisma.followUp
        .update({ where: { id: fu.id }, data: { status: "failed" } })
        .catch(() => {});
      failed++;
    }
  }
  return { processed: due.length, sent, failed };
}

/**
 * Best-effort delivery through the conversation's original channel.
 * Returns true when the message was handed to the channel (or, for the
 * website widget which has no push, stored in the conversation for the
 * visitor's next visit).
 */
async function deliverToChannel(
  channel: string,
  contact: string,
  text: string
): Promise<boolean> {
  try {
    switch (channel) {
      case "whatsapp":
        return await sendWhatsAppMessage(contact, text);
      case "sms":
        return await sendSms(contact, text);
      case "email": {
        const settings = await prisma.settings.findFirst();
        if (!settings?.smtpHost || !contact) return false;
        return await sendEmail(contact, `Follow-up from ${settings.businessName}`, text);
      }
      case "telegram": {
        const settings = await prisma.settings.findFirst();
        const token = settings?.telegramBotToken;
        const chatId = Number(contact);
        if (!token || !Number.isFinite(chatId)) return false;
        return await sendTelegramMessage(token, chatId, text);
      }
      case "widget":
        // No push channel for the website widget; the message is stored in
        // the conversation and shown on the visitor's next visit.
        return true;
      default:
        logger.warn("[followups] unknown channel, storing only", { channel });
        return true;
    }
  } catch (err) {
    logger.warn("[followups] channel delivery error", {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
