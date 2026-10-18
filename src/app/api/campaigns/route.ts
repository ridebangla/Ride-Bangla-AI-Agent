import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "analytics:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const status = searchParams.get("status");
      const channel = searchParams.get("channel");

      const where: Record<string, unknown> = {};

      if (status && status !== "all") {
        where.status = status;
      }

      if (channel && channel !== "all") {
        where.channel = channel;
      }

      const [campaigns, total] = await Promise.all([
        prisma.campaign.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.campaign.count({ where }),
      ]);

      return NextResponse.json(paginatedResponse(campaigns, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch campaigns:", error);
      return NextResponse.json(
        { error: "Failed to fetch campaigns" },
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
      const { name, description, channel, message, subject, segments, scheduledAt } =
        body;

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
          { error: "Name is required" },
          { status: 400 }
        );
      }

      if (!message || typeof message !== "string" || message.trim().length === 0) {
        return NextResponse.json(
          { error: "Message is required" },
          { status: 400 }
        );
      }

      const campaign = await prisma.campaign.create({
        data: withBusinessId({
          name: name.trim(),
          description: description?.trim() || "",
          channel: channel || "email",
          message: message.trim(),
          subject: subject?.trim() || "",
          segments: segments || [],
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        }),
      });

      return NextResponse.json(campaign, { status: 201 });
    } catch (error) {
      logger.error("Failed to create campaign:", error);
      return NextResponse.json(
        { error: "Failed to create campaign" },
        { status: 500 }
      );
    }

  });
}
