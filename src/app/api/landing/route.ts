/**
 * /api/landing — landing-page settings for the tenant's business.
 *
 * GET  — full landing payload for the dashboard editor + live preview:
 *        { business, copy, products, aboutEntries, hours, contact,
 *          categories } (products grouped for the preview grid).
 *        business additionally carries: landingTheme (resolved),
 *        aiSuggestedTheme (advisory, from "Enhance with AI"),
 *        landingQuality (last recorded quality-gate summary, if any),
 *        and the top-level `themes` list (id/name/description/swatch)
 *        drives the dashboard theme picker.
 * PUT  — update { tagline, brandColor, logoUrl, landingPublished,
 *        websiteUrl, landingTheme, landingQuality }.
 *
 * Permission: settings:read / settings:update (business-level config,
 * admin only). The business row is updated via the UNSCOPED client with an
 * explicit `where: { id: auth.businessId }` — fail-closed (no businessId
 * => 400, never touches another tenant's row).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { sanitizeBrandColor } from "@/lib/landing-copy";
import {
  sanitizeLandingTheme,
  LANDING_THEMES,
  LANDING_THEME_IDS,
} from "@/lib/landing-themes";
import { getLandingData } from "@/lib/landing";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const db = getUnscopedPrisma();
      const business = (await db.business.findUnique({
        where: { id: auth.businessId },
        select: {
          id: true,
          name: true,
          slug: true,
          siteKey: true,
          tagline: true,
          brandColor: true,
          logoUrl: true,
          websiteUrl: true,
          landingPublished: true,
          landingTheme: true,
          landingAiCopy: true,
          landingQuality: true,
        },
      })) as null | {
        id: string;
        name: string;
        slug: string;
        siteKey: string;
        tagline?: string | null;
        brandColor?: string | null;
        logoUrl?: string | null;
        websiteUrl?: string | null;
        landingPublished?: boolean | null;
        landingTheme?: string | null;
        landingAiCopy?: { suggestedTheme?: string | null } | null;
        landingQuality?: {
          ready?: boolean;
          fails?: number;
          warnings?: number;
          checkedAt?: string;
        } | null;
      };
      if (!business) {
        return NextResponse.json({ error: "Business not found." }, { status: 404 });
      }

      const landing = await getLandingData(business.slug);
      const rawSuggestion =
        business.landingAiCopy && typeof business.landingAiCopy.suggestedTheme === "string"
          ? business.landingAiCopy.suggestedTheme.trim()
          : "";
      return NextResponse.json({
        business: {
          name: business.name,
          slug: business.slug,
          siteKey: business.siteKey,
          tagline: business.tagline ?? "",
          brandColor: sanitizeBrandColor(business.brandColor),
          logoUrl: business.logoUrl ?? "",
          websiteUrl: business.websiteUrl ?? "",
          landingPublished: business.landingPublished === true,
          landingTheme: sanitizeLandingTheme(business.landingTheme),
          aiSuggestedTheme: (LANDING_THEME_IDS as readonly string[]).includes(rawSuggestion)
            ? rawSuggestion
            : null,
          landingQuality: business.landingQuality ?? null,
        },
        themes: LANDING_THEMES.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          swatch: t.swatch,
        })),
        publicUrl: `/p/${business.slug}`,
        preview: landing,
      });
    } catch (error) {
      logger.error("Failed to fetch landing data:", error);
      return NextResponse.json(
        { error: "Failed to fetch landing data" },
        { status: 500 }
      );
    }
  });
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function isValidQualityRecord(v: unknown): v is {
  ready: boolean;
  fails: number;
  warnings: number;
  checkedAt: string;
} {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ready === "boolean" &&
    typeof r.fails === "number" &&
    typeof r.warnings === "number" &&
    typeof r.checkedAt === "string"
  );
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const data: Record<string, unknown> = {};

      if (body.tagline !== undefined) {
        const tagline = String(body.tagline ?? "").trim().slice(0, 160);
        data.tagline = tagline;
      }
      if (body.brandColor !== undefined) {
        const raw = String(body.brandColor ?? "").trim();
        if (raw && !HEX_RE.test(raw)) {
          return NextResponse.json(
            { error: "brandColor must be a hex color like #0B7A55." },
            { status: 400 }
          );
        }
        data.brandColor = raw ? sanitizeBrandColor(raw) : null;
      }
      if (body.logoUrl !== undefined) {
        const logoUrl = String(body.logoUrl ?? "").trim().slice(0, 500);
        if (logoUrl && !URL_RE.test(logoUrl)) {
          return NextResponse.json(
            { error: "logoUrl must be a valid http(s) URL." },
            { status: 400 }
          );
        }
        data.logoUrl = logoUrl || null;
      }
      if (body.websiteUrl !== undefined) {
        const websiteUrl = String(body.websiteUrl ?? "").trim().slice(0, 300);
        if (websiteUrl && !URL_RE.test(websiteUrl)) {
          return NextResponse.json(
            { error: "websiteUrl must be a valid http(s) URL." },
            { status: 400 }
          );
        }
        data.websiteUrl = websiteUrl || null;
      }
      if (body.landingPublished !== undefined) {
        data.landingPublished = Boolean(body.landingPublished);
      }
      if (body.landingTheme !== undefined) {
        const rawTheme = String(body.landingTheme ?? "").trim();
        if (!(LANDING_THEME_IDS as readonly string[]).includes(rawTheme)) {
          return NextResponse.json(
            {
              error: `Unknown theme "${rawTheme}". Valid themes: ${LANDING_THEME_IDS.join(", ")}.`,
            },
            { status: 400 }
          );
        }
        data.landingTheme = rawTheme;
      }
      if (body.landingQuality !== undefined) {
        if (!isValidQualityRecord(body.landingQuality)) {
          return NextResponse.json(
            { error: "landingQuality must be { ready, fails, warnings, checkedAt }." },
            { status: 400 }
          );
        }
        data.landingQuality = {
          ready: body.landingQuality.ready,
          fails: body.landingQuality.fails,
          warnings: body.landingQuality.warnings,
          checkedAt: body.landingQuality.checkedAt,
        };
      }

      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
      }

      const updated = await getUnscopedPrisma().business.update({
        where: { id: auth.businessId },
        data,
        select: {
          tagline: true,
          brandColor: true,
          logoUrl: true,
          websiteUrl: true,
          landingPublished: true,
          landingTheme: true,
          landingQuality: true,
          slug: true,
        },
      });

      return NextResponse.json({ business: updated, publicUrl: `/p/${(updated as { slug: string }).slug}` });
    } catch (error) {
      logger.error("Failed to update landing settings:", error);
      return NextResponse.json(
        { error: "Failed to update landing settings" },
        { status: 500 }
      );
    }
  });
}
