import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);

      const [users, total] = await Promise.all([
        prisma.admin.findMany({
          select: {
            id: true,
            username: true,
            name: true,
            role: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "asc" },
          skip,
          take,
        }),
        prisma.admin.count(),
      ]);

      return NextResponse.json(paginatedResponse(users, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch admin users:", error);
      return NextResponse.json(
        { error: "Failed to fetch admin users" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "admin:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const body = await request.json();
      const { username, password, name, role } = body;

      if (!username || typeof username !== "string" || username.trim().length === 0) {
        return NextResponse.json(
          { error: "Username is required" },
          { status: 400 }
        );
      }

      if (!password || typeof password !== "string" || password.length < 6) {
        return NextResponse.json(
          { error: "Password must be at least 6 characters" },
          { status: 400 }
        );
      }

      const existing = await prisma.admin.findUnique({
        where: { username: username.trim() },
      });
      if (existing) {
        return NextResponse.json(
          { error: "Username already exists" },
          { status: 409 }
        );
      }

      const validRoles = ["admin", "editor", "viewer"];
      const userRole = validRoles.includes(role) ? role : "viewer";

      const hashed = await hashPassword(password);
      const user = await prisma.admin.create({
        data: {
          username: username.trim(),
          password: hashed,
          name: name?.trim() || username.trim(),
          role: userRole,
        },
        select: {
          id: true,
          username: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return NextResponse.json(user, { status: 201 });
    } catch (error) {
      logger.error("Failed to create admin user:", error);
      return NextResponse.json(
        { error: "Failed to create admin user" },
        { status: 500 }
      );
    }

  });
}
