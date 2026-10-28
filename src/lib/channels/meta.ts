/**
 * Phase 5: Meta (Facebook + Instagram) channel — OAuth connect, webhook
 * signature verification, inbound message routing to the unified inbox,
 * and outbound sends through the Graph API.
 *
 * Env (all optional; every flow degrades honestly when absent):
 *   META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN
 *
 * Tokens obtained via the OAuth connect flow are stored AES-256-GCM
 * encrypted in the `socialAccounts` collection (see
 * src/lib/social/accounts.ts) — never plaintext, never logged.
 *
 * Webhook verification follows Meta's documented flow:
 *   GET  — hub.mode=subscribe + hub.verify_token match + hub.challenge echo
 *   POST — X-Hub-Signature-256 = HMAC-SHA256(raw body, META_APP_SECRET),
 *          timing-safe compare. Fail-closed: no secret configured, or a
 *          bad signature => the event is rejected.
 */
import crypto from "crypto";
import { prisma, withBusinessId } from "@/lib/prisma";
import { createNewConversation } from "@/lib/ai/engine";
import { processChannelMessage } from "@/lib/channels/inbound";
import { reportActivity, clearActivity } from "@/lib/ai/activity";
import { resolveCustomer } from "@/lib/customer-resolver";
import { encryptToken, getActiveAccounts, getDecryptedToken } from "@/lib/social/accounts";
import { handleCommentEvent } from "@/lib/social/comments";
import { logger } from "@/lib/logger";
import { transcribeAudio } from "@/lib/ai/media";
import { hasAnyProviderKey, resolveSiteKeys } from "@/lib/ai/providers";
import {
  decideVoiceTurn,
  detectVoiceReplyLang,
  extractMetaAudioAttachment,
  validateVoiceAudio,
  voiceFallbackStrings,
  voiceFailureCustomerNote,
} from "@/lib/ai/voice-input";

const GRAPH = "https://graph.facebook.com/v21.0";
const OAUTH_SCOPES = [
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "pages_show_list",
].join(",");

export interface MetaEnv {
  appId: string;
  appSecret: string;
  verifyToken: string;
}

/** Read Meta env. Missing values come back as "" — callers degrade honestly. */
export function getMetaEnv(): MetaEnv {
  return {
    appId: process.env.META_APP_ID || "",
    appSecret: process.env.META_APP_SECRET || "",
    verifyToken: process.env.META_VERIFY_TOKEN || "",
  };
}

export function isMetaConfigured(): boolean {
  const e = getMetaEnv();
  return Boolean(e.appId && e.appSecret);
}

export function isMetaWebhookConfigured(): boolean {
  const e = getMetaEnv();
  return Boolean(e.appId && e.appSecret && e.verifyToken);
}

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 * Fail-closed: missing secret, missing header, or mismatch => false.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const { appSecret } = getMetaEnv();
  if (!appSecret || !signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Verify the GET subscription handshake (hub.mode=subscribe). */
export function verifyMetaSubscription(
  mode: string | null,
  verifyToken: string | null
): boolean {
  const { verifyToken: expected } = getMetaEnv();
  return mode === "subscribe" && Boolean(expected) && verifyToken === expected;
}

/** Build the Facebook OAuth dialog URL for the connect flow. */
export function buildMetaOAuthUrl(redirectUri: string, state: string): string {
  const { appId } = getMetaEnv();
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    response_type: "code",
    state,
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}

interface MetaPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
}

/**
 * Exchange the OAuth code for a user token, list the user's Pages, and
 * store each page (+ its linked Instagram business account) as an
 * encrypted socialAccount row. Returns the stored account labels.
 */
