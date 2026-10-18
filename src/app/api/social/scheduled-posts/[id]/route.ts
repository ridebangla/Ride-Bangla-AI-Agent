import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:delete");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;

    const post = await prisma.scheduledPost.findUnique({ where: { id } });
    if (!post) {
      return NextResponse.json(
        { error: "Scheduled post not found" },
        { status: 404 }
      );
    }
    if (post.status !== "scheduled") {
      return NextResponse.json(
        { error: `Only scheduled posts can be deleted (status is ${post.status})` },
        { status: 409 }
      );
    }

    await prisma.scheduledPost.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("Failed to delete scheduled post:", error);
    return NextResponse.json(
      { error: "Failed to delete scheduled post" },
      { status: 500 }
    );
  }
}
