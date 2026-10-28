/**
 * /api/inbound-leads — INBOUND leads only (customers of THIS business who
 * showed buying/booking interest). Deliberately separate from
 * /api/leads, which serves the OUTBOUND Harvey Lead Engine (`leads`
 * collection). This route serves the `inboundLeads` collection and never
 * reads or writes `prisma.lead`.
 *
 * GET    ?view=pipeline|list|today&search=&stage=&assignedToId=&format=json|csv
 *        view=today also accepts ?date=YYYY-MM-DD (UTC; defaults to today).
 *        format=csv needs inbound-leads:export; otherwise inbound-leads:read.
 * POST   manual lead creation (source is forced to "manual" — the agent
 *        path is the create_inbound_lead tool, never this route).
 * PATCH  { id, stage?, note?, followUpDate?, interest?, name?, phone?,
 *          assignedToId? } — assigning needs inbound-leads:assign.
 *
 * Tenant rule (mirrors the bulk-import route's precedent): a Super Admin
 * (businessId null) gets 403 here — tenant lead data is not served
 * unscoped; the Admin Console is the super-admin surface, not this route.
 * No fare or price is ever quoted or computed by this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { hasPermission } from "@/lib/rbac";
import {
  toInboundLeadsCSV,
  isInboundLeadStage,
} from "@/lib/inbound-leads";
import {
  createOrMergeInboundLead,
  listInboundLeads,
  todayInboundLeads,
  updateInboundLeadStage,
  updateInboundLeadDetails,
  assignInboundLead,
} from "@/lib/inbound-leads-store";

function todayYmdUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") || "json";
  const auth = await requireAuth(
    request,
    format === "csv" ? "inbound-leads:export" : "inbound-leads:read",
  );
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "Tenant data requires a business context." },
      { status: 403 },
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const view = searchParams.get("view") || "list";
      const search = searchParams.get("search") || undefined;
      const stage = searchParams.get("stage") || undefined;
      const assignedToId = searchParams.get("assignedToId") || undefined;

      if (view === "today") {
        const date = searchParams.get("date") || todayYmdUtc();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return NextResponse.json(
            { error: "date must be in YYYY-MM-DD form." },
            { status: 400 },
          );
        }
        const lists = await todayInboundLeads(date);
        return NextResponse.json({ date, ...lists });
      }

      const { page, limit, skip, take } = parsePagination(searchParams);
      const leads = await listInboundLeads({ search, stage, assignedToId });
      if (format === "csv") {
        const csv = toInboundLeadsCSV(leads);
        return new NextResponse(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="inbound-leads-${todayYmdUtc()}.csv"`,
          },
        });
      }
      return NextResponse.json(
        paginatedResponse(leads.slice(skip, skip + take), leads.length, page, limit),
      );
    } catch (error) {
      logger.error("Failed to fetch inbound leads:", error);
      return NextResponse.json(
        { error: "Failed to fetch inbound leads" },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "inbound-leads:write");
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "Tenant data requires a business context." },
      { status: 403 },
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const { name, phone, interest, note, followUpDate, channel, customerId } =
        body ?? {};
      // Source is forced: a dashboard/manual creation is never recorded
      // as agent-created, so the source field stays honest.
      const result = await createOrMergeInboundLead({
        name,
        phone,
        interest,
        note,
        followUpDate,
        source: "manual",
        channel,
        customerId,
      });
      if (result.refused) {
        return NextResponse.json(
          { error: "A lead needs at least a name, a phone number, or what the customer wants." },
          { status: 400 },
        );
      }
      return NextResponse.json(
        { lead: result.lead, merged: result.merged },
        { status: result.merged ? 200 : 201 },
      );
    } catch (error) {
      logger.error("Failed to create inbound lead:", error);
      const message =
        error instanceof Error ? error.message : "Failed to create inbound lead";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request, "inbound-leads:write");
  if (!isAuthenticated(auth)) return auth;
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "Tenant data requires a business context." },
      { status: 403 },
    );
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const { id } = body ?? {};
      if (!id || typeof id !== "string") {
        return NextResponse.json(
          { error: "Lead id is required" },
          { status: 400 },
        );
      }
      // Assigning is a separate, narrower permission than editing.
      if (body.assignedToId !== undefined) {
        if (!hasPermission(auth.role, "inbound-leads:assign")) {
          return NextResponse.json(
            { error: "Assigning leads requires a supervisor or admin role." },
            { status: 403 },
          );
        }
        const lead = await assignInboundLead(
          id,
          body.assignedToId === null ? null : String(body.assignedToId),
          auth.businessId as string,
        );
        return NextResponse.json({ lead });
      }
      if (body.stage !== undefined) {
        if (!isInboundLeadStage(body.stage)) {
          return NextResponse.json(
            { error: "Invalid stage" },
            { status: 400 },
          );
        }
        const lead = await updateInboundLeadStage(id, body.stage);
        return NextResponse.json({ lead });
      }
      const lead = await updateInboundLeadDetails(id, {
        note: body.note,
        followUpDate: body.followUpDate,
        interest: body.interest,
        name: body.name,
        phone: body.phone,
      }, todayYmdUtc());
      return NextResponse.json({ lead });
    } catch (error) {
      logger.error("Failed to update inbound lead:", error);
      const message =
        error instanceof Error ? error.message : "Failed to update inbound lead";
      const status = /not found/i.test(message) ? 404 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  });
}
