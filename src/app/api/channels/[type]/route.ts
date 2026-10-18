import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

const CHANNEL_TYPES = ["whatsapp", "email", "phone", "sms", "telegram"];

type RouteContext = { params: Promise<{ type: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "channels:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json({ error: "No business selected." }, { status: 400 });
    }
    const businessId = auth.businessId;

    try {
      const { type } = await context.params;

      if (!CHANNEL_TYPES.includes(type)) {
        return NextResponse.json(
          { error: "Invalid channel type" },
          { status: 400 }
        );
      }

      const channel = await prisma.channel.findUnique({
        where: { businessId_type: { businessId, type } },
      });

      if (!channel) {
        return NextResponse.json({
          id: null,
          type,
          isActive: false,
          config: {},
          status: "disconnected",
          createdAt: null,
          updatedAt: null,
        });
      }

      return NextResponse.json(channel);
    } catch (error) {
      logger.error("Failed to fetch channel:", error);
      return NextResponse.json(
        { error: "Failed to fetch channel" },
        { status: 500 }
      );
    }

  });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "channels:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json({ error: "No business selected." }, { status: 400 });
    }
    const businessId = auth.businessId;

    try {
      const { type } = await context.params;

      if (!CHANNEL_TYPES.includes(type)) {
        return NextResponse.json(
          { error: "Invalid channel type" },
          { status: 400 }
        );
      }

      const body = await request.json();
      const { isActive, config, status } = body;

      const channel = await prisma.channel.upsert({
        where: { businessId_type: { businessId, type } },
        update: {
          isActive: typeof isActive === "boolean" ? isActive : undefined,
          config: config ?? undefined,
          status: status ?? undefined,
        },
        create: withBusinessId({
          type,
          isActive: typeof isActive === "boolean" ? isActive : false,
          config: config ?? {},
          status: status ?? "disconnected",
        }),
      });

      return NextResponse.json(channel);
    } catch (error) {
      logger.error("Failed to update channel:", error);
      return NextResponse.json(
        { error: "Failed to update channel" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "channels:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json({ error: "No business selected." }, { status: 400 });
    }
    const businessId = auth.businessId;

    try {
      const { type } = await context.params;

      if (!CHANNEL_TYPES.includes(type)) {
        return NextResponse.json(
          { error: "Invalid channel type" },
          { status: 400 }
        );
      }

      const body = await request.json();
      const { action } = body;

      if (!action || !["connect", "disconnect", "test"].includes(action)) {
        return NextResponse.json(
          { error: "Invalid action. Must be one of: connect, disconnect, test" },
          { status: 400 }
        );
      }

      const channel = await prisma.channel.findUnique({
        where: { businessId_type: { businessId, type } },
      });

      if (action === "disconnect") {
        const updated = await prisma.channel.upsert({
          where: { businessId_type: { businessId, type } },
          update: { status: "disconnected" },
          create: withBusinessId({
            type,
            isActive: false,
            config: {},
            status: "disconnected",
          }),
        });
        return NextResponse.json({
          ...updated,
          message: `${type} channel disconnected`,
        });
      }

      if (action === "connect") {
        if (!channel?.config || Object.keys(channel.config as object).length === 0) {
          return NextResponse.json(
            { error: "Channel must be configured before connecting" },
            { status: 400 }
          );
        }

        const updated = await prisma.channel.update({
          where: { businessId_type: { businessId, type } },
          data: { status: "connected", isActive: true },
        });

        return NextResponse.json({
          ...updated,
          message: `${type} channel connected`,
        });
      }

      if (action === "test") {
        if (!channel?.config || Object.keys(channel.config as object).length === 0) {
          return NextResponse.json(
            { error: "Channel must be configured before testing" },
            { status: 400 }
          );
        }

        return NextResponse.json({
          success: true,
          message: `${type} connection test initiated`,
          channel,
        });
      }

      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    } catch (error) {
      logger.error("Failed to perform channel action:", error);
      return NextResponse.json(
        { error: "Failed to perform channel action" },
        { status: 500 }
      );
    }

  });
}
