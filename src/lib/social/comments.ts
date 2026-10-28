/**
 * Phase 5 (user decision 6): FB/IG comment management.
 *
 * Comment events (from the Meta webhook, or the engagement sync) become
 * tickets in the unified inbox:
 *
 *   1. The comment is stored as a `socialInteraction` (kind "comment").
 *   2. The AI DRAFTS a reply — stored on the interaction as `draftReply`,
 *      never sent.
 *   3. The business approves/sends the draft (edited or as-is) from the
 *      inbox. OR, when the connected account has `autoReply` enabled in
 *      channel settings, the draft is posted automatically.
 *
 * Never auto-post without the `socialAccounts.autoReply` setting — that is
 * the whole point of this module.
 */
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getOpenAI, getKnowledgeContext } from "@/lib/social/ai";
import { getActiveAccounts, getDecryptedToken } from "@/lib/social/accounts";
import { postReply as postPlatformReply } from "@/lib/social/engagement";
import { decideCommentAutoPost } from "@/lib/owner-controls/send-path-gate";
import { getSettingsOwnerControlAdapter } from "@/lib/owner-controls/settings-owner-control-adapter";
import {
  decideCommentReplyGate,
  isSameTenant,
  resolveCommentAccount,
} from "@/lib/social/comment-inbox";
import {
  requireActiveSubscription,
  SubscriptionInactiveError,
} from "@/lib/subscription";
import type { SocialAccount } from "@/lib/models";
import {
  commentPageKey,
  decideCommentReply,
  parsePageToggles,
  type PageToggles,
} from "@/lib/channel-toggles";

export interface CommentEvent {
  platform: "facebook" | "instagram";
  commentId: string;
  parentRef: string;
  authorRef: string;
  authorName: string;
  text: string;
  businessId: string;
}

