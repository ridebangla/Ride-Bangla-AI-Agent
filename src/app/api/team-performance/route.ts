/**
 * LEG K — GET /api/team-performance (STAGED ONLY).
 *
 * Per-member team performance for one tenant, read-only aggregation
 * over existing messages / conversations / tickets / orders. No new
 * collection, no new Firestore rules block, no writes, no quota or
 * metering change, no money figure (orders are counts only).
 *
 * Role gating — EXISTING RBAC only, no new role, no new permission:
 * `activity:read` is [supervisor, admin] at HEAD (super_admin passes
 * via hasPermission). agent / viewer callers therefore get the
 * requireAuth 403, not a redacted payload — the payload IS the
 * per-member data, so there is nothing safe to redact it down to
 * without duplicating Leg H analytics. A null-businessId Super
 * Admin gets 403 (fail-closed, same rule as Leg H analytics):
 * performance is per-tenant roster data and cannot be scoped
 * without a business.
 *
 * Query: ?windowDays=7|14|30 (default 30). Anything else → 400.
 * Every number in the response is labelled by the pure module's
 * attribution rules (see src/lib/team-performance.ts): team replies
 * are a delivery-note heuristic, per-member message/response figures
 * cover sole-link conversations only, and unattributed team work is
 * returned whole in `unattributedTeam`, never split by guesswork.
 * There is deliberately no fifth stat column of any kind here.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  computeTeamPerformance,
  gateTeamPerformanceForRole,
} from "@/lib/team-performance";

const WINDOW_DAYS = new Set([7, 14, 30]);

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "activity:read");
  if (!isAuthenticated(auth)) return auth;
  if (gateTeamPerformanceForRole(auth.role) !== "full") {
    return NextResponse.json(
      { error: "Team performance is visible to supervisors and admins only" },
      { status: 403 },
    );
  }
  if (auth.businessId === null) {
    return NextResponse.json(
      { error: "Team performance requires a business scope" },
      { status: 403 },
    );
  }

  const windowRaw = new URL(request.url).searchParams.get("windowDays");
  const windowDays = windowRaw === null ? 30 : Number(windowRaw);
  if (!WINDOW_DAYS.has(windowDays)) {
    return NextResponse.json(
      { error: "windowDays must be 7, 14, or 30" },
      { status: 400 },
    );
  }
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  return runWithBusiness(auth.businessId, async () => {
    try {
      const [members, tickets, messages, conversations, orders] =
        await Promise.all([
          prisma.teamMember.findMany({
            orderBy: { name: "asc" },
            include: { department: { select: { name: true } } },
          }),
          prisma.ticket.findMany({
            select: { conversationId: true, assignedToId: true },
          }),
          prisma.message.findMany({
            where: { createdAt: { gte: windowStart } },
            select: {
              id: true,
              conversationId: true,
              role: true,
              deliveryNote: true,
              createdAt: true,
            },
          }),
          // Full rows, NOT a select: takenOverBy / takenOverByName
          // exist only if Presswayy Leg D's staged takeover diff has
          // landed. Reading them defensively off the full document
          // keeps this route working before that landing (fields
          // simply absent) instead of failing on an unknown select.
          prisma.conversation.findMany({}),
          prisma.order.findMany({
            where: { createdAt: { gte: windowStart } },
            select: { id: true, conversationId: true, createdAt: true },
          }),
        ]);

      const result = computeTeamPerformance({
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
          departmentName: m.department?.name ?? null,
        })),
        messages: messages.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          deliveryNote: m.deliveryNote ?? null,
          createdAt: m.createdAt,
        })),
        conversations: conversations.map((c) => ({
          id: c.id,
          takenOverBy: (c as { takenOverBy?: string | null }).takenOverBy ?? null,
          takenOverByName:
            (c as { takenOverByName?: string | null }).takenOverByName ?? null,
        })),
        tickets: tickets.map((t) => ({
          conversationId: t.conversationId,
          assignedToId: t.assignedToId,
        })),
        orders: orders.map((o) => ({
          id: o.id,
          conversationId: o.conversationId,
          createdAt: o.createdAt,
        })),
        windowStart,
      });

      return NextResponse.json({ windowDays, ...result });
    } catch {
      return NextResponse.json(
        { error: "Failed to load team performance" },
        { status: 500 },
      );
    }
  });
}
