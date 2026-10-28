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
import {
  decideFollowUpDelivery,
  SALES_REMINDER_KINDS,
} from "./followup-discipline";
import { sortDueEarliestFirst } from "./followup-settings";
import {
  decideMessageReply,
  extractPageKeys,
  parseChannelToggles,
  parsePageToggles,
} from "./channel-toggles";
import {
  decideChannelDelivery,
  getReminderSettings,
} from "./booking-reminders";
import { evaluateBookingReminderGate } from "./booking-reminder-scheduler";
import { sendMessengerTemplateMessage } from "./channels/messenger-template";
export interface FollowUpResult {
  processed: number;
  sent: number;
  failed: number;
  /** Leg F: due follow-ups left pending by the delivery gate (human
   *  hands, already ordered, window expired, blocked, closed thread).
   *  Suppressed records are NOT sent and NOT failed; the next run
   *  re-evaluates them. Merge note: Leg D adds a separate `deferred`
   *  counter for the takeover case on the same struct — keep both. */
  suppressed: number;
  /** Leg D/J (head-decision 2026-10-28): channel-level owner holds
   *  and toggle-offs that Leg F did NOT already suppress. Leg F runs
   *  FIRST; a record F suppressed is NEVER also deferred (see
   *  src/lib/followups-ordering.ts — first match wins, exactly one
   *  counter per record). LD-06 booking-reminder outcomes stay
   *  UNCOUNTED by design and never touch either counter. */
  deferred: number;
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

