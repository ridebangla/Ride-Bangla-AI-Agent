import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { createCategory, createProduct } from "@/lib/catalog";

/**
 * Product catalog admin API. The catalog is the pluggable product/service
 * layer: each business fills in its own categories/products; the agent's
 * retrieval (search/recommend/alternatives) and order-taking read from it.
 * Ride Bangla has no own production yet — this ships empty-but-wired.
 */

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "knowledge:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const categories = await prisma.productCategory.findMany({
      include: {
        products: { orderBy: { name: "asc" } },
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ categories });
  } catch (error) {
    logger.error("Failed to fetch catalog:", error);
    return NextResponse.json({ error: "Failed to fetch catalog" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "knowledge:update");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { kind } = body;

    if (kind === "category") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return NextResponse.json({ error: "Category name is required" }, { status: 400 });
      }
      const category = await createCategory(name, body.description ?? "");
      return NextResponse.json(category, { status: 201 });
    }

    if (kind === "product") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return NextResponse.json({ error: "Product name is required" }, { status: 400 });
      }
      const price =
        body.price === null || body.price === undefined || body.price === ""
          ? null
          : Number(body.price);
      if (price !== null && (!Number.isFinite(price) || price < 0)) {
        return NextResponse.json({ error: "Invalid price" }, { status: 400 });
      }
      if (body.categoryId) {
        const cat = await prisma.productCategory.findUnique({
          where: { id: body.categoryId },
        });
        if (!cat) {
          return NextResponse.json({ error: "Category not found" }, { status: 400 });
        }
      }
      const product = await createProduct({
        name,
        description: body.description ?? "",
        price,
        currency: body.currency ?? "BDT",
        imageUrl: body.imageUrl ?? "",
        tags: body.tags ?? "",
        categoryId: body.categoryId ?? null,
        isAvailable: body.isAvailable ?? true,
      });
      return NextResponse.json(product, { status: 201 });
    }

    return NextResponse.json(
      { error: 'kind must be "category" or "product"' },
      { status: 400 }
    );
  } catch (error) {
    logger.error("Failed to create catalog entry:", error);
    return NextResponse.json({ error: "Failed to create catalog entry" }, { status: 500 });
  }
}
