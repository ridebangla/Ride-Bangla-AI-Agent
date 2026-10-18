import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const type = searchParams.get("type");

      const where: Record<string, unknown> = {};

      if (type && type !== "all") {
        where.type = type;
      }

      const [rules, total] = await Promise.all([
        prisma.automationRule.findMany({
          where,
          orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
          skip,
          take,
        }),
        prisma.automationRule.count({ where }),
      ]);

      return NextResponse.json(paginatedResponse(rules, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch automation rules:", error);
      return NextResponse.json(
        { error: "Failed to fetch automation rules" },
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
      const { name, description, type, isActive, conditions, actions, priority } =
        body;

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
          { error: "Name is required" },
          { status: 400 }
        );
      }

      const validTypes = ["auto_route", "auto_tag", "auto_reply", "keyword_alert"];
      if (!type || !validTypes.includes(type)) {
        return NextResponse.json(
          { error: "Invalid rule type" },
          { status: 400 }
        );
      }

      if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
        return NextResponse.json(
          { error: "At least one condition is required" },
          { status: 400 }
        );
      }

      if (!actions || !Array.isArray(actions) || actions.length === 0) {
        return NextResponse.json(
          { error: "At least one action is required" },
          { status: 400 }
        );
      }

      const rule = await prisma.automationRule.create({
        data: withBusinessId({
          name: name.trim(),
          description: description?.trim() || "",
          type,
          isActive: isActive ?? true,
          conditions,
          actions,
          priority: priority ?? 0,
        }),
      });

      return NextResponse.json(rule, { status: 201 });
    } catch (error) {
      logger.error("Failed to create automation rule:", error);
      return NextResponse.json(
        { error: "Failed to create automation rule" },
        { status: 500 }
      );
    }

  });
}
