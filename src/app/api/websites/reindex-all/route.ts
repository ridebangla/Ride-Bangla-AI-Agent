/**
 * POST /api/websites/reindex-all — scheduled re-index sweep (full-site
 * scraper, owner order 2026-11-02).
 *
 * Re-indexes every listed website whose last index attempt is older
 * than the threshold (default 24h), each in its own stored crawl mode
 * (full-site sites stay full-site, legacy sites stay legacy). This is
 * the second half of "automatic pickup": the full-site crawler alone
 * still leaves pickup manual; this sweep is what re-reads changed
 * sites without anyone clicking re-index.
 *
 * Auth: platform-wide, mirroring POST /api/followups/process — a
 * scheduler holding CRON_SECRET (`Authorization: Bearer <secret>`) OR
 * a platform Super Admin session (businessId null). There is no
 * in-repo clock and no vercel.json in this project: like the other
 * cron endpoints, an external scheduler must POST to this route
 * (daily is the recommended cadence; the per-run site cap bounds
 * each run). Body (all optional): { olderThanHours, limit }.
 *
 * Safety: one site's failure never aborts the sweep; per-run site
 * cap (default 20) bounds runtime; re-index replaces exactly that
 * site's `sourceWebsiteId`-tagged entries, never other businesses'
 * entries or static seed categories.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { reindexStaleWebsites } from "@/lib/business-websites";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_OLDER_THAN_HOURS = 24;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") || "";
  let allowed = false;

  if (secret && header === `Bearer ${secret}`) {
    allowed = true;
  } else {
    const auth = await requireAuth(request);
    if (isAuthenticated(auth) && auth.businessId === null) {
      allowed = true; // Super Admin
    } else if (!isAuthenticated(auth)) {
      return auth; // 401/403 response
    }
  }

  if (!allowed) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "Only the platform Super Admin or the scheduler may run this.",
      },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const olderThanHours =
      typeof body?.olderThanHours === "number" &&
      Number.isFinite(body.olderThanHours) &&
      body.olderThanHours > 0
        ? body.olderThanHours
        : DEFAULT_OLDER_THAN_HOURS;
    const limit =
      typeof body?.limit === "number" &&
      Number.isFinite(body.limit) &&
      body.limit > 0
        ? Math.min(Math.floor(body.limit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const summary = await reindexStaleWebsites({
      olderThanMs: olderThanHours * 60 * 60 * 1000,
      limit,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    logger.error("[websites] reindex-all failed:", err);
    return NextResponse.json(
      { error: "Couldn't run the scheduled re-index." },
      { status: 500 }
    );
  }
}