  const total: FollowUpResult = { processed: 0, sent: 0, failed: 0, suppressed: 0, deferred: 0 };
  for (const b of businesses) {
    const r = await runWithBusiness(b.id, () => processBusinessFollowUps());
    total.processed += r.processed;
    total.sent += r.sent;
    total.failed += r.failed;
    total.suppressed += r.suppressed;
    total.deferred += r.deferred;
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

  let due = await prisma.followUp.findMany({
    where: { status: "pending", dueAt: { lte: new Date() } },
    orderBy: { dueAt: "asc" },
    take: 20,
  });
  // Leg I: earliest-first sending order, enforced in memory as well as
  // by the query's orderBy (see src/lib/followup-settings.ts): the
  // oldest due record is always sent first within the page.
  due = sortDueEarliestFirst(due);

  let sent = 0;
  let failed = 0;
  let suppressed = 0;
  let deferred = 0;
  for (const fu of due) {
    try {
      // Leg F: the conversation is loaded BEFORE the record is marked
      // "sending", so the delivery gate below can suppress a record
      // without leaving it stuck in "sending". (Leg D makes the same
      // restructure for its takeover deferral — if Leg D lands first,
      // keep one copy of this load and both gates.)
      const conv = await prisma.conversation.findUnique({
        where: { id: fu.conversationId },
      });
      if (!conv) throw new Error("Conversation not found");

      // Leg J (HEAD variant): a follow-up is an agent reply on the
      // conversation's channel, so the channel/page toggles gate its
      // DELIVERY — creation is deliberately ungated (a deferred
      // follow-up delivers on the next run after the switch comes
      // back on, the same resume semantics as the takeover deferral).
      // The record is reset to "pending", never "failed" and never
      // stored as an assistant message that never went out. Global
      // and per-chat states are included here so this variant is
      // complete standalone; the layered variant (apply after
      // Presswayy Leg D) reuses Leg D's takeover deferral for the
      // per-chat layer instead — use exactly one variant.
      const followDecision = decideMessageReply({
        globalOn:
          (settings as { aiEnabled?: unknown } | null)?.aiEnabled !== false,
        chatOn: conv.aiEnabled !== false,
        channel: conv.channel,
        pageKeys: extractPageKeys(conv.metadata),
        channelToggles: parseChannelToggles(
          (settings as { channelAiToggles?: unknown } | null)?.channelAiToggles
        ),
        pageToggles: parsePageToggles(
          (settings as { pageAiToggles?: unknown } | null)?.pageAiToggles
        ),
      });
      if (!followDecision.allowed) {
        await prisma.followUp.update({
          where: { id: fu.id },
          data: { status: "pending" },
        });
        logger.warn(
          `[followups] channel toggle deferred follow-up ${fu.id} (blockedBy=${followDecision.blockedBy}, channel=${conv.channel})`
        );
        continue;
      }
      // COMPOSED (2026-10-28, gate order H8): booking reminders dispatch
      // HERE, after the Leg J toggle gate but BEFORE the Leg F gate.
      // A reminder owns its delivery (LEG D): its own gate defers on
      // human hands and terminally suppresses unconfirmed/re-ordered
      // and Instagram out-of-window reminders. The Leg F gate's window
      // rule applies to ALL kinds, so running it first would leave an
      // out-of-window Instagram reminder pending-forever, re-counted
      // every run, never reaching LEG D's terminal suppress — and the
      // F gate passes templateConfigured=false while LEG D knows the
      // real Messenger template name. J stays first (owner master
      // switch); F still gates every non-reminder kind below. The
      // handler sets the record's final status itself; the record is
      // still "pending" at this point, not "sending".
      if ((fu as { kind?: string }).kind === "booking_reminder") {
        // Narrow the Conversation to the handler's shape: its metadata
        // is JsonValue, so extract metaPageId only from a plain object;
        // anything else is treated as "no page id" (handler logs it and
        // does not send) rather than crashing the run.
        const meta =
          typeof conv.metadata === "object" &&
          conv.metadata !== null &&
          !Array.isArray(conv.metadata)
            ? (conv.metadata as { metaPageId?: string })
            : null;
        const outcome = await handleBookingReminder(fu, {
          id: conv.id,
          channel: conv.channel,
          customerContact: conv.customerContact,
          aiEnabled: conv.aiEnabled,
          metadata: meta,
        });
        if (outcome === "sent") sent++;
        else if (outcome === "failed") failed++;
        continue;
      }
      // Leg F delivery gate — checked on EVERY delivery, not just at
      // creation: a thread can be taken over, or an order placed,
      // after a reminder was scheduled. Window + suppression rules
      // live in the pure module (src/lib/followup-discipline.ts);
      // this loop only supplies the facts. A suppressed record stays
      // "pending" and is counted, never sent, never failed.
      // - Last customer message: proven HEAD pattern (dropped revival
      //   loads messages ascending and takes the last one). Unknown
      //   last-message time fails closed on windowed channels.
      // - hasOrdered: any non-cancelled order on this conversation.
      //   The agent never confirms orders; ordering only suppresses.
      // - aiDeemsUnneeded: no such field exists at HEAD (NOT FOUND),
      //   so it is passed as false here. The AI-unneeded rule is
      //   honoured at scheduling time (the engine simply does not
      //   schedule); this input stays ready for a future flag.
      // - templateConfigured: false — no template name/config exists
      //   at HEAD (NOT FOUND), so a past-window WhatsApp/Messenger
      //   follow-up suppresses as template_required_not_built rather
      //   than sending free-form text past the window. Instagram
      //   past 24h always suppresses, with or without a template.
      const messages = ((await prisma.message
        .findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: "asc" },
        })
        .catch(() => [])) ?? []) as Array<{ role: string; createdAt: unknown }>;
      let lastCustomerAtMs: number | null = null;
      for (const m of messages) {
        if (m.role === "customer") {
          const t = new Date(m.createdAt as string).getTime();
          if (Number.isFinite(t)) lastCustomerAtMs = t;
        }
      }
      const orders = ((await prisma.order
        .findMany({ where: { conversationId: conv.id } })
        .catch(() => [])) ?? []) as Array<{ status?: string }>;
      const hasOrdered = orders.some((o) => o.status !== "cancelled");
      let isBlocked = false;
      if (conv.customerId) {
        const customer = await prisma.customer
          .findUnique({ where: { id: conv.customerId } })
          .catch(() => null);
        isBlocked = (customer as { isBlocked?: boolean } | null)?.isBlocked === true;
      }
      const gate = decideFollowUpDelivery({
        // fu.kind scopes the sales suppressions (see the pure module):
        // order_status_update / order_checkin / kind-less
        // customer-requested reminders are never suppressed for
        // "already ordered" -- only warm/hot sales reminders are.
        followUpKind: (fu as { kind?: string }).kind ?? null,
        aiEnabled: conv.aiEnabled !== false,
        conversationStatus: conv.status ?? "active",
        hasOrdered,
        aiDeemsUnneeded: false,
        isBlocked,
        channel: conv.channel,
        lastCustomerMessageAtMs: lastCustomerAtMs,
        nowMs: Date.now(),
        templateConfigured: false,
      });
      if (!gate.send) {
        suppressed++;
        logger.warn("[followups] delivery suppressed by Leg F gate", {
          followUpId: fu.id,
          kind: fu.kind,
          reason: gate.reason,
        });
        continue;
      }

