import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "customers:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const customer = await prisma.customer.findUnique({ where: { id } });
      if (!customer) {
        return NextResponse.json(
          { error: "Customer not found" },
          { status: 404 }
        );
      }

      const notes = await prisma.customerNote.findMany({
        where: { customerId: id },
        orderBy: { createdAt: "desc" },
      });

      return NextResponse.json(notes);
    } catch (error) {
      logger.error("Failed to fetch customer notes:", error);
      return NextResponse.json(
        { error: "Failed to fetch customer notes" },
        { status: 500 }
      );
    }

  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "customers:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;
      const body = await request.json();
      const { content, authorName } = body;

      if (!content || typeof content !== "string" || !content.trim()) {
        return NextResponse.json(
          { error: "Content is required" },
          { status: 400 }
        );
      }

      const customer = await prisma.customer.findUnique({ where: { id } });
      if (!customer) {
        return NextResponse.json(
          { error: "Customer not found" },
          { status: 404 }
        );
      }

      const note = await prisma.customerNote.create({
        data: withBusinessId({
          customerId: id,
          content: content.trim(),
          authorName: authorName?.trim() || "Admin",
        }),
      });

      return NextResponse.json(note, { status: 201 });
    } catch (error) {
      logger.error("Failed to create customer note:", error);
      return NextResponse.json(
        { error: "Failed to create customer note" },
        { status: 500 }
      );
    }

  });
}
