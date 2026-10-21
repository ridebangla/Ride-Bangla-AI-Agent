import { getUnscopedPrisma, runWithBusiness, prisma, withBusinessId } from "./prisma";
import { sendWhatsAppMessage } from "./channels/whatsapp";
import { sendSms } from "./channels/sms";
import { sendEmail } from "./channels/email";
import { sendTelegramMessage } from "./channels/telegram";
import { reportActivity, clearActivity } from "./ai/activity";
import {
  getBehaviourSettings,
  droppedRevivalText,
  resolveBehaviourLang,
  type BehaviourSettings,
} from "./ai/behaviour";
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
  // Behaviour package (owner directive 2026-10-21): the business's
  // behaviour settings govern the PROACTIVE touches created here. When
  // follow-ups are off, nothing new is created — already-scheduled
  // follow-ups (incl. customer-requested reminders) still deliver below.
  const settings = await prisma.settings.findFirst();
  const behaviour = getBehaviourSettings(settings);
  if (behaviour.followUpsEnabled) {
    await createDroppedRevivalFollowUps(
      behaviour,
      settings?.businessName ?? "",
      typeof settings?.language === "string" ? settings.language : undefined
    ).catch((err) => {
      logger.warn("[followups] dropped-revival scan failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

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

      // Behaviour package: a proactive send is agent work — make it
      // visible in the same live-activity system as conversational
      // sends (owners see "Your agent is sending the reply…" on the
      // conversation while the follow-up goes out).
      await reportActivity(conv.id, "sending_reply", { channel: conv.channel });
      let delivered = false;
      try {
        delivered = await deliverToChannel(conv.channel, conv.customerContact, fu.message);
      } finally {
        await clearActivity(conv.id);
      }

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

/** Never revive a conversation that has been quiet longer than this —
 *  a fortnight-old thread gets a fresh start from the customer, not a
 *  surprise message from us. */
const REVIVAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Per business per processor run — the processor runs on a cron
 *  cadence, so a backlog trickles out instead of blasting. */
const REVIVAL_MAX_PER_RUN = 10;

/**
 * Behaviour package: create ONE revival follow-up for each dropped
 * conversation — the agent spoke last, the customer went quiet for at
 * least the business's `followUpDroppedHours`, and the thread is still
 * open. The created records are due immediately, so the normal delivery
 * loop below sends them in the same run through each conversation's own
 * channel (channel send functions fail honestly outside their delivery
 * windows, e.g. WhatsApp's 24h rule → the record lands as "failed",
 * never faked as sent).
 *
 * Hard guards: human-takeover conversations (aiEnabled false) are
 * never touched; closed/escalated threads are left alone; blocked
 * customers are skipped; a conversation gets at most ONE revival ever
 * (the kind check), so nobody is nagged repeatedly.
 */
async function createDroppedRevivalFollowUps(
  behaviour: BehaviourSettings,
  businessName: string,
  settingsLanguage: string | undefined
): Promise<number> {
  const now = Date.now();
  const quietMs = behaviour.followUpDroppedHours * 60 * 60 * 1000;

  const conversations = await prisma.conversation.findMany({
    orderBy: { updatedAt: "asc" },
    take: 100,
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  let created = 0;
  for (const conv of conversations) {
    if (created >= REVIVAL_MAX_PER_RUN) break;
    if (conv.status === "closed" || conv.status === "escalated") continue;
    if (conv.aiEnabled === false) continue;

    const quietFor = now - new Date(conv.updatedAt).getTime();
    if (quietFor < quietMs || quietFor > REVIVAL_MAX_AGE_MS) continue;

    const messages = (conv.messages ?? []) as Array<{
      role: string;
      content: string;
    }>;
    if (messages.length === 0) continue;
    // Dropped = WE spoke last and the customer never came back.
    if (messages[messages.length - 1].role !== "assistant") continue;

    if (conv.customerId) {
      const customer = await prisma.customer
        .findUnique({ where: { id: conv.customerId } })
        .catch(() => null);
      if (customer?.isBlocked) continue;
    }

    const existing = await prisma.followUp.findFirst({
      where: { conversationId: conv.id, kind: "dropped_revival" },
    });
    if (existing) continue;

    const customerText = messages
      .filter((m) => m.role === "customer")
      .map((m) => m.content)
      .join("\n");
    const lang = resolveBehaviourLang(settingsLanguage, customerText);

    await prisma.followUp.create({
      data: withBusinessId({
        conversationId: conv.id,
        message: droppedRevivalText(lang, businessName, conv.customerName),
        dueAt: new Date(),
        status: "pending",
        kind: "dropped_revival",
      }),
    });
    created++;
  }
  return created;
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
