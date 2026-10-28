/**
 * /api/customers/[id]/timeline — one customer's timeline for THIS business.
 *
 * Assembled ONLY from records the repo already keeps (see
 * buildCustomerTimeline in src/lib/inbound-leads.ts for the per-source
 * rules and the stated gaps):
 * - orders, ratings (conversation.satisfaction), customer + internal
 *   notes (including transfer notes), handoff records, conversation
 *   starts, photo/video markers, voice-note markers.
 * NOT invented here: card-view events (no such record exists) and
 * voice-origin labelling of transcripts (transcripts are stored as
 * ordinary customer text with no origin flag).
 *
 * Tenant rule: Super Admin (businessId null) gets 403 — same fail-closed
 * choice as /api/inbound-leads (tenant data is not served unscoped).
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { buildTimelineForCustomer } from "@/lib/inbound-leads-store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request, "customers:read");
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "Tenant data requires a business context." },
      { status: 403 },
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { id } = await params;
      const timeline = await buildTimelineForCustomer(id);
      if (!timeline) {
        return NextResponse.json(
          { error: "Customer not found" },
          { status: 404 },
        );
      }
      return NextResponse.json(timeline);
    } catch (error) {
      logger.error("Failed to fetch customer timeline:", error);
      return NextResponse.json(
        { error: "Failed to fetch customer timeline" },
        { status: 500 },
      );
    }
  });
}
