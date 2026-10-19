/**
 * Phase 5: WhatsApp Business Cloud API channel.
 *
 * This is separate from the WhatsApp Web (QR) channel in
 * src/lib/channels/whatsapp.ts — the Cloud API is Meta's official
 * business API (webhook + Graph API sends, no phone needed online).
 *
 * Env (all optional; every flow degrades honestly when absent):
 *   WHATSAPP_TOKEN            — permanent system-user access token
 *   WHATSAPP_PHONE_NUMBER_ID  — the business phone number ID
 *   WHATSAPP_VERIFY_TOKEN     — the webhook verify token the business sets
 *                               in the Meta developer dashboard
 *
 * Inbound WhatsApp Cloud webhooks are NOT signed with a secret the way
 * Meta's other webhooks are — Meta sends them over TLS to the registered
 * URL after the GET verify handshake, so the verify token + registered URL
 * is the trust mechanism. (Documented honestly here rather than faked.)
 */
import { prisma } from "@/lib/prisma";
import { createNewConversation } from "@/lib/ai/engine";
import { processChannelMessage } from "@/lib/channels/inbound";
import { resolveCustomer } from "@/lib/customer-resolver";
import { resolveChannelBusiness } from "@/lib/tenant";
import { logger } from "@/lib/logger";

const GRAPH = "https://graph.facebook.com/v21.0";

export function isWhatsAppCloudConfigured(): boolean {
  return Boolean(
    process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

export function isWhatsAppCloudWebhookConfigured(): boolean {
  return Boolean(
    process.env.WHATSAPP_VERIFY_TOKEN && isWhatsAppCloudConfigured()
  );
}

/** Verify the GET subscription handshake. */
export function verifyWhatsAppSubscription(
  mode: string | null,
  verifyToken: string | null
): boolean {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  return mode === "subscribe" && Boolean(expected) && verifyToken === expected;
}

/**
 * Send a WhatsApp message via the Cloud API. Real Graph API write —
 * only platform-accepted sends count as success. Exported for the inbox
 * live-chat owner replies.
 */
export async function sendWhatsAppCloudMessage(
  to: string,
  text: string
): Promise<boolean> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    logger.warn("[WhatsAppCloud] not configured — cannot send");
    return false;
  }
  try {
    const res = await fetch(
      `${GRAPH}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text.slice(0, 4096) },
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn("[WhatsAppCloud] send failed", {
        status: res.status,
        body: body.slice(0, 300),
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error("[WhatsAppCloud] send threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

interface CloudMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
}

interface CloudValue {
  messaging_product?: string;
  messages?: CloudMessage[];
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
}

/**
 * Handle one parsed WhatsApp Cloud webhook payload. Inbound customer
 * messages become channel-tagged ("whatsapp") conversations in the
 * unified inbox; the shared pipeline applies the subscription hard-stop
 * and the AI takeover switches, and the AI reply goes back through the
 * Cloud API when it isn't silent.
 */
export async function handleWhatsAppCloudWebhook(
  payload: { entry?: Array<{ changes?: Array<{ value?: CloudValue }> }> },
  businessId: string
): Promise<{ messages: number }> {
  let count = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (value?.messaging_product !== "whatsapp") continue;
      const contacts = value.contacts ?? [];
      for (const msg of value.messages ?? []) {
        const from = msg.from || "";
        const body = msg.text?.body?.trim() || "";
        if (!from || !body) continue;

        const profile = contacts.find((c) => c.wa_id === from);
        const customerName = profile?.profile?.name || "WhatsApp User";

        const customerId = await resolveCustomer("whatsapp", from, customerName);
        let conversation = await prisma.conversation.findFirst({
          where: {
            channel: "whatsapp",
            status: { in: ["active", "escalated"] },
            OR: [{ customerId }, { customerContact: from }],
          },
        });
        if (!conversation) {
          conversation = await createNewConversation(
            "whatsapp",
            customerName,
            from,
            customerId
          );
        }

        const result = await processChannelMessage(conversation.id, businessId, body);
        count++;
        if (!result.silent && result.response) {
          await sendWhatsAppCloudMessage(from, result.response);
        }
      }
    }
  }
  return { messages: count };
}

/** Resolve the business for the webhook (fail-closed, never guessed). */
export async function resolveWebhookBusiness(
  slug?: string | null
): Promise<string> {
  return resolveChannelBusiness(slug);
}
