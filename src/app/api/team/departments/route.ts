import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "team:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);

      const [departments, total] = await Promise.all([
        prisma.department.findMany({
          orderBy: { name: "asc" },
          skip,
          take,
          include: {
            _count: {
              select: { members: true },
            },
          },
        }),
        prisma.department.count(),
      ]);

      return NextResponse.json(paginatedResponse(departments, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch departments:", error);
      return NextResponse.json(
        { error: "Failed to fetch departments" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "team:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const body = await request.json();
      const { name, description, email } = body;

      if (!name || !name.trim()) {
        return NextResponse.json(
          { error: "Department name is required" },
          { status: 400 }
        );
      }

      const department = await prisma.department.create({
        data: withBusinessId({
          name: name.trim(),
          description: description?.trim() || "",
          email: email?.trim() || "",
        }),
        include: {
          _count: {
            select: { members: true },
          },
        },
      });

      return NextResponse.json(department, { status: 201 });
    } catch (error) {
      logger.error("Failed to create department:", error);
      return NextResponse.json(
        { error: "Failed to create department" },
        { status: 500 }
      );
    }

  });
}
