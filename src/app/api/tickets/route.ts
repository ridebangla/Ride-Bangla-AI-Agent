import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness, getUnscopedPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { ticketReference } from "@/lib/ai/behaviour";

/**
 * POST /api/tickets — dashboard ticket creation (TEAM B ticket fix).
 *
 * Doctrine (owner): this route is an EXPLICIT human action only — a
 * dashboard team member creating a ticket. It is never invoked by AI
 * code and never auto-creates on an unknown answer, error, or
 * feedback. Every ticket created here must carry, like every other
 * intake: (1) a short readable recording number (SITE-XXXXXXXX via
 * ticketReference — never a raw UUID shown to the customer), (2)
 * source attribution (sourceChannel, default "dashboard", plus an
 * optional sourceWebsite), and (3) the full message/detail in
 * title + description. The reference is id-derived, so it is
 * computed AFTER create and stored by a best-effort follow-up
 * update — the same pattern as POST /api/public/tickets and the
 * chat handoff path. A failed reference store is logged, never
 * fatal: the computed reference is still returned, and it is
 * deterministic from the ticket id, so a later read backfills it.
 *
 * Vocabulary is validated (priority low/medium/high/urgent, status
 * open/in_progress/resolved/closed — the dashboard's own lists);
 * previously any string was accepted and stored verbatim.
 */

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { searchParams } = new URL(request.url);
      const { page, limit, skip, take } = parsePagination(searchParams);
      const status = searchParams.get("status");
      const priority = searchParams.get("priority");
      const departmentId = searchParams.get("departmentId");
      const search = searchParams.get("search");

      const where: Record<string, unknown> = {};

      if (status && status !== "all") {
        where.status = status;
      }

      if (priority && priority !== "all") {
        where.priority = priority;
      }

      if (departmentId && departmentId !== "all") {
        where.departmentId = departmentId;
      }

      if (search && search.trim()) {
        const q = search.trim();
        where.OR = [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
          // Recording numbers are how customers quote tickets back to
          // the team — the queue must be searchable by them, not only
          // by title/description text.
          { reference: { contains: q, mode: "insensitive" } },
        ];
      }

      const [tickets, total] = await Promise.all([
        prisma.ticket.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take,
          include: {
            conversation: {
              select: {
                id: true,
                customerName: true,
                channel: true,
                status: true,
              },
            },
            department: {
              select: {
                id: true,
                name: true,
              },
            },
            assignedTo: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        }),
        prisma.ticket.count({ where }),
      ]);

      return NextResponse.json(paginatedResponse(tickets, total, page, limit));
    } catch (error) {
      logger.error("Failed to fetch tickets:", error);
      return NextResponse.json(
        { error: "Failed to fetch tickets" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "tickets:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const body = await request.json();
      const {
        title,
        description,
        priority,
        status,
        conversationId,
        departmentId,
        assignedToId,
        sourceWebsite,
        sourceChannel,
        visitorName,
        visitorContact,
        pageUrl,
      } = body;

      if (!title || typeof title !== "string" || title.trim().length === 0) {
        return NextResponse.json(
          { error: "Ticket title is required" },
          { status: 400 }
        );
      }
      // Dashboard vocabulary only — previously any string passed
      // through into the queue and the dashboard filters.
      const PRIORITIES = ["low", "medium", "high", "urgent"];
      const STATUSES = ["open", "in_progress", "resolved", "closed"];
      const safePriority =
        typeof priority === "string" && PRIORITIES.includes(priority)
          ? priority
          : "medium";
      const safeStatus =
        typeof status === "string" && STATUSES.includes(status)
          ? status
          : "open";
      const cleanStr = (v: unknown, max: number): string | undefined => {
        if (typeof v !== "string") return undefined;
        const t = v.trim().slice(0, max);
        return t === "" ? undefined : t;
      };

      const ticket = await prisma.ticket.create({
        data: {
          title: title.trim(),
          description: description?.trim() || "",
          priority: safePriority,
          status: safeStatus,
          ...(conversationId && { conversationId }),
          ...(departmentId && { departmentId }),
          ...(assignedToId && { assignedToId }),
          // Source attribution (doctrine rule 5): the dashboard is
          // the intake channel unless the caller says otherwise; the
          // source team is the assigned department (departmentId).
          sourceChannel: cleanStr(sourceChannel, 80) ?? "dashboard",
          ...(cleanStr(sourceWebsite, 500) && {
            sourceWebsite: cleanStr(sourceWebsite, 500),
          }),
          ...(cleanStr(visitorName, 100) && {
            visitorName: cleanStr(visitorName, 100),
          }),
          ...(cleanStr(visitorContact, 120) && {
            visitorContact: cleanStr(visitorContact, 120),
          }),
          ...(cleanStr(pageUrl, 500) && { pageUrl: cleanStr(pageUrl, 500) }),
        },
        include: {
          conversation: {
            select: {
              id: true,
              customerName: true,
              channel: true,
              status: true,
            },
          },
          department: {
            select: { id: true, name: true },
          },
          assignedTo: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      // Recording number (id-derived, stored-only — same scheme as
      // the chat handoff and public-form paths). Business slug/name
      // lookup is best-effort: without it the fallback is "RB", and
      // the reference is still short, unique, and human-readable.
      let reference: string | null = null;
      try {
        const biz = auth.businessId
          ? ((await getUnscopedPrisma().business.findUnique({
              where: { id: auth.businessId },
              select: { slug: true, name: true },
            })) as { slug?: unknown; name?: unknown } | null)
          : null;
        const slugOrName =
          (typeof biz?.slug === "string" && biz.slug) ||
          (typeof biz?.name === "string" && biz.name) ||
          null;
        reference = ticketReference(slugOrName, ticket.id);
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { reference },
        });
      } catch (err) {
        // Best-effort, mirroring /api/public/tickets: the reference
        // is deterministic from the ticket id, so the caller still
        // receives the correct recording number below, and a later
        // reuse backfills the stored field. The ticket itself is
        // already created — never fail it here.
        if (!reference) {
          reference = ticketReference(null, ticket.id);
        }
        logger.warn("[tickets] reference store failed:", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return NextResponse.json({ ...ticket, reference }, { status: 201 });
    } catch (error) {
      logger.error("Failed to create ticket:", error);
      return NextResponse.json(
        { error: "Failed to create ticket" },
        { status: 500 }
      );
    }

  });
}
