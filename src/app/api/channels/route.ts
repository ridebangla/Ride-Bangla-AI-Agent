import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

const CHANNEL_TYPES = ["whatsapp", "email", "phone", "sms", "telegram"];

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "channels:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const channels = await prisma.channel.findMany({
        orderBy: { type: "asc" },
      });

      const channelMap = new Map(channels.map((ch) => [ch.type, ch]));
      const result = CHANNEL_TYPES.map((type) => {
        const existing = channelMap.get(type);
        if (existing) return existing;
        return {
          id: null,
          type,
          isActive: false,
          config: {},
          status: "disconnected",
          createdAt: null,
          updatedAt: null,
        };
      });

      return NextResponse.json(result);
    } catch (error) {
      logger.error("Failed to fetch channels:", error);
      return NextResponse.json(
        { error: "Failed to fetch channels" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "channels:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json({ error: "No business selected." }, { status: 400 });
    }
    const businessId = auth.businessId;

    try {
      const body = await request.json();
      const { type, isActive, config } = body;

      if (!type || !CHANNEL_TYPES.includes(type)) {
        return NextResponse.json(
          { error: "Invalid channel type. Must be one of: " + CHANNEL_TYPES.join(", ") },
          { status: 400 }
        );
      }

      const channel = await prisma.channel.upsert({
        where: { businessId_type: { businessId, type } },
        update: {
          isActive: typeof isActive === "boolean" ? isActive : undefined,
          config: config ?? undefined,
        },
        create: withBusinessId({
          businessId,
          type,
          isActive: typeof isActive === "boolean" ? isActive : false,
          config: config ?? {},
          status: "disconnected",
        }),
      });

      return NextResponse.json(channel, { status: 200 });
    } catch (error) {
      logger.error("Failed to save channel:", error);
      return NextResponse.json(
        { error: "Failed to save channel" },
        { status: 500 }
      );
    }

  });
}
