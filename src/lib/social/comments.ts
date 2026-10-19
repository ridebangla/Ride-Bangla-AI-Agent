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
import {
  requireActiveSubscription,
  SubscriptionInactiveError,
} from "@/lib/subscription";
import type { SocialAccount } from "@/lib/models";

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
  // but spend nothing on a draft and send nothing.
  try {
    await requireActiveSubscription(businessId);
  } catch (err) {
    if (err instanceof SubscriptionInactiveError) {
      const stored = await prisma.socialInteraction.create({
        data: withBusinessId({
          platform,
          kind: "comment",
          externalId: commentId,
          parentRef,
          customerRef: authorRef,
          content: `${authorName}: ${text}`.slice(0, 1000),
          likes: 0,
          replied: false,
          repliedAt: null,
          replyRef: "",
          draftReply: "",
        }),
      });
      logger.warn(
        `[comments] subscription inactive — stored comment without AI draft (${platform} ${commentId})`
      );
      return { interactionId: stored.id, autoReplied: false };
    }
    throw err;
  }

  const account = await findAccountForComment(platform, parentRef);

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

  // Auto-post ONLY when the business enabled it on this account.
  if (draft && account?.autoReply) {
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
  text: string
): Promise<{ replyId: string }> {
  const interaction = await prisma.socialInteraction.findUnique({
    where: { id: interactionId },
  });
  if (!interaction) throw new Error("Comment not found.");
  if (interaction.kind !== "comment") throw new Error("Not a comment ticket.");
  if (interaction.replied) throw new Error("This comment was already replied to.");

  const accounts = await getActiveAccounts();
  const account =
    (interaction as { socialAccountId?: string }).socialAccountId
      ? accounts.find(
          (a) => a.id === (interaction as { socialAccountId?: string }).socialAccountId
        )
      : accounts.find((a) => a.platform === interaction.platform);
  if (!account) {
    throw new Error(
      `No connected ${interaction.platform} account. Connect one in Channels first.`
    );
  }

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
