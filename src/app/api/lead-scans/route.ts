import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

/**
 * Lead discovery scans.
 *
 * POST creates a scan REQUEST (status 'requested'). The Harvey sidecar —
 * a separate service with the tenant's mailbox + AI backend credentials —
 * picks up requested scans, runs discover → profile → scout, and writes
 * back leads. The web app never scans anything itself: without the
 * sidecar + credentials, a scan honestly stays 'requested'.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "leads:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const [scans, total] = await Promise.all([
        prisma.leadScan.findMany({ orderBy: { createdAt: "desc" }, skip, take }),
        prisma.leadScan.count({}),
      ]);
      return NextResponse.json(paginatedResponse(scans, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch lead scans:", error);
      return NextResponse.json({ error: "Failed to fetch lead scans" }, { status: 500 });
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "leads:write");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 120)
          : `Scan ${new Date().toISOString().slice(0, 10)}`;

      // Snapshot the tenant's current ICP into the scan so later ICP edits
      // don't rewrite history.
      const settings = await prisma.leadSettings.findFirst({});
      const scan = await prisma.leadScan.create({
        data: {
          name,
          icp: settings?.icp ?? {},
          status: "requested",
          requestedAt: new Date(),
        } as never,
      });
      return NextResponse.json(scan, { status: 201 });
    } catch (error) {
      logger.error("Failed to request lead scan:", error);
      return NextResponse.json({ error: "Failed to request lead scan" }, { status: 500 });
    }
  });
}
