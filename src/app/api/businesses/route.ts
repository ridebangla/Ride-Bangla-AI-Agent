import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

/**
 * Business management — Super Admin only.
 * Regular business admins work inside their business via ?business=<slug>;
 * only the super admin (role super_admin) can list/create businesses.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;
  if (auth.role !== "super_admin") {
    return NextResponse.json({ error: "Super Admin only" }, { status: 403 });
  }

  try {
    const businesses = await getUnscopedPrisma().business.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        siteKey: true,
        isActive: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ businesses });
  } catch (error) {
    logger.error("Failed to list businesses:", error);
    return NextResponse.json({ error: "Failed to list businesses" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "admin:create");
  if (!isAuthenticated(auth)) return auth;
  if (auth.role !== "super_admin") {
    return NextResponse.json({ error: "Super Admin only" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "Business name is required" }, { status: 400 });
    }

    const { randomUUID } = await import("crypto");
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business";

    const db = getUnscopedPrisma();
    // Ensure slug uniqueness.
    let slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
    while (await db.business.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
    }

    const business = await db.business.create({
      data: {
        name,
        slug,
        siteKey: "rbsite-" + randomUUID().replace(/-/g, ""),
        isActive: true,
      },
    });

    // Bootstrap per-business rows.
    await db.settings.create({ data: { businessId: business.id } });
    await db.businessHours.create({ data: { businessId: business.id, timezone: "Asia/Dhaka" } });
    for (const type of ["whatsapp", "email", "phone", "telegram"]) {
      await db.channel.create({
        data: { businessId: business.id, type, isActive: false, status: "disconnected" },
      });
    }

    return NextResponse.json({ business }, { status: 201 });
  } catch (error) {
    logger.error("Failed to create business:", error);
    return NextResponse.json({ error: "Failed to create business" }, { status: 500 });
  }
}