      // Leg I: "customer already left their number" suppression, AFTER
      // the Leg F gate (so a Leg F reason always stands first) and for
      // SALES reminders only (warm/hot — the same scoping as Leg F's
      // already-ordered suppression). Order pushes, check-ins and
      // kind-less customer-requested reminders are never suppressed
      // here, even when the customer left their number.
      // SPEC — the signal does not exist at HEAD (see
      // src/lib/followup-settings.ts): customerProvidedPhoneInChat
      // may ONLY be set when the customer actually typed a number in
      // this conversation. Until that capture step lands this reads
      // false and the suppression is inert. NEVER substitute
      // Customer.phone, Conversation.customerContact, or a channel
      // sender id — those are profile/channel data, not a number
      // given in chat, and substituting them would suppress whole
      // channels (WhatsApp/SMS contacts ARE numbers by construction).
      const customerLeftNumber =
        (conv as { customerProvidedPhoneInChat?: unknown })
          .customerProvidedPhoneInChat === true;
      if (
        customerLeftNumber &&
        (SALES_REMINDER_KINDS as readonly string[]).includes(
          (fu as { kind?: string }).kind ?? ""
        )
      ) {
        suppressed++;
        logger.warn("[followups] delivery suppressed by Leg I number-left rule", {
          followUpId: fu.id,
          kind: fu.kind,
          reason: "customer_left_number",
        });
        continue;
      }

      await prisma.followUp.update({
        where: { id: fu.id },
        data: { status: "sending" },
      });
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
  // ORDERING NOTE (head-decision): the Leg F gate above runs FIRST.
  // A Leg D channel-hold / Leg J toggle insertion goes HERE — after
  // the Leg F + Leg I suppressions and BEFORE the status="sending"
  // update — and increments ONLY `deferred` (via followups-ordering
  // classifyFollowUp, which guarantees F-suppressed records never
  // reach this point). Do NOT add a second suppressed increment here.
  return { processed: due.length, sent, failed, suppressed, deferred };
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

  // Load the candidate conversations WITHOUT their messages: the
  // cheap guards below (status, aiEnabled, quiet window) need no
  // messages at all, and the old include billed EVERY message of all
  // 100 conversations per run. Messages are loaded per survivor only.
  const conversations = await prisma.conversation.findMany({
    orderBy: { updatedAt: "asc" },
    take: 100,
  });

