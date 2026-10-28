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
import { prisma, withBusinessId } from "@/lib/prisma";
import { createNewConversation } from "@/lib/ai/engine";
import { processChannelMessage } from "@/lib/channels/inbound";
import { reportActivity, clearActivity } from "@/lib/ai/activity";
import { resolveCustomer } from "@/lib/customer-resolver";
import { resolveChannelBusiness } from "@/lib/tenant";
import { logger } from "@/lib/logger";
import { transcribeAudio } from "@/lib/ai/media";
import { hasAnyProviderKey, resolveSiteKeys } from "@/lib/ai/providers";
import {
  decideVoiceTurn,
  detectVoiceReplyLang,
  extractCloudAudioMessage,
  validateVoiceAudio,
  voiceFallbackStrings,
  voiceFailureCustomerNote,
} from "@/lib/ai/voice-input";

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
  // STAGED Leg A video2: a customer voice note arrives as type "audio"
  // with a media id. At HEAD this field was absent, so the loop below
  // dropped voice notes silently (`!body -> continue`).
  audio?: { id?: string; mime_type?: string };
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
        // STAGED Leg A video2: a voice note has no text body. Text
        // still wins when a message carries both; otherwise the audio
        // branch below handles the clip. Anything else (image, video,
        // sticker, location) keeps the old behaviour: skipped.
        const cloudAudio = extractCloudAudioMessage(msg);
        if (!from || (!body && !cloudAudio)) continue;

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

        // STAGED Leg A video2: voice-message understanding. The clip
        // is downloaded from Graph (WHATSAPP_TOKEN, owner's launch-step
        // env — never hardcoded), transcribed with the provider chain,
        // and the transcript is routed through the EXISTING
        // processChannelMessage -> chat() path — same brain, same
        // tools, same order flow as typed text, text reply out.
        // Failures never guess and never drop silently: the thread
        // gets an honest marker and the customer gets an honest text
        // reply asking them to type it (or silence while human
        // takeover holds, matching the widget voice route).
        if (cloudAudio && !body) {
          await handleWhatsAppCloudVoiceMessage({
            businessId,
            conversationId: conversation.id,
            conversationAiEnabled: conversation.aiEnabled,
            from,
            mediaId: cloudAudio.mediaId,
          });
          count++;
          continue;
        }

        const result = await processChannelMessage(conversation.id, businessId, body);
        count++;
        if (!result.silent && result.response) {
          // Live activity: caption the real WhatsApp send while it runs.
          await reportActivity(conversation.id, "sending_reply", { channel: "whatsapp" });
          try {
            await sendWhatsAppCloudMessage(from, result.response);
          } finally {
            await clearActivity(conversation.id);
          }
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

// ---------------------------------------------------------------------------
// STAGED Leg A video2 — WhatsApp Cloud voice-message understanding
// ---------------------------------------------------------------------------
// Pure decision layer: src/lib/ai/voice-input.ts (decideVoiceTurn).
// These helpers only do I/O around it: Graph media download ->
// validate -> transcribe -> route-or-fallback. Audio bytes are
// memory-only and are never persisted; only the transcript (on
// success, via the normal chat path) or an honest failure marker is
// stored. Voice turns can never confirm anything: the only engine
// entry is processChannelMessage -> chat(), and the agent tool list
// at HEAD contains no confirm tool (take_order creates PENDING only).

/** Download one Cloud media object by id. Null on any failure. */
async function downloadWhatsAppCloudAudio(
  mediaId: string
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return null;
  try {
    const metaRes = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as { url?: unknown };
    const url = typeof meta.url === "string" ? meta.url : "";
    if (!url) return null;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const rawMime = (res.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    return {
      bytes: buf,
      mimeType: rawMime.startsWith("audio/") ? rawMime : "audio/ogg",
    };
  } catch (err) {
    logger.warn("[WhatsAppCloud] voice download failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function handleWhatsAppCloudVoiceMessage(opts: {
  businessId: string;
  conversationId: string;
  conversationAiEnabled: boolean;
  from: string;
  mediaId: string;
}): Promise<void> {
  // Fallback language: the thread's own recent customer text, script-
  // detected like the widget voice route does (pure mirror in
  // voice-input.ts; the business setting is not re-read here because
  // this handler already runs inside the business context and the
  // transcript itself is the freshest language signal once routed).
  let priorCustomerText = "";
  try {
    const lastCustomer = await prisma.message.findFirst({
      where: { conversationId: opts.conversationId, role: "customer" },
      orderBy: { createdAt: "desc" },
    });
    priorCustomerText = lastCustomer?.content || "";
  } catch {
    /* language detection is best-effort */
  }

  const storeFailure = async (
    reason: "no_key" | "unintelligible" | "download_failed" | "unsupported_audio"
  ) => {
    await prisma.message.create({
      data: withBusinessId({
        conversationId: opts.conversationId,
        role: "customer",
        content: voiceFailureCustomerNote(reason),
      }),
    });
    await prisma.conversation
      .update({
        where: { id: opts.conversationId },
        data: { updatedAt: new Date() },
      })
      .catch(() => undefined);
    // Human takeover: stay silent — staff see the marker, the
    // visitor hears nothing from the AI.
    if (opts.conversationAiEnabled === false) return;
    await sendWhatsAppCloudMessage(
      opts.from,
      voiceFallbackStrings(detectVoiceReplyLang(undefined, priorCustomerText))[reason]
    );
  };

  const downloaded = await downloadWhatsAppCloudAudio(opts.mediaId);
  const validation = downloaded
    ? validateVoiceAudio(downloaded.mimeType, downloaded.bytes.length)
    : undefined;
  const keys = await resolveSiteKeys().catch(() => null);
  const keyPresent = keys ? hasAnyProviderKey(keys) : false;

  let transcript: string | null = null;
  if (downloaded && validation?.ok && keyPresent && keys) {
    try {
      transcript = await transcribeAudio(keys, downloaded.bytes, downloaded.mimeType);
    } catch (err) {
      // Empty transcripts throw inside transcribeAudio, and provider
      // failures throw AllProvidersFailedError — both land here as
      // `unintelligible` via decideVoiceTurn below. Nothing is guessed.
      logger.warn("[WhatsAppCloud] voice transcription failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
      transcript = null;
    }
  }

  const decision = decideVoiceTurn({
    audioDownloaded: downloaded !== null,
    providerKeyPresent: keyPresent,
    transcript,
    priorCustomerText,
    ...(validation ? { audioValidation: validation } : {}),
  });

  if (decision.kind === "route") {
    const result = await processChannelMessage(
      opts.conversationId,
      opts.businessId,
      decision.transcript
    );
    if (!result.silent && result.response) {
      await reportActivity(opts.conversationId, "sending_reply", { channel: "whatsapp" });
      try {
        await sendWhatsAppCloudMessage(opts.from, result.response);
      } finally {
        await clearActivity(opts.conversationId);
      }
    }
    return;
  }
  await storeFailure(decision.reason);
}
