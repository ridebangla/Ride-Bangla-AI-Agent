/**
 * POST /api/agent-desk/rollback — one-click rollback to the last
 * live version.
 *
 * STAGED ONLY (agent booking batch, LEG G).
 *
 * ONE CLICK, NO VERSION PICKER: the body may be empty. The target
 * is always the most recent SUPERSEDED version below the current
 * LIVE version — the rule customers heard before the current one.
 * There is nothing to choose and nothing else to approve: the
 * click itself, by an admin (agent-desk:rollback), IS the
 * approval, because the restored text is a rule the owner already
 * approved once when it first went live. A rollback to brand-new
 * untested text is impossible by construction — that path is
 * draft → preview → publish, with its own approval flag.
 *
 * APPEND-ONLY, REVERSIBLE: rollback creates a NEW LIVE row
 * copying the target's text (origin "rollback", restoresVersion
 * set), demotes the current LIVE row to SUPERSEDED, and mirrors
 * the restored text into settings.agentBehavior. The target row
 * itself is untouched, and the version just rolled back from
 * stays in history — so rolling forward again is draft-from-
 * history → publish, or a second rollback if it qualifies.
 * Nothing is deleted, nothing is edited in place.
 *
 * NOTHING TO ROLL BACK TO (first-ever live version, or no live
 * version) → 409 nothing_to_rollback, nothing changes.
 *
 * Tenant scoping: all rows are read under this business's
 * runWithBusiness context with an explicit businessId filter.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  getLiveVersion,
  getRollbackTarget,
  nextVersionNumber,
  publicVersion,
  type AgentRuleVersion,
} from "@/lib/agent-desk";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "agent-desk:rollback");
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
      })) as unknown as AgentRuleVersion[];

      const live = getLiveVersion(rows);
      const target = getRollbackTarget(rows, live);
      if (!live || !target) {
        return NextResponse.json(
          { error: "nothing_to_rollback" },
          { status: 409 }
        );
      }

      const now = new Date();
      const created = (await prisma.agentRuleVersion.create({
        data: withBusinessId({
          versionNumber: nextVersionNumber(
            rows.map((r) => r.versionNumber)
          ),
          status: "LIVE",
          plainText: target.plainText,
          // No invented note: a rollback row's changeNote stays
          // empty; the history UI shows it as a rollback of the
          // version number it restores (restoresVersion).
          changeNote: "",
          createdBy: auth.userId,
          createdByName: auth.name,
          publishedAt: now,
          publishedBy: auth.userId,
          origin: "rollback",
          restoresVersion: target.versionNumber,
        }),
      })) as unknown as AgentRuleVersion;

      await prisma.agentRuleVersion.update({
        where: { id: live.id, businessId: auth.businessId },
        data: { status: "SUPERSEDED" },
      });

      try {
        await prisma.settings.upsert({
          where: { businessId: auth.businessId },
          update: { agentBehavior: target.plainText },
          create: withBusinessId({ agentBehavior: target.plainText }),
        });
      } catch (mirrorError) {
        logger.error("Agent desk rollback mirror failed:", mirrorError);
        return NextResponse.json(
          {
            error: "rollback_mirror_failed",
            live: publicVersion(created),
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        live: publicVersion(created),
        restoredVersion: target.versionNumber,
        previousLiveVersion: live.versionNumber,
        mirrored: true,
      });
    } catch (error) {
      logger.error("Failed to roll back agent desk version:", error);
      return NextResponse.json(
        { error: "Failed to roll back" },
        { status: 500 }
      );
    }
  });
}
