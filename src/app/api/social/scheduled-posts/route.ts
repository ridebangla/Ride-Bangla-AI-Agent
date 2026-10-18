import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { isSupportedPlatform } from "@/lib/social/accounts";

const POST_TYPES = ["promo", "announcement", "engagement", "tip"];

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const posts = await prisma.scheduledPost.findMany({
        orderBy: { scheduledAt: "desc" },
        take: 50,
        select: {
          id: true,
          platform: true,
          postType: true,
          textContent: true,
          topic: true,
          imagePrompt: true,
          scheduledAt: true,
          status: true,
          resultRef: true,
          error: true,
          createdBy: true,
          createdAt: true,
        },
      });
      return NextResponse.json(posts);
    } catch (error) {
      logger.error("Failed to list scheduled posts:", error);
      return NextResponse.json(
        { error: "Failed to list scheduled posts" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const body = await request.json();
      const { platform, postType, topic, scheduledAt, textContent, imagePrompt } =
        body;

      if (!isSupportedPlatform(platform)) {
        return NextResponse.json(
          { error: "platform must be one of: facebook, instagram, x" },
          { status: 400 }
        );
      }
      const type = postType || "promo";
      if (!POST_TYPES.includes(type)) {
        return NextResponse.json(
          { error: `postType must be one of: ${POST_TYPES.join(", ")}` },
          { status: 400 }
        );
      }
      if (!topic || typeof topic !== "string" || !topic.trim()) {
        return NextResponse.json({ error: "topic is required" }, { status: 400 });
      }
      const when = new Date(scheduledAt);
      if (isNaN(when.getTime())) {
        return NextResponse.json(
          { error: "scheduledAt must be a valid ISO datetime" },
          { status: 400 }
        );
      }
      if (when <= new Date()) {
        return NextResponse.json(
          { error: "scheduledAt must be in the future" },
          { status: 400 }
        );
      }

      const post = await prisma.scheduledPost.create({
        data: withBusinessId({
          platform,
          postType: type,
          topic: topic.trim(),
          scheduledAt: when,
          textContent: typeof textContent === "string" ? textContent.trim() : "",
          imagePrompt: typeof imagePrompt === "string" ? imagePrompt.trim() : "",
          createdBy: "admin",
        }),
      });

      return NextResponse.json(post, { status: 201 });
    } catch (error) {
      logger.error("Failed to create scheduled post:", error);
      return NextResponse.json(
        { error: "Failed to create scheduled post" },
        { status: 500 }
      );
    }

  });
}
