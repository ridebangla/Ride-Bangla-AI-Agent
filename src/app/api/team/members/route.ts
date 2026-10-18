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
      const departmentId = searchParams.get("departmentId");

      const where = departmentId ? { departmentId } : {};

      const [members, total] = await Promise.all([
        prisma.teamMember.findMany({
          where,
          orderBy: { name: "asc" },
          skip,
          take,
          include: {
            department: {
              select: { id: true, name: true },
            },
          },
        }),
        prisma.teamMember.count({ where }),
      ]);

      return NextResponse.json(paginatedResponse(members, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch members:", error);
      return NextResponse.json(
        { error: "Failed to fetch members" },
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
      const { name, email, phone, role, expertise, departmentId } = body;

      if (!name || !name.trim()) {
        return NextResponse.json(
          { error: "Member name is required" },
          { status: 400 }
        );
      }

      if (!email || !email.trim()) {
        return NextResponse.json(
          { error: "Member email is required" },
          { status: 400 }
        );
      }

      if (!departmentId) {
        return NextResponse.json(
          { error: "Department is required" },
          { status: 400 }
        );
      }

      const member = await prisma.teamMember.create({
        data: withBusinessId({
          name: name.trim(),
          email: email.trim(),
          phone: phone?.trim() || "",
          role: role?.trim() || "member",
          expertise: expertise?.trim() || "",
          departmentId,
        }),
        include: {
          department: {
            select: { id: true, name: true },
          },
        },
      });

      return NextResponse.json(member, { status: 201 });
    } catch (error) {
      logger.error("Failed to create member:", error);
      return NextResponse.json(
        { error: "Failed to create member" },
        { status: 500 }
      );
    }

  });
}
