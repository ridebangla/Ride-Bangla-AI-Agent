/**
 * POST /api/agent-desk/pause — pause the current LIVE Agent Desk rule.
 *
 * STAGED ONLY (owner controls, LEG D). Requires staged booking Leg G
 * (Agent Desk) to have landed first: it reads Leg G's version rows
 * and mirrors into the same settings.agentBehavior slot Leg G's
 * publish uses. It does NOT rewrite Leg G's publish/rollback paths
 * and it NEVER updates a version row: pausing writes one new
 * agentRulePause row and nothing else to version history.
 *
 * EFFECT (two layers, gate first):
 * 1. ENGINE GATE (primary, snippet SNIP-1): while an active pause
 *    row exists, getAIConfig returns agentBehavior "" — the agent
 *    gets NO behaviour rule, never a fallback, never an invention.
 * 2. MIRROR CLEAR (defence-in-depth): settings.agentBehavior is
 *    cleared to "" so even an engine without the gate yet reads no
 *    rule. If the mirror clear fails, the pause is STILL effective
 *    via the gate, and the response says mirrored:false honestly
 *    instead of failing a pause that already took effect.
 *
 * IDEMPOTENCE / DRIFT: a second pause of the same LIVE row answers
 * 409 already_paused (no duplicate pause row). An active pause
 * pinning a DIFFERENT version than the current LIVE row answers
 * 409 pause_version_mismatch — a rollback happened while paused,
 * and silently replacing the pause would revive the wrong rule.
 * No LIVE row => 409 no_live_rule. Foreign business => 404
 * semantics via the businessId filter (no row found under this
 * business = nothing to pause; the route answers 409 no_live_rule
 * for its own business and never reveals another business's rows).
 *
 * AUDIT: one ownerControlAudit entry (rule_paused) is written via
 * the builder in @/lib/owner-controls/owner-control-audit — see
 * that module's header for the Leg E reconciliation flag. If the
 * audit write itself fails, the pause still stands (the gate must
 * not depend on the audit), but the response flags
 * auditWritten:false instead of hiding the gap.
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
  pauseRule,
  validatePauseReason,
  type AgentRulePause,
} from "@/lib/owner-controls/rule-pause";
import {
  buildOwnerControlAuditEntry,
  rulePauseAfter,
  rulePauseBefore,
} from "@/lib/owner-controls/owner-control-audit";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "agent-desk:pause");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }

    try {
      const body = await request.json().catch(() => ({}));
      const reason = body?.reason ?? "";
      if (!validatePauseReason(reason)) {
        return NextResponse.json(
          { error: "Pause reason is too long" },
          { status: 400 }
        );
      }

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
      const existingPause = pauses.length > 0 ? pauses[0] : null;
      if (existingPause) {
        if (existingPause.versionId !== live.id) {
          return NextResponse.json(
            { error: "pause_version_mismatch" },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: "already_paused" },
          { status: 409 }
        );
      }

      const nowIso = new Date().toISOString();
      const decision = pauseRule({
        live: {
          id: live.id,
          businessId: live.businessId,
          versionNumber: live.versionNumber,
          status: live.status,
          plainText: live.plainText,
        },
        existingPause,
        authBusinessId: auth.businessId,
        actorId: auth.userId,
        actorName: auth.name,
        reason,
        nowIso,
        newId: "",
      });
      if (!decision.ok) {
        return NextResponse.json(
          { error: decision.reason },
          { status: 409 }
        );
      }

      // The delegate assigns the id on create; the pure decision's
      // placeholder id is never persisted.
      const created = (await prisma.agentRulePause.create({
        data: withBusinessId({
          versionId: decision.pauseRow.versionId,
          versionNumber: decision.pauseRow.versionNumber,
          status: "active",
          pausedAt: nowIso,
          pausedBy: auth.userId,
          pausedByName: auth.name,
          reason,
          releasedAt: null,
          releasedBy: null,
        }),
      })) as unknown as AgentRulePause;

      // Defence-in-depth mirror clear (gate is primary, see header).
      let mirrored = false;
      try {
        await prisma.settings.upsert({
          where: { businessId: auth.businessId },
          update: { agentBehavior: "" },
          create: withBusinessId({ agentBehavior: "" }),
        });
        mirrored = true;
      } catch (mirrorError) {
        logger.error("Agent desk pause mirror clear failed:", mirrorError);
      }

      let auditWritten = false;
      const audit = buildOwnerControlAuditEntry({
        businessId: auth.businessId,
        objectType: "agent_rule",
        objectId: live.id,
        objectKey: `v${live.versionNumber}`,
        action: "rule_paused",
        actorId: auth.userId,
        actorName: auth.name,
        occurredAt: nowIso,
        beforeSummary: rulePauseBefore(live.versionNumber),
        afterSummary: rulePauseAfter(live.versionNumber),
        detail: `mirrored=${mirrored}`,
      });
      if (audit.ok) {
        try {
          await prisma.ownerControlAudit.create({
            data: withBusinessId({ ...audit.entry }),
          });
          auditWritten = true;
        } catch (auditError) {
          logger.error("Agent desk pause audit write failed:", auditError);
        }
      }

      return NextResponse.json({
        paused: true,
        liveVersion: live.versionNumber,
        pause: {
          id: created.id,
          versionNumber: created.versionNumber,
          pausedAt: created.pausedAt,
          pausedByName: created.pausedByName,
          reason: created.reason,
        },
        // The engine now applies NO rule for this business.
        effectiveRule: null,
        mirrored,
        auditWritten,
      });
    } catch (error) {
      logger.error("Failed to pause agent desk rule:", error);
      return NextResponse.json(
        { error: "Failed to pause rule" },
        { status: 500 }
      );
    }
  });
}
