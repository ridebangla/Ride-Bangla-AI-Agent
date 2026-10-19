import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

/**
 * Outreach drafts — the human approval gate.
 *
 * Drafts are written by the Harvey sidecar (writer pass). A human flips a
 * draft draft -> approved / rejected here. There is NO send endpoint in the
 * web app by design: only the sidecar sends, and only drafts whose status
 * is 'approved' AND whose deterministic gate passes at send time.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "leads:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const status = searchParams.get("status");
      const where: Record<string, unknown> = {};
      if (status && ["draft", "approved", "rejected", "sent", "failed"].includes(status)) {
        where.status = status;
      }
      const [drafts, total] = await Promise.all([
        prisma.leadDraft.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
        prisma.leadDraft.count({ where }),
      ]);
      return NextResponse.json(paginatedResponse(drafts, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch lead drafts:", error);
      return NextResponse.json({ error: "Failed to fetch lead drafts" }, { status: 500 });
    }
  });
}
