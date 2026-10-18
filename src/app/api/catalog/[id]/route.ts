import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "knowledge:update");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await context.params;
    const body = await request.json();
    const { kind } = body;
    delete body.kind;
    delete body.id;
    delete body.businessId;

    if (kind === "category") {
      const updated = await prisma.productCategory.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: String(body.name).trim() }),
          ...(body.description !== undefined && { description: String(body.description) }),
        },
      });
      return NextResponse.json(updated);
    }

    if (kind === "product") {
      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = String(body.name).trim();
      if (body.description !== undefined) data.description = String(body.description);
      if (body.price !== undefined) {
        const price = body.price === null || body.price === "" ? null : Number(body.price);
        if (price !== null && (!Number.isFinite(price) || price < 0)) {
          return NextResponse.json({ error: "Invalid price" }, { status: 400 });
        }
        data.price = price;
      }
      if (body.currency !== undefined) data.currency = String(body.currency);
      if (body.imageUrl !== undefined) data.imageUrl = String(body.imageUrl);
      if (body.tags !== undefined) data.tags = String(body.tags);
      if (body.isAvailable !== undefined) data.isAvailable = Boolean(body.isAvailable);
      if (body.categoryId !== undefined) {
        if (body.categoryId) {
          const cat = await prisma.productCategory.findUnique({
            where: { id: String(body.categoryId) },
          });
          if (!cat) {
            return NextResponse.json({ error: "Category not found" }, { status: 400 });
          }
          data.categoryId = cat.id;
        } else {
          data.categoryId = null;
        }
      }
      const updated = await prisma.product.update({ where: { id }, data });
      return NextResponse.json(updated);
    }

    return NextResponse.json(
      { error: 'kind must be "category" or "product"' },
      { status: 400 }
    );
  } catch (error) {
    logger.error("Failed to update catalog entry:", error);
    return NextResponse.json({ error: "Failed to update catalog entry" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request, "knowledge:update");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await context.params;
    const kind = request.nextUrl.searchParams.get("kind");

    if (kind === "category") {
      await prisma.productCategory.delete({ where: { id } });
    } else {
      await prisma.product.delete({ where: { id } });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete catalog entry:", error);
    return NextResponse.json({ error: "Failed to delete catalog entry" }, { status: 500 });
  }
}
