/**
 * GET /api/agent-desk — Agent Desk status + version history.
 *
 * STAGED ONLY (agent booking batch, LEG G).
 * Returns, for THIS business only: the live version (if any), the
 * open draft (if any), the full version history (newest first,
 * capped), the live mirror (settings.agentBehavior), and drift.
 *
 * DRIFT, stated honestly: the live mirror and the live version can
 * disagree for exactly two reasons this API cannot distinguish —
 * (a) the owner edited behaviour directly in Settings (which still
 * goes live immediately, as it always has), or (b) a publish was
 * interrupted between marking the version LIVE and mirroring it.
 * The response says "mirror_differs" and nothing more specific;
 * it never invents a cause. A re-publish of the LIVE row repairs
 * case (b). No live version + non-empty mirror = "legacy" — the
 * pre-Agent Desk behaviour, not drift.
 *
 * Tenant scoping: requireAuth + runWithBusiness + an explicit
 * businessId filter on every query. A null businessId (Super Admin
 * without a selected business) answers 400, mirroring the settings
 * route — it never falls back to another business's desk.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  HISTORY_LIMIT,
  getLiveVersion,
  getOpenDraft,
  publicVersion,
  type AgentRuleVersion,
} from "@/lib/agent-desk";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "agent-desk:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }

    try {
      const rows = (await prisma.agentRuleVersion.findMany({
        where: { businessId: auth.businessId },
        orderBy: [{ versionNumber: "desc" }],
        take: HISTORY_LIMIT,
      })) as unknown as AgentRuleVersion[];

      const live = getLiveVersion(rows);
      const draft = getOpenDraft(rows);

      const settings = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });
      const mirror = ((settings as { agentBehavior?: unknown } | null)
        ?.agentBehavior as string) || "";

      let drift: "none" | "mirror_differs" | "legacy" = "none";
      if (!live && mirror) drift = "legacy";
      else if (live && live.plainText !== mirror) drift = "mirror_differs";

      return NextResponse.json({
        live: live ? publicVersion(live) : null,
        draft: draft ? publicVersion(draft) : null,
        history: rows.map(publicVersion),
        liveMirror: mirror,
        drift,
      });
    } catch (error) {
      logger.error("Failed to fetch agent desk status:", error);
      return NextResponse.json(
        { error: "Failed to fetch agent desk status" },
        { status: 500 }
      );
    }
  });
}
