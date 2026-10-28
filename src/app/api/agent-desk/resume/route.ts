/**
 * POST /api/agent-desk/resume — resume a paused LIVE Agent Desk rule.
 *
 * STAGED ONLY (owner controls, LEG D). Companion to
 * /api/agent-desk/pause; requires staged booking Leg G to have
 * landed first. It does NOT rewrite Leg G's publish/rollback paths
 * and it NEVER updates a version row: resuming flips the pause row
 * to "released" (never deleted, so the pause stays in history) and
 * re-mirrors the CURRENT LIVE row's text into settings.agentBehavior.
 *
 * BYTE-IDENTICAL RESTORE, BY CONSTRUCTION: the pause row never
 * carried a text copy, so there is nothing to copy back and nothing
 * that could drift. The restored text IS the LIVE row's plainText.
 * The route verifies the mirror after writing it (mirror ===
 * live.plainText); if verification fails it answers 500
 * resume_mirror_failed with pauseReleased:true and the repair path
 * (re-publish the LIVE row via Leg G's publish route) — the engine
 * gate is now unpaused but the mirror is stale-empty, which is the
 * safe default (no rule) rather than an invented rule, until the
 * repair lands. The pause is NOT re-activated on mirror failure:
 * silently re-pausing would hide the failure from the owner.
 *
 * REFUSALS (nothing changes): no LIVE row => 409 no_live_rule;
 * no active pause => 409 not_paused; pause pins a different version
 * than the current LIVE row => 409 pause_version_mismatch (a
 * rollback happened while paused; resume must not revive old text
 * under the new version's name).
 *
 * AUDIT: one ownerControlAudit entry (rule_resumed); see
 * @/lib/owner-controls/owner-control-audit for the Leg E
 * reconciliation flag. Audit failure is flagged (auditWritten)
 * rather than hidden, and never un-does the resume.
 *
 * Tenant scoping: requireAuth + runWithBusiness + explicit
 * businessId filter on every query. Null business => 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getLiveVersion, type AgentRuleVersion } from "@/lib/agent-desk";
import {
  resumeRule,
  type AgentRulePause,
} from "@/lib/owner-controls/rule-pause";
import {
  buildOwnerControlAuditEntry,
  ruleResumeAfter,
  ruleResumeBefore,
} from "@/lib/owner-controls/owner-control-audit";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "agent-desk:resume");
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
      if (!live) {
        return NextResponse.json(
          { error: "no_live_rule" },
          { status: 409 }
        );
      }

      const pauses = (await prisma.agentRulePause.findMany({
        where: { businessId: auth.businessId, status: "active" },
        take: 1,
      })) as unknown as AgentRulePause[];
      const pauseRow = pauses.length > 0 ? pauses[0] : null;

      const nowIso = new Date().toISOString();
      const decision = resumeRule({
        live: {
          id: live.id,
          businessId: live.businessId,
          versionNumber: live.versionNumber,
          status: live.status,
          plainText: live.plainText,
        },
        pauseRow,
        authBusinessId: auth.businessId,
        actorId: auth.userId,
        nowIso,
      });
      if (!decision.ok) {
        return NextResponse.json(
          { error: decision.reason },
          { status: 409 }
        );
      }

      await prisma.agentRulePause.update({
        where: { id: pauseRow!.id, businessId: auth.businessId },
        data: {
          status: "released",
          releasedAt: nowIso,
          releasedBy: auth.userId,
        },
      });

      // Re-mirror exactly the LIVE row's text, then verify it.
      try {
        await prisma.settings.upsert({
          where: { businessId: auth.businessId },
          update: { agentBehavior: live.plainText },
          create: withBusinessId({ agentBehavior: live.plainText }),
        });
      } catch (mirrorError) {
        logger.error("Agent desk resume mirror failed:", mirrorError);
        return NextResponse.json(
          {
            error: "resume_mirror_failed",
            pauseReleased: true,
            repair: "re-publish the LIVE row via /api/agent-desk/publish",
          },
          { status: 500 }
        );
      }
      const settings = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });
      const mirror = ((settings as { agentBehavior?: unknown } | null)
        ?.agentBehavior as string) || "";
      if (mirror !== live.plainText) {
        return NextResponse.json(
          {
            error: "resume_mirror_failed",
            pauseReleased: true,
            repair: "re-publish the LIVE row via /api/agent-desk/publish",
          },
          { status: 500 }
        );
      }

      let auditWritten = false;
      const audit = buildOwnerControlAuditEntry({
        businessId: auth.businessId,
        objectType: "agent_rule",
        objectId: live.id,
        objectKey: `v${live.versionNumber}`,
        action: "rule_resumed",
        actorId: auth.userId,
        actorName: auth.name,
        occurredAt: nowIso,
        beforeSummary: ruleResumeBefore(live.versionNumber),
        afterSummary: ruleResumeAfter(live.versionNumber),
        detail: "mirrored=true",
      });
      if (audit.ok) {
        try {
          await prisma.ownerControlAudit.create({
            data: withBusinessId({ ...audit.entry }),
          });
          auditWritten = true;
        } catch (auditError) {
          logger.error("Agent desk resume audit write failed:", auditError);
        }
      }

      return NextResponse.json({
        resumed: true,
        restoredVersionNumber: decision.restoredVersionNumber,
        // True by construction (no text copy ever existed) AND
        // verified above against the live mirror.
        restoredByteIdentical: decision.restoredText === live.plainText,
        mirrored: true,
        auditWritten,
      });
    } catch (error) {
      logger.error("Failed to resume agent desk rule:", error);
      return NextResponse.json(
        { error: "Failed to resume rule" },
        { status: 500 }
      );
    }
  });
}