  let created = 0;
  for (const conv of conversations) {
    if (created >= REVIVAL_MAX_PER_RUN) break;
    if (conv.status === "closed" || conv.status === "escalated") continue;
    if (conv.aiEnabled === false) continue;

    const quietFor = now - new Date(conv.updatedAt).getTime();
    if (quietFor < quietMs || quietFor > REVIVAL_MAX_AGE_MS) continue;

    const messages = ((await prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: "asc" },
    })) ?? []) as Array<{
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

/**
 * LEG D — deliver ONE due booking reminder (kind "booking_reminder").
 *
 * Order of checks (all re-checked at delivery time, not just at
 * scheduling time):
 *  1. Gate: human hands / global AI off -> DEFER (back to pending);
 *     order no longer confirmed, already re-ordered, or AI-unneeded
 *     -> SUPPRESS (terminal, never delivers).
 *  2. Channel rule (booking-reminders.ts): widget -> STORE as an
 *     assistant message (the website-chat path: the thread endpoint
 *     returns it on the visitor's next poll/visit — no push is
 *     invented); messenger/instagram in-window -> RESPONSE via
 *     sendMetaMessage (dynamic import, like the courier-bridge
 *     precedent in orders.ts, so no static import cycle); messenger
 *     out-of-window -> template seam (today always held, never
 *     faked); instagram out-of-window -> SUPPRESS (nothing after
 *     24h); whatsapp -> HELD always (the only sender at HEAD is the
 *     linked-device client, which this batch must not use — the
 *     official-API sender is an open build); sms/email/telegram ->
 *     the existing direct senders via deliverToChannel.
 *  3. History parity with the generic path: a message is stored as
 *     an assistant message ONLY when it was actually sent (or stored
 *     for widget) or when the send honestly failed. Held, deferred,
 *     and suppressed reminders store nothing — storing them would
 *     fake a delivery in the thread.
 *
 * Returns "sent" | "failed" | "held" | "suppressed" | "deferred".
 * Never throws into the processor loop: an unexpected error marks
 * the record failed, exactly like the generic path's catch.
 */
async function handleBookingReminder(
  fu: {
    id: string;
    conversationId: string;
    message: string;
    orderId?: string;
    aiSuppressed?: boolean;
  },
  conv: {
    id: string;
    channel: string;
    customerContact: string;
    aiEnabled?: boolean;
    metadata?: { metaPageId?: string } | null;
  }
): Promise<string> {
  try {
    const gate = await evaluateBookingReminderGate({
      followUp: {
        id: fu.id,
        conversationId: fu.conversationId,
        orderId: fu.orderId,
        aiSuppressed: fu.aiSuppressed,
      },
      conversation: { id: conv.id, aiEnabled: conv.aiEnabled },
    });
    if (gate.action === "defer") {
      await prisma.followUp.update({
        where: { id: fu.id },
        data: { status: "pending" },
      });
      logger.warn("[booking-reminders] reminder deferred", {
        followUpId: fu.id,
        reason: gate.reason,
      });
      return "deferred";
    }
    if (gate.action === "suppress") {
      await prisma.followUp.update({
        where: { id: fu.id },
        data: { status: "suppressed", suppressReason: gate.reason },
      });
      logger.warn("[booking-reminders] reminder suppressed", {
        followUpId: fu.id,
        reason: gate.reason,
      });
      return "suppressed";
    }

    const settings = await prisma.settings.findFirst();
    const reminderSettings = getReminderSettings(settings);
    const lastCustomer = await prisma.message
      .findMany({
        where: { conversationId: conv.id, role: "customer" },
        orderBy: { createdAt: "desc" },
        take: 1,
      })
      .catch(() => []);
    const lastRow = (lastCustomer ?? [])[0] as
      | { createdAt?: Date | string }
      | undefined;
    const lastMs =
      lastRow?.createdAt === undefined
        ? null
        : lastRow.createdAt instanceof Date
          ? lastRow.createdAt.getTime()
          : Date.parse(String(lastRow.createdAt));
    const decision = decideChannelDelivery(conv.channel, {
      lastCustomerAtMs: Number.isFinite(lastMs) ? (lastMs as number) : null,
      nowMs: Date.now(),
      templateConfigured: reminderSettings.messengerTemplateName !== "",
    });

    if (decision.action === "hold") {
      await prisma.followUp.update({
        where: { id: fu.id },
        data: { status: "pending" },
      });
      logger.warn("[booking-reminders] reminder held, not sent", {
        followUpId: fu.id,
        channel: conv.channel,
        reason: decision.reason,
      });
      return "held";
    }
    if (decision.action === "suppress") {
      await prisma.followUp.update({
        where: { id: fu.id },
        data: { status: "suppressed", suppressReason: decision.reason },
      });
      logger.warn("[booking-reminders] reminder suppressed by channel rule", {
        followUpId: fu.id,
        channel: conv.channel,
        reason: decision.reason,
      });
      return "suppressed";
    }

    let delivered = false;
    if (decision.action === "store") {
      // Website widget: storing IS the delivery (thread endpoint).
      delivered = true;
    } else if (decision.action === "send_response") {
      const pageId = conv.metadata?.metaPageId ?? "";
      if (!pageId) {
        logger.warn("[booking-reminders] meta page id missing, cannot send", {
          followUpId: fu.id,
          channel: conv.channel,
        });
        delivered = false;
      } else {
        const meta = await import("./channels/meta").catch(() => null);
        delivered = meta
          ? await meta.sendMetaMessage(pageId, conv.customerContact, fu.message)
          : false;
      }
    } else if (decision.action === "send_template") {
      const pageId = conv.metadata?.metaPageId ?? "";
      const templateSent = pageId
        ? await sendMessengerTemplateMessage(
            pageId,
            conv.customerContact,
            fu.message,
            reminderSettings.messengerTemplateName
          )
        : false;
      if (!templateSent) {
        // Seam unbuilt: hold, never count as sent or failed.
        await prisma.followUp.update({
          where: { id: fu.id },
          data: { status: "pending" },
        });
        logger.warn("[booking-reminders] messenger template send held", {
          followUpId: fu.id,
        });
        return "held";
      }
      delivered = true;
    } else {
      // sms / email / telegram: the existing direct senders.
      delivered = await deliverToChannel(conv.channel, conv.customerContact, fu.message);
    }

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
    return delivered ? "sent" : "failed";
  } catch (err) {
    logger.warn("[booking-reminders] delivery failed", {
      followUpId: fu.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await prisma.followUp
      .update({ where: { id: fu.id }, data: { status: "failed" } })
      .catch(() => {});
    return "failed";
  }
}