export async function connectMetaAccount(
  code: string,
  redirectUri: string
): Promise<string[]> {
  const { appId, appSecret } = getMetaEnv();
  if (!appId || !appSecret) {
    throw new Error("Meta is not configured (META_APP_ID / META_APP_SECRET).");
  }

  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      }).toString()
  );
  if (!tokenRes.ok) {
    throw new Error(`Meta token exchange failed (HTTP ${tokenRes.status}).`);
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  const userToken = tokenData.access_token;
  if (!userToken) throw new Error("Meta token exchange returned no token.");

  // Long-lived user token
  const longRes = await fetch(
    `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: userToken,
      }).toString()
  );
  const longData = longRes.ok
    ? ((await longRes.json()) as { access_token?: string })
    : {};
  const finalToken = longData.access_token || userToken;

  const pagesRes = await fetch(
    `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(finalToken)}`
  );
  if (!pagesRes.ok) {
    throw new Error(`Meta pages fetch failed (HTTP ${pagesRes.status}).`);
  }
  const pagesData = (await pagesRes.json()) as { data?: MetaPage[] };
  const pages = pagesData.data ?? [];
  if (pages.length === 0) {
    throw new Error("No Facebook Pages found on this Meta account.");
  }

  const stored: string[] = [];
  for (const page of pages) {
    const fb = await upsertMetaAccount(
      "facebook",
      page.name,
      page.id,
      page.access_token
    );
    stored.push(`Facebook: ${fb}`);

    const igId = page.instagram_business_account?.id;
    if (igId) {
      // Instagram uses the page access token via the Graph API.
      const igName = await fetchInstagramName(igId, page.access_token).catch(
        () => igId
      );
      const ig = await upsertMetaAccount(
        "instagram",
        igName,
        igId,
        page.access_token
      );
      stored.push(`Instagram: ${ig}`);
    }
  }
  return stored;
}

async function fetchInstagramName(igId: string, token: string): Promise<string> {
  const res = await fetch(
    `${GRAPH}/${encodeURIComponent(igId)}?fields=username&access_token=${encodeURIComponent(token)}`
  );
  if (!res.ok) return igId;
  const data = (await res.json()) as { username?: string };
  return data.username ? `@${data.username}` : igId;
}

async function upsertMetaAccount(
  platform: "facebook" | "instagram",
  label: string,
  accountRef: string,
  token: string
): Promise<string> {
  const { tokenEnc, tokenIv } = encryptToken(token);
  const existing = await prisma.socialAccount.findFirst({
    where: { platform, accountRef },
    select: { id: true },
  });
  if (existing) {
    await prisma.socialAccount.update({
      where: { id: existing.id },
      data: { tokenEnc, tokenIv, label, isActive: true, updatedAt: new Date() },
    });
  } else {
    await prisma.socialAccount.create({
      data: withBusinessId({
        platform,
        label,
        accountRef,
        tokenEnc,
        tokenIv,
        isActive: true,
      }),
    });
  }
  return label;
}

/**
 * Find the connected Meta account whose accountRef matches the recipient
 * (page ID or IG user ID), decrypt its token. Returns null when nothing is
 * connected (caller degrades honestly).
 */
async function getAccountForRecipient(
  recipientId: string
): Promise<{ account: { id: string; label: string; platform: string }; token: string } | null> {
  const accounts = await getActiveAccounts();
  const account = accounts.find(
    (a) =>
      (a.platform === "facebook" || a.platform === "instagram") &&
      a.accountRef === recipientId
  );
  if (!account) return null;
  try {
    return { account, token: getDecryptedToken(account) };
  } catch (err) {
    logger.warn("[Meta] token decrypt failed", {
      account: account.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Send a text message to a Messenger PSID (Facebook Page) or Instagram
 * scoped user ID. Real Graph API write — only platform-returned IDs count
 * as success. Exported for the inbox live-chat owner replies.
 */
export async function sendMetaMessage(
  recipientPageOrIgId: string,
  recipientPsid: string,
  text: string
): Promise<boolean> {
  const found = await getAccountForRecipient(recipientPageOrIgId);
  if (!found) {
    logger.warn("[Meta] no connected account for recipient page/IG id", {
      recipientPageOrIgId,
    });
    return false;
  }
  try {
    const res = await fetch(
      `${GRAPH}/${encodeURIComponent(recipientPageOrIgId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientPsid },
          messaging_type: "RESPONSE",
          message: { text: text.slice(0, 2000) },
          access_token: found.token,
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn("[Meta] send failed", {
        status: res.status,
        body: body.slice(0, 300),
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error("[Meta] send threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Webhook event handling
// ---------------------------------------------------------------------------

interface MetaMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    // STAGED Leg A video2: Meta voice clips arrive as audio attachments.
    // At HEAD this field was absent, so voice messages were dropped by
    // the `if (!text) continue` guard below. Only "audio" attachments
    // are routed to transcription (see extractMetaAudioAttachment).
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
  };
}

interface MetaChangeValue {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  from?: { id?: string; name?: string };
  message?: string;
  created_time?: number;
}

interface MetaEntry {
  id?: string;
  time?: number;
  messaging?: MetaMessagingEvent[];
  changes?: Array<{ field?: string; value?: MetaChangeValue }>;
}

/**
 * Handle one parsed Meta webhook payload. Messaging events become
 * channel-tagged conversations in the unified inbox ("messenger" for
 * Facebook Page messages, "instagram" for IG DMs); feed comment events
 * become comment tickets with AI-drafted replies.
 *
 * Must run inside a business context (the route enters it via
 * ?business=<slug> or the single-business fallback).
 */
export async function handleMetaWebhook(
  payload: { object?: string; entry?: MetaEntry[] },
  businessId: string
): Promise<{ messages: number; comments: number }> {
  const counts = { messages: 0, comments: 0 };
  for (const entry of payload.entry ?? []) {
    // --- Direct messages (Messenger / Instagram) ---
    for (const ev of entry.messaging ?? []) {
      if (ev.message?.is_echo) continue; // our own sent messages
      const text = ev.message?.text?.trim();
      // STAGED Leg A video2: a voice clip has no text. At HEAD the next
      // line dropped it silently; now an audio attachment keeps the
      // event alive and the voice branch below handles it. Text still
      // wins when a message carries both (a captioned clip is answered
      // from its caption, exactly as before).
      const audioAttachment = extractMetaAudioAttachment(ev.message);
      if (!text && !audioAttachment) continue;
      const psid = ev.sender?.id || "";
      const pageOrIgId = ev.recipient?.id || "";
      if (!psid || !pageOrIgId) continue;

      // Distinguish Instagram DMs from Messenger: the recipient id matches
      // a connected instagram account's accountRef.
      const accounts = await getActiveAccounts().catch(() => []);
      const igMatch = accounts.some(
        (a) => a.platform === "instagram" && a.accountRef === pageOrIgId
      );
      const channel = igMatch ? "instagram" : "messenger";

      const customerId = await resolveCustomer(channel, psid, "Meta User");
      let conversation = await prisma.conversation.findFirst({
        where: {
          channel,
          status: { in: ["active", "escalated"] },
          OR: [{ customerId }, { customerContact: psid }],
        },
      });
      if (!conversation) {
        conversation = await createNewConversation(
          channel,
          "Meta User",
          psid,
          customerId
        );
        // Remember which page/IG account this thread belongs to, so the
        // inbox live-chat can send owner replies back through the right
        // token. Fail-soft: metadata is advisory only.
        await prisma.conversation
          .update({
            where: { id: conversation.id },
            data: { metadata: { metaPageId: pageOrIgId } },
          })
          .catch(() => undefined);
      }

      // STAGED Leg A video2: voice-message understanding. The clip is
      // downloaded (page token, never a hardcoded key), transcribed with
      // the provider chain, and the transcript is routed through the
      // EXISTING processChannelMessage -> chat() path — same brain,
      // same tools, same order flow as typed text, text reply out.
      // Failures never guess and never drop silently: the thread gets
      // an honest marker and the customer gets an honest text reply
      // asking them to type it (or silence while human takeover holds,
      // matching the widget voice route's takeover behaviour).
      if (audioAttachment && !text) {
        await handleMetaVoiceMessage({
          businessId,
          conversationId: conversation.id,
          conversationAiEnabled: conversation.aiEnabled,
          conversationChannel: conversation.channel,
          pageOrIgId,
          psid,
          audioUrl: audioAttachment.url ?? "",
        });
        counts.messages++;
        continue;
      }

      // TS cannot prove it from the two guards above, but text is
      // defined here: textless non-audio events continued at the top,
      // and textless audio events continued through the voice branch.
      // This guard only fires if those guards ever change.
      if (!text) continue;

      const result = await processChannelMessage(conversation.id, businessId, text);
      counts.messages++;
      if (!result.silent && result.response) {
        // Live activity: caption the real Meta send (Messenger /
        // Facebook / Instagram per the conversation's channel) while
        // it runs.
        await reportActivity(conversation.id, "sending_reply", {
          channel: conversation.channel || undefined,
        });
        try {
          await sendMetaMessage(pageOrIgId, psid, result.response);
        } finally {
          await clearActivity(conversation.id);
        }
      }
    }

    // --- Feed changes: comments on posts ---
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== "feed" || v?.item !== "comment" || v?.verb !== "add") {
        continue;
      }
      const commentId = v.comment_id;
      if (!commentId) continue;
      await handleCommentEvent({
        platform: "facebook",
        commentId,
        parentRef: v.post_id || "",
        authorRef: v.from?.id || "",
        authorName: v.from?.name || "Facebook user",
        text: v.message || "",
        businessId,
      });
      counts.comments++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// STAGED Leg A video2 — Meta voice-message understanding
// ---------------------------------------------------------------------------
// Pure decision layer: src/lib/ai/voice-input.ts (decideVoiceTurn).
// This helper only does I/O around it: download -> validate ->
// transcribe -> route-or-fallback. Audio bytes are memory-only and
// are never persisted; only the transcript (on success, via the
// normal chat path) or an honest failure marker is stored.
// Provider keys come from resolveSiteKeys() (owner's launch-step key);
// nothing here hardcodes a key, a transcript, or a price. Voice turns
// can never confirm anything: the only engine entry is
// processChannelMessage -> chat(), and the agent tool list at HEAD
// contains no confirm tool (take_order creates PENDING only).
async function handleMetaVoiceMessage(opts: {
  businessId: string;
  conversationId: string;
  conversationAiEnabled: boolean;
  conversationChannel: string | null;
  pageOrIgId: string;
  psid: string;
  audioUrl: string;
}): Promise<void> {
  // Fallback language: the thread's own recent customer text, script-
  // detected exactly like the widget voice route does (business
  // setting wins inside resolveBehaviourLang; here only prior text is
  // available, so the pure mirror in voice-input.ts is used).
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

  const storeFailure = async (reason: "no_key" | "unintelligible" | "download_failed" | "unsupported_audio") => {
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
    // Human takeover: stay silent, exactly like the widget voice
    // route — staff see the marker in the thread, the visitor hears
    // nothing from the AI.
    if (opts.conversationAiEnabled === false) return;
    await sendMetaMessage(
      opts.pageOrIgId,
      opts.psid,
      voiceFallbackStrings(detectVoiceReplyLang(undefined, priorCustomerText))[reason]
    );
  };

  // Download with the connected page/IG account's token.
  let downloaded: { bytes: Buffer; mimeType: string } | null = null;
  try {
    const found = await getAccountForRecipient(opts.pageOrIgId);
    if (found) {
      const res = await fetch(opts.audioUrl, {
        headers: { Authorization: `Bearer ${found.token}` },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const rawMime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        downloaded = {
          bytes: buf,
          mimeType: rawMime.startsWith("audio/") ? rawMime : "audio/mp4",
        };
      }
    }
  } catch (err) {
    logger.warn("[Meta] voice download failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
      logger.warn("[Meta] voice transcription failed", {
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
      await reportActivity(opts.conversationId, "sending_reply", {
        channel: opts.conversationChannel || undefined,
      });
      try {
        await sendMetaMessage(opts.pageOrIgId, opts.psid, result.response);
      } finally {
        await clearActivity(opts.conversationId);
      }
    }
    return;
  }
  await storeFailure(decision.reason);
}
