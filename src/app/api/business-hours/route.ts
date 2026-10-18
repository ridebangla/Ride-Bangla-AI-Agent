import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "business-hours:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json({ error: "No business selected." }, { status: 400 });
    }
    const businessId = auth.businessId;

    try {
      let config = await prisma.businessHours.findUnique({
        where: { businessId },
      });

      if (!config) {
        config = await prisma.businessHours.create({
          data: { businessId },
        });
      }

      return NextResponse.json(config);
    } catch (error) {
      logger.error("Failed to fetch business hours:", error);
      return NextResponse.json(
        { error: "Failed to fetch business hours" },
        { status: 500 }
      );
    }

  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "business-hours:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json({ error: "No business selected." }, { status: 400 });
    }
    const businessId = auth.businessId;

    try {
      const body = await request.json();
      const {
        enabled,
        timezone,
        monday,
        tuesday,
        wednesday,
        thursday,
        friday,
        saturday,
        sunday,
        offlineMessage,
      } = body;

      const timePattern = /^\d{2}:\d{2}-\d{2}:\d{2}$/;
      const days = { monday, tuesday, wednesday, thursday, friday, saturday, sunday };

      for (const [day, value] of Object.entries(days)) {
        if (value !== undefined && value !== "" && !timePattern.test(value as string)) {
          return NextResponse.json(
            { error: `Invalid time format for ${day}. Use HH:mm-HH:mm or leave empty.` },
            { status: 400 }
          );
        }
      }

      const config = await prisma.businessHours.upsert({
        where: { businessId },
        update: {
          ...(enabled !== undefined && { enabled }),
          ...(timezone !== undefined && { timezone }),
          ...(monday !== undefined && { monday }),
          ...(tuesday !== undefined && { tuesday }),
          ...(wednesday !== undefined && { wednesday }),
          ...(thursday !== undefined && { thursday }),
          ...(friday !== undefined && { friday }),
          ...(saturday !== undefined && { saturday }),
          ...(sunday !== undefined && { sunday }),
          ...(offlineMessage !== undefined && { offlineMessage }),
        },
        create: {
          businessId,
          enabled: enabled ?? false,
          timezone: timezone ?? "UTC",
          monday: monday ?? "09:00-18:00",
          tuesday: tuesday ?? "09:00-18:00",
          wednesday: wednesday ?? "09:00-18:00",
          thursday: thursday ?? "09:00-18:00",
          friday: friday ?? "09:00-18:00",
          saturday: saturday ?? "",
          sunday: sunday ?? "",
          offlineMessage:
            offlineMessage ??
            "We are currently offline. We will get back to you during business hours.",
        },
      });

      return NextResponse.json(config);
    } catch (error) {
      logger.error("Failed to update business hours:", error);
      return NextResponse.json(
        { error: "Failed to update business hours" },
        { status: 500 }
      );
    }

  });
}
