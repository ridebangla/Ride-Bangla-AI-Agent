/**
 * /api/setup-application — done-for-you setup applications.
 *
 * GET  -> the tenant's latest application (or { application: null }).
 * POST -> create a new application, or update the existing pending one.
 *
 * The customer fills this AFTER signup, inside the dashboard. The Ride
 * Bangla team works the queue from the Admin Console and connects every
 * channel for them — the customer never touches API keys.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { z } from "zod";
import { validateBody } from "@/lib/validations";
import type { SetupApplication } from "@/lib/models";
import {
  RESERVED_NAME_ERROR,
  isReservedBusinessName,
} from "@/lib/reserved-names";
import { isCompanyBusiness } from "@/lib/company-identity";

const CHANNEL_IDS = [
  "widget",
  "facebook",
  "messenger",
  "instagram",
  "whatsapp",
  "youtube",
  "linkedin",
  "x",
  "email",
  "phone",
] as const;

const applicationSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  contactName: z.string().trim().min(2).max(100),
  contactPhone: z.string().trim().max(30).optional().default(""),
  contactEmail: z.string().trim().max(254).optional().default(""),
  channelsWanted: z
    .array(z.enum(CHANNEL_IDS))
    .max(CHANNEL_IDS.length)
    .optional()
    .default([]),
  preferredContact: z.enum(["whatsapp", "phone", "email"]).default("whatsapp"),
  notes: z.string().trim().max(1000).optional().default(""),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function serialize(app: SetupApplication) {
  return {
    id: app.id,
    businessName: app.businessName,
    contactName: app.contactName,
    contactPhone: app.contactPhone,
    contactEmail: app.contactEmail,
    channelsWanted: app.channelsWanted,
    preferredContact: app.preferredContact,
    notes: app.notes,
    status: app.status,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const latest = await prisma.setupApplication.findMany({
        orderBy: { createdAt: "desc" },
        take: 1,
      });
      return NextResponse.json({
        application: latest.length > 0 ? serialize(latest[0]) : null,
      });
    } catch (err) {
      logger.error("[setup-application] GET failed:", err);
      return NextResponse.json(
        { error: "Failed to load your application." },
        { status: 500 }
      );
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`setup-app:${ip}`, {
    maxRequests: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const validation = validateBody(applicationSchema, body);
      if (!validation.success) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
      const data = validation.data;

      // Platform-name reservation (owner 2026-10-29 ~23:53): a tenant
      // may not SET UP with the name "Ride Bangla". Checked BEFORE
      // the application row is created/updated and before the
      // Business/Settings identity sync, so a blocked attempt leaves
      // no application row and no identity change behind.
      // EXEMPTION: the company's own business is skipped (it already
      // is Ride Bangla); on an exemption-check failure the business
      // is treated as non-company (block applies).
      if (
        isReservedBusinessName(data.businessName) &&
        !(await isCompanyBusiness(auth.businessId ?? ""))
      ) {
        return NextResponse.json(
          { error: RESERVED_NAME_ERROR },
          { status: 400 }
        );
      }

      if (data.preferredContact === "whatsapp" && data.contactPhone.trim().length < 6) {
        return NextResponse.json(
          { error: "Please provide a phone/WhatsApp number so our team can reach you." },
          { status: 400 }
        );
      }
      if (
        data.preferredContact === "email" &&
        !EMAIL_RE.test(data.contactEmail)
      ) {
        return NextResponse.json(
          { error: "Please provide a valid email so our team can reach you." },
          { status: 400 }
        );
      }

      const pending = await prisma.setupApplication.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 1,
      });

      let app;
      if (pending.length > 0) {
        app = await prisma.setupApplication.update({
          where: { id: pending[0].id },
          data: { ...data },
        });
      } else {
        app = await prisma.setupApplication.create({ data: { ...data } });
      }

      // Keep the business + settings identity in sync with the real business
      // name the customer just gave us (may be better than the signup guess).
      try {
        if (auth.businessId && data.businessName) {
          await prisma.business.update({
            where: { id: auth.businessId },
            data: { name: data.businessName },
          });
          await prisma.settings.upsert({
            where: { businessId: auth.businessId },
            update: { businessName: data.businessName },
            create: {
              businessId: auth.businessId,
              businessName: data.businessName,
            },
          });
        }
      } catch (err) {
        // Identity sync is a bonus — the application itself is already
        // saved — but a silent failure used to leave identity stale with
        // no trace. Log it so a failed flip is visible, not hidden.
        logger.warn("[setup-application] identity sync failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.warn(
        `[setup-application] ${pending.length > 0 ? "updated" : "created"} for business=${auth.businessId} channels=${data.channelsWanted.join(",")}`
      );
      return NextResponse.json({ application: serialize(app) });
    } catch (err) {
      logger.error("[setup-application] POST failed:", err);
      return NextResponse.json(
        { error: "Failed to save your application. Please try again." },
        { status: 500 }
      );
    }
  });
}
