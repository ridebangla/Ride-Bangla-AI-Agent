import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { cronAuth } from "@/lib/social/cron-auth";
import { getSubscription } from "@/lib/subscription";
import {
  getActiveAccounts,
  getDecryptedToken,
  isSupportedPlatform,
} from "@/lib/social/accounts";
import { generatePostContent, generatePostImage } from "@/lib/social/content";
import { publishPost } from "@/lib/social/publisher";

/**
 * Cron dispatch: publish due scheduled posts.
 * Call from a scheduler (e.g. every 5 minutes):
 *   POST /api/social/process
 *     Authorization: Bearer <CRON_SECRET>
 *     ?business=<slug>
 */
export async function POST(request: NextRequest) {
  const auth = await cronAuth(request, "automation:create");
  if (auth instanceof NextResponse) return auth;
  // Subscription hard-stop (user decision 16 + owner rule 2026-10-22):
  // this processor spends AI tokens, so a genuinely inactive business
  // (suspended / canceled / past_due) is stopped here too. Internal,
  // in-trial, free-tier and paid-active businesses all pass
  // getSubscription().isActive — only inactive states stop.
  const sub = await getSubscription(auth.businessId);
  if (!sub.isActive) {
    return NextResponse.json({ error: "subscription_paused" }, { status: 402 });
  }

  return runWithBusiness(auth.businessId, async () => {
  try {
    const due = await prisma.scheduledPost.findMany({
      where: { status: "scheduled", scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: "asc" },
      take: 10,
    });

    const results: Array<{
      id: string;
      status: string;
      resultRef?: string;
      error?: string;
    }> = [];

    for (const post of due) {
      if (!isSupportedPlatform(post.platform)) {
        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: "failed", error: `Unsupported platform: ${post.platform}` },
        });
        results.push({ id: post.id, status: "failed", error: "Unsupported platform" });
        continue;
      }

      try {
        const accounts = await getActiveAccounts();
        const account = accounts.find((a) => a.platform === post.platform);
        if (!account) {
          throw new Error(
            `No active ${post.platform} account connected. Connect one first.`
          );
        }
        const token = getDecryptedToken(account);

        const content = await generatePostContent({
          platform: post.platform,
          topic: post.topic || "latest update",
          postType: post.postType,
          textOverride: post.textContent || undefined,
          imagePromptOverride: post.imagePrompt || undefined,
        });

        // TEXT + PICTURE: generate the picture when an imagePrompt exists,
        // or automatically for promo posts.
        let imageBytes: Buffer | undefined;
        let imageMime: string | undefined;
        if (post.imagePrompt || post.postType === "promo") {
          const img = await generatePostImage(content.imagePrompt);
          imageBytes = img.bytes;
          imageMime = img.mimeType;
        }

        const result = await publishPost({
          platform: post.platform,
          accountRef: account.accountRef,
          token,
          text: content.text,
          imageBytes,
          imageMime,
        });

        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: "posted", resultRef: result.externalId, error: "" },
        });
        results.push({ id: post.id, status: "posted", resultRef: result.externalId });
        logger.info("Scheduled post published", {
          postId: post.id,
          platform: post.platform,
          externalId: result.externalId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: "failed", error: message.slice(0, 1000) },
        });
        results.push({ id: post.id, status: "failed", error: message });
        logger.error("Scheduled post failed", { postId: post.id, error: message });
      }
    }

    return NextResponse.json({ processed: results.length, results });
  } catch (error) {
    logger.error("Social process run failed:", error);
    return NextResponse.json(
      { error: "Failed to process scheduled posts" },
      { status: 500 }
    );
  }
  });
}
