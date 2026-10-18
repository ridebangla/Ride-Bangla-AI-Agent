import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const interactions = await prisma.socialInteraction.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        platform: true,
        kind: true,
        externalId: true,
        customerRef: true,
        content: true,
        likes: true,
        replied: true,
        repliedAt: true,
        createdAt: true,
      },
    });
    return NextResponse.json(interactions);
  } catch (error) {
    logger.error("Failed to list social interactions:", error);
    return NextResponse.json(
      { error: "Failed to list social interactions" },
      { status: 500 }
    );
  }
}
