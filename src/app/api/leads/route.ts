import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

const STATUSES = ["new", "contacted", "replied", "meeting", "closed", "lost"];

/** List the tenant's leads (written by the Harvey sidecar). */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "leads:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const status = searchParams.get("status");
      const minScore = Number(searchParams.get("minScore") || 0);

      const where: Record<string, unknown> = {};
      if (status && STATUSES.includes(status)) where.status = status;

      // The Firestore shim prefilters businessId server-side; score/status
      // filters apply in memory (documented shim behavior).
      const all = await prisma.lead.findMany({
        where,
        orderBy: { icpScore: "desc" },
      });
      const filtered = all.filter(
        (l) => ((l as unknown as Record<string, unknown>).icpScore as number ?? 0) >= minScore
      );
      const total = filtered.length;
      return NextResponse.json(
        paginatedResponse(filtered.slice(skip, skip + take), total, page, limit)
      );
    } catch (error) {
      logger.error("Failed to fetch leads:", error);
      return NextResponse.json({ error: "Failed to fetch leads" }, { status: 500 });
    }
  });
}

/** Update a lead's pipeline status (human triage). */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request, "leads:write");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const { id, status } = body;
      if (!id || typeof id !== "string") {
        return NextResponse.json({ error: "Lead id is required" }, { status: 400 });
      }
      if (!STATUSES.includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      const lead = await prisma.lead.update({
        where: { id },
        data: { status } as never,
      });
      return NextResponse.json(lead);
    } catch (error) {
      logger.error("Failed to update lead:", error);
      return NextResponse.json({ error: "Failed to update lead" }, { status: 500 });
    }
  });
}
