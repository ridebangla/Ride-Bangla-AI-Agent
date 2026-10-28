/**
 * /api/analytics/inbound-leads — the business's OWN record counts for a
 * 7/14/30-day window (?window=7|14|30, default 7). Handoff reasons are
 * always the last 30 days, per the brief, regardless of ?window.
 *
 * Counts only — never platform reach, follower counts, or social
 * audience data (nothing here reads the social audience models).
 *
 * Role gating (gateAnalyticsForRole in src/lib/inbound-leads.ts):
 * - admin / super_admin: everything.
 * - supervisor: everything except waiting-chat customer names.
 * - agent: business totals + ONLY their own lead counts (matched by
 *   assignedToName === the caller's name — the repo has no
 *   dashboard-user ↔ team-member link; that limitation is stated in
 *   the leg report, not hidden).
 * - viewer / other: totals only.
 *
 * Tenant rule: Super Admin (businessId null) gets 403 — same fail-closed
 * choice as /api/inbound-leads (tenant data is not served unscoped).
 * Team-vs-AI reply split uses the deliveryNote heuristic documented in
 * isTeamReplyMessage; the report flags its durable fix as follow-up.
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { gateAnalyticsForRole } from "@/lib/inbound-leads";
import { computeInboundAnalyticsForBusiness } from "@/lib/inbound-leads-store";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "analytics:read");
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "Tenant data requires a business context." },
      { status: 403 },
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const windowParam = request.nextUrl.searchParams.get("window") || "7";
      const windowDays = Number(windowParam);
      if (![7, 14, 30].includes(windowDays)) {
        return NextResponse.json(
          { error: "window must be 7, 14 or 30." },
          { status: 400 },
        );
      }
      const full = await computeInboundAnalyticsForBusiness(windowDays);
      const gated = gateAnalyticsForRole(auth.role, auth.name, full);
      return NextResponse.json(gated);
    } catch (error) {
      logger.error("Failed to fetch inbound analytics:", error);
      return NextResponse.json(
        { error: "Failed to fetch inbound analytics" },
        { status: 500 },
      );
    }
  });
}