/** Draft a warm, short reply to a comment (stored, not sent). */
export async function draftCommentReply(
  commentText: string,
  platform: string
): Promise<string> {
  const { client, settings } = await getOpenAI();
  const knowledge = await getKnowledgeContext();
  const system = [
    `You are the social media assistant for "${settings.businessName}".`,
    settings.businessDesc ? `Business: ${settings.businessDesc}` : "",
    "Write a short, warm, polite, human-like reply to a customer's comment",
    `on ${platform}. Reply in the SAME language the customer used (Bengali`,
    "or English). Keep it under 60 words. No markdown, no hashtags.",
    knowledge
      ? `\nBusiness facts you may use (do not invent others):\n${knowledge}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: commentText },
    ],
    max_tokens: 200,
    temperature: 0.7,
  });
  const draft = res.choices[0]?.message?.content?.trim();
  if (!draft) throw new Error("AI returned an empty draft.");
  return draft;
}

/**
 * Find the connected account for a comment event. For Facebook the
 * parentRef (post id) starts with "<pageId>_"; for Instagram the account
 * is matched by the business's single active IG account when only one
 * exists.
 */
async function findAccountForComment(
  platform: "facebook" | "instagram",
  parentRef: string
): Promise<SocialAccount | null> {
  const accounts = await getActiveAccounts();
  const candidates = accounts.filter((a) => a.platform === platform);
  if (candidates.length === 0) return null;
  if (platform === "facebook" && parentRef.includes("_")) {
    const pageId = parentRef.split("_")[0];
    const match = candidates.find((a) => a.accountRef === pageId);
    if (match) return match;
  }
  if (candidates.length === 1) return candidates[0];
  return null;
}

/**
 * Handle one FB/IG comment: store it, draft an AI reply, and — only when
 * the account's `autoReply` setting is on — post the reply automatically.
 * Must run inside the business's tenant context.
 */
export async function handleCommentEvent(event: CommentEvent): Promise<{
  interactionId: string;
  autoReplied: boolean;
}> {
  const { platform, commentId, parentRef, authorRef, authorName, text, businessId } =
    event;

  // Deduplicate against what's already stored.
  const existing = await prisma.socialInteraction.findFirst({
    where: { platform, externalId: commentId },
    select: { id: true },
  });
  if (existing) {
    return { interactionId: existing.id, autoReplied: false };
  }

  // Subscription hard-stop (user decision 16): store the comment honestly,
  // but spend nothing on a draft and send nothing. The stored-without-draft
  // path is shared with the feature-scope gate below.
  const storeWithoutDraft = async () => {
    const stored = await prisma.socialInteraction.create({
      data: withBusinessId({
        platform,
        kind: "comment",
        externalId: commentId,
        parentRef,
        customerRef: authorRef,
        content: `${authorName}: ${text}`.slice(0, 1000),
        // Leg C: keep author + text separate for the inbox normaliser.
        authorName,
        commentText: text,
        likes: 0,
        replied: false,
        repliedAt: null,
        replyRef: "",
        draftReply: "",
      }),
    });
    return { interactionId: stored.id, autoReplied: false };
  };

  let sub;
  try {
    sub = await requireActiveSubscription(businessId);
  } catch (err) {
    if (err instanceof SubscriptionInactiveError) {
      const blocked = await storeWithoutDraft();
      logger.warn(
        `[comments] subscription inactive — stored comment without AI draft (${platform} ${commentId})`
      );
      return blocked;
    }
    throw err;
  }

  // Feature scope (B6 follow-up): a grant scoped away from "chat" gets
  // the same stored-without-draft treatment. Chat-scoped grants and
  // unscoped accounts pass unchanged (explicit-false check only).
  if (sub.scopeAllowsChat === false) {
    const blocked = await storeWithoutDraft();
    logger.warn(
      `[comments] grant scope excludes chat — stored comment without AI draft (${platform} ${commentId})`
    );
    return blocked;
  }

  // Leg C: the global kill-switch gates AI draft + auto-post for comments
  // exactly as it gates every channel message (engine: settings.aiEnabled
  // !== false). A global-off comment is still stored honestly, with no
  // draft and no auto-post; staff may still reply manually from the inbox
  // (manual replies are the takeover path — see comment-inbox.ts).
  const settingsRow = await prisma.settings
    .findFirst({ select: { aiEnabled: true } })
    .catch(() => null);
  const globalAiEnabled =
    (settingsRow as { aiEnabled?: boolean } | null)?.aiEnabled ?? null;  if (globalAiEnabled === false) {
    const stored = await storeWithoutDraft();
    logger.warn(
      "[comments] global AI off — stored comment without AI draft and without auto-post"
    );
    return stored;
  }

  const account = await findAccountForComment(platform, parentRef);

  // Leg J: per-page COMMENT toggle + global switch. This gate is
  // independent of the message-reply toggles: it consults neither
  // the channel switch nor the message switch for this page. While
  // it blocks, the comment is stored WITHOUT a draft (the existing
  // store-without-draft path) — history is preserved, no agent reply
  // is drafted, and nothing can auto-send. A settings-read failure
  // reads as all-ON (the same missing-means-on rule as the other
  // switches), never as a silent kill.
  let commentPageToggles: PageToggles = {};
  let commentGlobalOn = true;
  try {
    const commentSettings = await prisma.settings.findFirst();
    const commentRaw = (commentSettings || {}) as Record<string, unknown>;
    commentPageToggles = parsePageToggles(commentRaw.pageAiToggles);
    commentGlobalOn = commentRaw.aiEnabled !== false;
  } catch (err) {
    logger.warn("[comments] toggle settings read failed; treating as all ON", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const commentKey = commentPageKey({
    accountRef: account?.accountRef,
    parentRef,
    platform,
  });
  const commentDecision = decideCommentReply({
    globalOn: commentGlobalOn,
    pageKey: commentKey,
    pageToggles: commentPageToggles,
  });
  if (!commentDecision.allowed) {
    const stored = await storeWithoutDraft();
    logger.warn(
      `[comments] comment-reply toggle blocked draft for ${platform} ${commentId} (blockedBy=${commentDecision.blockedBy})`
    );
    return stored;
  }

  // Draft the reply (stored, not sent). If the AI isn't configured, the
  // comment is still stored — the draft is just empty, and the business
  // can write the reply manually in the inbox.
  let draft = "";
  try {
    draft = await draftCommentReply(text, platform);
  } catch (err) {
    logger.warn("[comments] draft generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let autoReplied = false;
  let replyRef = "";
  let repliedAt: Date | null = null;

  // Auto-post ONLY when the business enabled it on this account AND the
  // reply gate allows it (global on + autoReply on). The gate is the single
  // authority; no auto-post default is introduced by this leg.
  // Owner-controls gate (settled 2026-10-28 model; lands ONLY in the
  // same batch as the wiring set, which provides both imports above).
  // Channel-held (facebook/instagram) or comment mode owner/approval
  // blocks the auto-post; the draft is still stored and the approval
  // queue still shows it. An adapter throw also blocks (fail-closed:
  // a corrupt owner-held entry must never read back as AI). Owner
  // dashboard approvals (approveCommentReply below) are NOT gated —
  // owner posting is always allowed. HEAD behaviour is unchanged
  // when mode is "auto" and the account enabled autoReply.
  let ownerControlsDoc: {
    businessId: string;
    channelControls: Record<string, { mode: "ai" | "owner" }>;
    commentMode: "auto" | "approval" | "owner";
  } | null = null;
  let ownerControlsError = false;
  try {
    ownerControlsDoc = (await getSettingsOwnerControlAdapter().getDoc(
      businessId
    )) as typeof ownerControlsDoc;
  } catch {
    ownerControlsError = true;
  }
  const commentGate = decideCommentAutoPost({
    doc: ownerControlsDoc,
    docError: ownerControlsError,
    platform,
    accountAutoReply: account?.autoReply === true,
  });
  // Auto-post ONLY when the business enabled it on this account AND
  // the owner-controls gate allows it.
  const autoGate = decideCommentReplyGate({
    globalAiEnabled,
    perThreadAiEnabled: null,
    // Per-channel gate: null until the toggles leg supplies it (LC-04
    // integration point). Null is never a block.
    perChannelEnabled: null,
    autoReplyEnabled: account?.autoReply ?? false,
    action: "auto_post",
  });
  // COMPOSED (2026-10-28): ALL THREE gates must allow — video-2 Leg C
  // reply gate, the owner-controls gate, AND video-2 Leg J's toggle
  // gate. Either gate blocking => no auto-post.
  if (draft && account && autoGate.allowed && commentGate.post && commentDecision.allowed) {
    try {
      const token = getDecryptedToken(account);
      replyRef = await postPlatformReply(
        account,
        token,
        { kind: platform === "facebook" ? "fb_comment" : "ig_comment", id: commentId },
        draft
      );
      autoReplied = true;
      repliedAt = new Date();
    } catch (err) {
      logger.warn("[comments] auto-reply post failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stored = await prisma.socialInteraction.create({
    data: withBusinessId({
      platform,
      kind: "comment",
      externalId: commentId,
      parentRef,
      customerRef: authorRef,
      content: `${authorName}: ${text}`.slice(0, 1000),
      // Leg C: keep author + text separate for the inbox normaliser.
      authorName,
      commentText: text,
      likes: 0,
      replied: autoReplied,
      repliedAt,
      replyRef,
      draftReply: draft,
      ...(account ? { socialAccountId: account.id } : {}),
    }),
  });

  logger.info("[comments] comment ticket created", {
    platform,
    commentId,
    autoReplied,
    account: account?.id || null,
  });
  return { interactionId: stored.id, autoReplied };
}

/**
 * Approve + send a drafted comment reply from the inbox. The business's
 * own text may override the AI draft. Posts through the real platform API
 * — only a platform-returned ID marks the interaction replied.
 */
export async function approveCommentReply(
  interactionId: string,
  text: string,
  // Leg C: the caller's tenant id. When supplied, a foreign-tenant row is
  // reported as "not found" (never leaked). The route (LC-04) always
  // supplies it and rejects a null businessId before calling.
  expectedBusinessId?: string
): Promise<{ replyId: string }> {
  const interaction = await prisma.socialInteraction.findUnique({
    where: { id: interactionId },
  });
  if (!interaction) throw new Error("Comment not found.");
  if (interaction.kind !== "comment") throw new Error("Not a comment ticket.");
  if (
    expectedBusinessId !== undefined &&
    !isSameTenant(expectedBusinessId, interaction.businessId)
  ) {
    throw new Error("Comment not found.");
  }
  if (interaction.replied) throw new Error("This comment was already replied to.");

  // Leg C: STRICT account resolution (see comment-inbox.ts). HEAD fell back
  // to the first account of the platform, which misroutes when several
  // Pages/profiles are connected. A stored account that is gone, or several
  // accounts with no stored id, is an error — never a guessed account.
  // (The manual-reply AI gate is checked by the route, LC-04, not here.)
  const accounts = await getActiveAccounts();
  const resolved = resolveCommentAccount(accounts, {
    platform: interaction.platform,
    socialAccountId: (interaction as { socialAccountId?: string }).socialAccountId,
  });
  if ("error" in resolved) {
    if (resolved.error === "account_ambiguous") {
      throw new Error(
        `Several connected ${interaction.platform} accounts and this comment has no stored account — the reply account is ambiguous. Open the comment's account in Channels first.`
      );
    }
    throw new Error(
      `No connected ${interaction.platform} account. Connect one in Channels first.`
    );
  }
  // COMPOSED (fix 2026-10-28): the resolver returns only {id, platform}
  // by design (strict routing); the full SocialAccount record is looked
  // up by that resolved id in the same active-accounts array — never a
  // fallback to another account, and a missing row fails closed.
  const account = accounts.find((a) => a.id === resolved.account.id);
  if (!account) {
    throw new Error(
      `Resolved ${interaction.platform} account is no longer active. Reconnect it in Channels first.`
    );
  }
  // Leg J (approval-mode integration point): an UNMODIFIED AI draft
  // is an agent reply, so if comment replies are off for this page
  // (or globally), approving it as-is must not send it — otherwise a
  // page switched off would still emit an agent reply through the
  // inbox. A human's own edited or written text is NOT an agent
  // reply and still passes: that is the team handling the comment,
  // exactly what global-off and takeover mean elsewhere. (Edge,
  // stated plainly: text a human retypes byte-identically to the
  // draft is indistinguishable from the draft and is blocked;
  // changing one character, or re-enabling the page, unblocks it.)
  const storedDraft =
    typeof (interaction as { draftReply?: unknown }).draftReply === "string"
      ? ((interaction as { draftReply: string }).draftReply as string)
      : "";
  if (storedDraft && text === storedDraft) {
    let approveToggles: PageToggles = {};
    let approveGlobalOn = true;
    try {
      const approveSettings = await prisma.settings.findFirst();
      const approveRaw = (approveSettings || {}) as Record<string, unknown>;
      approveToggles = parsePageToggles(approveRaw.pageAiToggles);
      approveGlobalOn = approveRaw.aiEnabled !== false;
    } catch (err) {
      logger.warn("[comments] approve toggle read failed; treating as all ON", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const approveDecision = decideCommentReply({
      globalOn: approveGlobalOn,
      pageKey: account.accountRef || null,
      pageToggles: approveToggles,
    });
    if (!approveDecision.allowed) {
      throw new Error(
        "COMMENT_REPLY_DISABLED: comment replies are switched off for this page."
      );
    }  }

  const token = getDecryptedToken(account);
  const replyId = await postPlatformReply(
    account,
    token,
    {
      kind: interaction.platform === "facebook" ? "fb_comment" : "ig_comment",
      id: interaction.externalId,
    },
    text
  );

  await prisma.socialInteraction.update({
    where: { id: interactionId },
    data: { replied: true, repliedAt: new Date(), replyRef: replyId },
  });
  return { replyId };
}

/**
 * Discard a comment ticket without replying (the business chose not to
 * respond). Marks it replied so it leaves the queue — the record stays
 * for the audit trail.
 */
export async function dismissComment(interactionId: string): Promise<void> {
  await prisma.socialInteraction.update({
    where: { id: interactionId },
    data: { replied: true, repliedAt: new Date(), replyRef: "dismissed" },
  });
}
