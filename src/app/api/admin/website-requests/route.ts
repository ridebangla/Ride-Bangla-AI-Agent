/**
 * /api/admin/website-requests — website-creation application queue
 * (owner directive 2026-10-21). Platform Super Admin only.
 *
 * Businesses without a website apply from Settings > Websites; the Ride
 * Bangla IT Team builds the site as a separate service track. This is
 * the team's working queue: list every application across businesses
 * and move each through new → contacted → in_progress → delivered /
 * closed. Every status change appends to the request's statusHistory
 * AND writes an activityLog audit entry under the request's own
 * business scope (who + when), exactly like other admin actions.
 *
 * Nothing here touches subscriptions or billing — by design.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { logActivity } from "@/lib/activity";
import { logger } from "@/lib/logger";
import type { WebsiteCreationRequest } from "@/lib/models";

export const runtime = "nodejs";

const STATUSES = ["new", "contacted", "in_progress", "delivered", "closed"];

function serialize(app: WebsiteCreationRequest) {
  return {
    id: app.id,
    businessId: app.businessId,
    businessName: app.businessName,
    contactName: app.contactName,
    contactPhone: app.contactPhone,
    siteType: app.siteType,
    notes: app.notes,
    status: app.status,
    statusHistory: app.statusHistory ?? [],
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;
  if (auth.role !== "super_admin") {
    return NextResponse.json({ error: "Super Admin only" }, { status: 403 });
  }

  try {
    const status = request.nextUrl.searchParams.get("status");
    const apps = (await getUnscopedPrisma().websiteCreationRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    })) as unknown as WebsiteCreationRequest[];
    const filtered =
      status && STATUSES.includes(status)
        ? apps.filter((a) => a.status === status)
        : apps;
    return NextResponse.json({ requests: filtered.map(serialize) });
  } catch (err) {
    logger.error("[admin/website-requests] GET failed:", err);
    return NextResponse.json(
      { error: "Failed to load website requests" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request, "admin:update");
  if (!isAuthenticated(auth)) return auth;
  if (auth.role !== "super_admin") {
    return NextResponse.json({ error: "Super Admin only" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : "";
    const status = typeof body?.status === "string" ? body.status : "";
    if (!id || !STATUSES.includes(status)) {
      return NextResponse.json(
        { error: "A request id and a valid status are required." },
        { status: 400 }
      );
    }

    const db = getUnscopedPrisma();
    const existing = (await db.websiteCreationRequest.findUnique({
      where: { id },
    })) as unknown as WebsiteCreationRequest | null;
    if (!existing) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }
    if (existing.status === status) {
      return NextResponse.json({ request: serialize(existing) });
    }

    const by = auth.name || auth.username || "Super Admin";
    const history = [
      ...(Array.isArray(existing.statusHistory) ? existing.statusHistory : []),
      { status, by, at: new Date().toISOString() },
    ];

    // Update + audit inside the request's own business scope, so the
    // audit entry lands next to that business's other activity.
    const updated = await runWithBusiness(existing.businessId, async () => {
      const { prisma } = await import("@/lib/prisma");
      const row = (await prisma.websiteCreationRequest.update({
        where: { id },
        data: { status, statusHistory: history },
      })) as unknown as WebsiteCreationRequest;
      await logActivity(
        "website_request.status",
        "websiteCreationRequest",
        id,
        `Website creation request for "${existing.businessName}" moved ${existing.status} → ${status}`,
        by
      );
      return row;
    });

    return NextResponse.json({ request: serialize(updated) });
  } catch (err) {
    logger.error("[admin/website-requests] PATCH failed:", err);
    return NextResponse.json(
      { error: "Failed to update the request" },
      { status: 500 }
    );
  }
}
