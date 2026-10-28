/**
 * /api/advance-config — LEG C (staged): tenant advance configuration.
 *
 * GET — read this tenant's advance config (null when unconfigured).
 *       Permission: settings:read.
 * PUT — replace this tenant's advance config. Every value is
 *       tenant-supplied and validated by `validateAdvanceConfig`
 *       (src/lib/advance-payments.ts); an invalid config writes
 *       nothing. Permission: settings:update (admin-only, existing
 *       permission — no new permission is introduced for config).
 *
 * Dashboard settings UI form for this config is remaining work (the
 * API is staged so the flow is testable without it). Until the tenant
 * saves a config here, the advance flow is OFF for their business:
 * the agent states no payment number and no advance amount.
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;
  const businessId = auth.businessId;
  if (!businessId) {
    return NextResponse.json({ error: "Business context required" }, { status: 403 });
  }

  return runWithBusiness(businessId, async () => {
    try {
      const { getAdvanceConfig } = await import("@/lib/advance-payments");
      const config = await getAdvanceConfig(businessId);
      return NextResponse.json({ config });
    } catch (error) {
      logger.error("Failed to fetch advance config:", error);
      return NextResponse.json({ error: "Failed to fetch advance config" }, { status: 500 });
    }
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  const businessId = auth.businessId;
  if (!businessId) {
    return NextResponse.json({ error: "Business context required" }, { status: 403 });
  }

  return runWithBusiness(businessId, async () => {
    try {
      const body = await request.json();
      const { setAdvanceConfig } = await import("@/lib/advance-payments");
      const config = await setAdvanceConfig(businessId, body);
      return NextResponse.json({ config });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid advance config";
      logger.error("Failed to save advance config:", error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}
