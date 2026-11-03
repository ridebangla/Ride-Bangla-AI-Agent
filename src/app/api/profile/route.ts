/**
 * /api/profile — the signed-in admin's profile (dashboard Profile page).
 *
 * The app never had a profile surface before: admins had no photo and the
 * contact details (name/phone/address) were only captured once at
 * signup/setup-application time. This route makes the whole profile
 * editable after creation:
 *
 * GET  — { admin: { name, email, role },
 *          business: { name, slug, profilePhoto, logoUrl, contactName,
 *                      contactPhone, contactAddress, siteKey } | null }
 *        business is null for the Super Admin (businessId null — they
 *        belong to no workspace), in which case only admin info is
 *        editable info.
 * PUT  — update { contactName, contactPhone, contactAddress, profilePhoto,
 *        logoUrl }
 *        on the caller's business (fail-closed, same pattern as
 *        /api/landing: unscoped client + explicit `where: { id:
 *        auth.businessId }`). logoUrl is the SAME Business.logoUrl field
 *        the Landing settings write — one stored field, two edit
 *        surfaces — validated identically (image data URL via
 *        checkImageDataUrl, else http(s) URL max 500 chars, else 400;
 *        empty clears it). Overwriting replaces the old value outright:
 *        data URLs live inline in the row, so there is no orphan file
 *        to delete. The sign-in email is deliberately NOT
 *        editable here — it is the Firebase identity and is managed in
 *        the Firebase console (same rule as the old admin panel: this
 *        app never touches credentials).
 *
 * Profile photo storage: no image-upload endpoint exists and Storage is
 * billing-gated, so the cropped photo is persisted as a data URL string —
 * the same proven pattern the catalog uses for product images. Capped
 * below the Firestore 1 MiB document limit (see src/lib/data-url.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUnscopedPrisma, runWithBusiness } from "@/lib/prisma";
import { checkImageDataUrl } from "@/lib/data-url";
import { MAX_TENANT_LOGO_HTTP_CHARS } from "@/lib/tenant-logo";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

const PHONE_RE = /^[+\d][\d\s\-().]{1,38}$/;

export async function GET(request: NextRequest) {
  // FIX (2026-10-31): this is the caller's OWN profile, not a
  // business-scoped read — a Super Admin with several businesses
  // must load it instead of failing BUSINESS_REQUIRED (the
  // dashboard sidebar never carries ?business=, so the plain
  // requireAuth path 400ed here; an explicit ?business= is still
  // honoured by requireAuth when present). A DB failure is an
  // honest 500 JSON, never an unhandled throw (the page previously
  // spun forever on any non-OK response).
  const auth = await requireAuth(request, undefined, {
    allowUnscopedSuperAdmin: true,
  });
  if (!isAuthenticated(auth)) return auth;

  try {
  const db = getUnscopedPrisma();
  const admin = await db.admin.findUnique({
    where: { id: auth.userId },
    select: { name: true, username: true, email: true, role: true, businessId: true },
  });
  if (!admin) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  let business = null;
  if (auth.businessId) {
    business = await db.business.findUnique({
      where: { id: auth.businessId },
      select: {
        name: true,
        slug: true,
        profilePhoto: true,
        logoUrl: true,
        contactName: true,
        contactPhone: true,
        contactAddress: true,
        // Re-audit #2: the tenant's widget install snippet (dashboard >
        // Channels) needs the business's own siteKey. It is public by
        // design (it ships inside the public website embed snippet), so
        // exposing it on the caller's own profile is safe.
        siteKey: true,
      },
    });
  }

  const email =
    (typeof admin.email === "string" && admin.email) ||
    (typeof admin.username === "string" ? admin.username : "") ||
    "";
  return NextResponse.json({
    admin: { name: admin.name ?? "", email, role: admin.role ?? "" },
    business: business
      ? {
          name: business.name ?? "",
          slug: business.slug ?? "",
          profilePhoto: business.profilePhoto ?? "",
          logoUrl: business.logoUrl ?? "",
          contactName: business.contactName ?? "",
          contactPhone: business.contactPhone ?? "",
          contactAddress: business.contactAddress ?? "",
          siteKey: business.siteKey ?? "",
        }
      : null,
  });
  } catch (error) {
    logger.error("Failed to load profile:", error);
    return NextResponse.json(
      { error: "Could not load your profile right now." },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "A business workspace is required to save a profile." },
      { status: 400 }
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const data: Record<string, unknown> = {};

      if (body.contactName !== undefined) {
        data.contactName = String(body.contactName ?? "").trim().slice(0, 120);
      }
      if (body.contactPhone !== undefined) {
        const phone = String(body.contactPhone ?? "").trim();
        if (phone && !PHONE_RE.test(phone)) {
          return NextResponse.json(
            { error: "That phone number does not look valid." },
            { status: 400 }
          );
        }
        data.contactPhone = phone;
      }
      if (body.contactAddress !== undefined) {
        data.contactAddress = String(body.contactAddress ?? "").trim().slice(0, 300);
      }
      if (body.profilePhoto !== undefined) {
        const photo = String(body.profilePhoto ?? "").trim();
        const check = checkImageDataUrl(photo);
        if (!check.ok) {
          return NextResponse.json({ error: check.error }, { status: 400 });
        }
        data.profilePhoto = photo || null;
      }
      if (body.logoUrl !== undefined) {
        // Tenant business logo — same field + same rules as PUT
        // /api/landing (see header comment). Never truncated: a sliced
        // data URL is a corrupted image, so oversize/invalid is an
        // honest 400, never a silent rewrite.
        const rawLogo = String(body.logoUrl ?? "").trim();
        if (rawLogo.startsWith("data:")) {
          const check = checkImageDataUrl(rawLogo);
          if (!check.ok) {
            return NextResponse.json({ error: check.error }, { status: 400 });
          }
          data.logoUrl = rawLogo;
        } else if (!rawLogo) {
          data.logoUrl = null;
        } else if (
          rawLogo.length > MAX_TENANT_LOGO_HTTP_CHARS ||
          !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(rawLogo)
        ) {
          return NextResponse.json(
            { error: "logoUrl must be a valid http(s) URL." },
            { status: 400 }
          );
        } else {
          data.logoUrl = rawLogo;
        }
      }

      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
      }

      const updated = await getUnscopedPrisma().business.update({
        where: { id: auth.businessId },
        data,
        select: {
          profilePhoto: true,
          logoUrl: true,
          contactName: true,
          contactPhone: true,
          contactAddress: true,
        },
      });

      const b = updated as {
        profilePhoto?: string | null;
        logoUrl?: string | null;
        contactName?: string | null;
        contactPhone?: string | null;
        contactAddress?: string | null;
      };
      return NextResponse.json({
        business: {
          profilePhoto: b.profilePhoto ?? "",
          logoUrl: b.logoUrl ?? "",
          contactName: b.contactName ?? "",
          contactPhone: b.contactPhone ?? "",
          contactAddress: b.contactAddress ?? "",
        },
      });
    } catch (error) {
      logger.error("Failed to update profile:", error);
      return NextResponse.json(
        { error: "Failed to save profile. Please try again." },
        { status: 500 }
      );
    }
  });
}
