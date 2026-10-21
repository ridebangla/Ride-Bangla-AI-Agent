/**
 * /api/business/websites — the business's website list
 * (owner directive 2026-10-21: ALL of a business's websites can be
 * added — 10 sites = 10 entries — and the agent learns from each).
 *
 * GET    -> { websites } for the caller's own business only.
 * POST   -> { url } add + index now; duplicate/invalid input gets a
 *           kind 400 with the reason; a fetch failure still saves the
 *           entry, with status "failed" + the reason (never a fake
 *           "trained").
 * PATCH  -> { id } re-run the fetch-and-learn for one listed site.
 * DELETE -> ?id= remove the site and the entries learned from it.
 *
 * The business id comes from auth only — never from the body — and
 * there is deliberately NO plan/subscription check in this route: no
 * plan has ever carried a website cap, and the internal owner account
 * is unlimited by design.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  addBusinessWebsite,
  listBusinessWebsites,
  loadBusiness,
  reindexBusinessWebsite,
  removeBusinessWebsite,
} from "@/lib/business-websites";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

function serialize(w: Awaited<ReturnType<typeof listBusinessWebsites>>[number]) {
  return {
    id: w.id,
    url: w.url,
    host: w.host,
    status: w.status,
    statusReason: w.statusReason ?? null,
    pageCount: w.pageCount ?? null,
    entryCount: w.entryCount ?? null,
    addedAt: w.addedAt,
    lastIndexedAt: w.lastIndexedAt ?? null,
  };
}

async function tenantBusinessId(
  request: NextRequest,
  permission: "settings:read" | "settings:update"
) {
  const auth = await requireAuth(request, permission);
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "Websites belong to a business account." },
      { status: 400 }
    );
  }
  return auth.businessId;
}

export async function GET(request: NextRequest) {
  const businessId = await tenantBusinessId(request, "settings:read");
  if (businessId instanceof NextResponse) return businessId;
  try {
    const business = await loadBusiness(businessId);
    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }
    return NextResponse.json({
      websites: listBusinessWebsites(business).map(serialize),
    });
  } catch (err) {
    logger.error("[websites] GET failed:", err);
    return NextResponse.json(
      { error: "Couldn't load your websites. Please try again." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const businessId = await tenantBusinessId(request, "settings:update");
  if (businessId instanceof NextResponse) return businessId;

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`websites:${businessId}:${ip}`, {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many website updates. Please wait a while and try again." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const result = await addBusinessWebsite(businessId, body?.url);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ website: serialize(result.website) });
  } catch (err) {
    logger.error("[websites] POST failed:", err);
    return NextResponse.json(
      { error: "Couldn't add that website. Please try again." },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const businessId = await tenantBusinessId(request, "settings:update");
  if (businessId instanceof NextResponse) return businessId;

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkRateLimit(`websites:${businessId}:${ip}`, {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many website updates. Please wait a while and try again." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id) {
      return NextResponse.json({ error: "Missing website id." }, { status: 400 });
    }
    const result = await reindexBusinessWebsite(businessId, id);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ website: serialize(result.website) });
  } catch (err) {
    logger.error("[websites] PATCH failed:", err);
    return NextResponse.json(
      { error: "Couldn't re-check that website. Please try again." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const businessId = await tenantBusinessId(request, "settings:update");
  if (businessId instanceof NextResponse) return businessId;
  try {
    const id = request.nextUrl.searchParams.get("id") || "";
    if (!id) {
      return NextResponse.json({ error: "Missing website id." }, { status: 400 });
    }
    const { removed } = await removeBusinessWebsite(businessId, id);
    if (!removed) {
      return NextResponse.json(
        { error: "That website is no longer in your list." },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("[websites] DELETE failed:", err);
    return NextResponse.json(
      { error: "Couldn't remove that website. Please try again." },
      { status: 500 }
    );
  }
}
