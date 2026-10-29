import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  RESERVED_NAME_ERROR,
  isReservedBusinessName,
} from "@/lib/reserved-names";

/**
 * Business management — Super Admin only.
 * Regular business admins work inside their business via ?business=<slug>;
 * only the super admin (role super_admin) can list/create businesses.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
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

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "admin:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (auth.role !== "super_admin") {
      return NextResponse.json({ error: "Super Admin only" }, { status: 403 });
    }

    try {
      const body = await request.json();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return NextResponse.json({ error: "Business name is required" }, { status: 400 });
      }
      // Platform-name reservation (owner 2026-10-29 ~23:53): even a
      // Super Admin create may not mint a NEW business named "Ride
      // Bangla". A new business has no identity yet, so there is
      // nothing to exempt here — the company's own business already
      // exists and is created/flagged through the deploy-time seed /
      // Admin Console company-identity flow, not through this tenant
      // creation route. Checked before slug/business/settings rows.
      if (isReservedBusinessName(name)) {
        return NextResponse.json({ error: RESERVED_NAME_ERROR }, { status: 400 });
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
      // ID-05 (one agent per account): same seeding as the setup route —
      // the new account's agent row carries the business's own name from
      // birth, never the "My Business" default. Settings.businessId is
      // @unique, so exactly one agent configuration exists per business.
      await db.settings.create({
        data: { businessId: business.id, businessName: business.name },
      });
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

  });
}
