/**
 * /api/business/website-requests — website-creation applications
 * (owner directive 2026-10-21).
 *
 * A business WITHOUT a website applies here; the Ride Bangla IT Team
 * builds the site as a SEPARATE service track ("আলাদা হিসাব"). This
 * record is deliberately unrelated to the subscription/billing system:
 * no plan check, no charge, no entitlement change — in either direction.
 *
 * GET  -> the caller's OWN requests only (tenant-scoped), newest first,
 *         each with its current status.
 * POST -> submit a new application. The platform team works the queue
 *         from the admin console (see /api/admin/website-requests).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { validateBody } from "@/lib/validations";
import type { WebsiteCreationRequest } from "@/lib/models";

export const runtime = "nodejs";

export const WEBSITE_REQUEST_STATUSES = [
  "new",
  "contacted",
  "in_progress",
  "delivered",
  "closed",
] as const;

const createSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  contactName: z.string().trim().min(2).max(100),
  contactPhone: z.string().trim().min(6).max(30),
  siteType: z
    .enum(["business", "ecommerce", "portfolio", "restaurant", "other"])
    .default("business"),
  notes: z.string().trim().max(1000).optional().default(""),
});

function serialize(app: WebsiteCreationRequest) {
  return {
    id: app.id,
    businessName: app.businessName,
    contactName: app.contactName,
    contactPhone: app.contactPhone,
    siteType: app.siteType,
    notes: app.notes,
    status: app.status,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "Website requests belong to a business account." },
      { status: 400 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const apps = (await prisma.websiteCreationRequest.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
      })) as unknown as WebsiteCreationRequest[];
      return NextResponse.json({ requests: apps.map(serialize) });
    } catch (err) {
      logger.error("[website-requests] GET failed:", err);
      return NextResponse.json(
        { error: "Couldn't load your website requests. Please try again." },
        { status: 500 }
      );
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "Website requests belong to a business account." },
      { status: 400 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`website-request:${auth.businessId}:${ip}`, {
    maxRequests: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many applications. Please try again later." },
      { status: 429 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json().catch(() => ({}));
      const validation = validateBody(createSchema, body);
      if (!validation.success) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
      const data = validation.data;

      const app = (await prisma.websiteCreationRequest.create({
        data: {
          ...data,
          status: "new",
          statusHistory: [
            { status: "new", by: data.contactName, at: new Date().toISOString() },
          ],
        },
      })) as unknown as WebsiteCreationRequest;

      logger.warn(
        `[website-requests] created for business=${auth.businessId} type=${data.siteType}`
      );
      return NextResponse.json({ request: serialize(app) });
    } catch (err) {
      logger.error("[website-requests] POST failed:", err);
      return NextResponse.json(
        { error: "Couldn't submit your application. Please try again." },
        { status: 500 }
      );
    }
  });
}
