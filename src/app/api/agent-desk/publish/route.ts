/**
 * POST /api/agent-desk/publish — put a draft (or a past version)
 * live, ONLY on the owner's explicit approval.
 *
 * STAGED ONLY (agent booking batch, LEG G).
 *
 * EXPLICIT APPROVAL IS A WIRE REQUIREMENT, not just a button
 * label: the body must carry approved === true. approved missing,
 * false, or anything else → 400 approval_required, nothing
 * changes, the old rule stays live. The dashboard approval
 * checkbox exists to produce that flag; the server never infers
 * approval from the mere fact of a POST.
 *
 * ORDER (see agent-desk.ts header §4 for why): (a) demote every
 * other LIVE row for this business to SUPERSEDED, (b) mark the
 * target LIVE with publishedAt/publishedBy, (c) mirror the
 * text into settings.agentBehavior — the field the engine
 * already reads. If (c) fails after (a)/(b), the response is 500
 * publish_mirror_failed and the next GET reports drift; the old
 * text is still what the engine reads until a re-publish repairs
 * it. A LIVE row may be re-published (re-mirror only) for exactly
 * that repair. DISCARDED drafts may never be published.
 *
 * Publish re-validates the text at publish time: a draft saved
 * under an older guard still has to pass today's guard before it
 * can go live.
 *
 * Tenant scoping: the target is loaded with an explicit
 * businessId filter; a foreign id answers 404 not_found.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  canPublish,
  publicVersion,
  validateRuleText,
  type AgentRuleVersion,
} from "@/lib/agent-desk";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "agent-desk:publish");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }

    try {
      const body = await request.json();
      const { draftId, versionId, approved } = body ?? {};
      const targetId =
        typeof draftId === "string" && draftId
          ? draftId
          : typeof versionId === "string" && versionId
            ? versionId
            : null;

      if (approved !== true) {
        return NextResponse.json(
          { error: "approval_required" },
          { status: 400 }
        );
      }
      if (!targetId) {
        return NextResponse.json(
          { error: "Provide draftId or versionId" },
          { status: 400 }
        );
      }

      const rows = (await prisma.agentRuleVersion.findMany({
        where: { id: targetId, businessId: auth.businessId },
        take: 1,
      })) as unknown as AgentRuleVersion[];
      if (rows.length === 0) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const target = rows[0];
      if (!canPublish(target.status)) {
        return NextResponse.json(
          { error: "version_not_publishable", status: target.status },
          { status: 409 }
        );
      }

      const validation = validateRuleText(target.plainText);
      if (!validation.ok) {
        return NextResponse.json(
          { error: "Rule text refused", codes: validation.errors },
          { status: 400 }
        );
      }

      const now = new Date();
      let previousLiveVersion: number | null = null;

      if (target.status !== "LIVE") {
        const all = (await prisma.agentRuleVersion.findMany({
          where: { businessId: auth.businessId },
          orderBy: [{ versionNumber: "desc" }],
        })) as unknown as AgentRuleVersion[];
        for (const row of all) {
          if (row.status === "LIVE") {
            previousLiveVersion = row.versionNumber;
            await prisma.agentRuleVersion.update({
              where: { id: row.id, businessId: auth.businessId },
              data: { status: "SUPERSEDED" },
            });
          }
        }
        await prisma.agentRuleVersion.update({
          where: { id: target.id, businessId: auth.businessId },
          data: {
            status: "LIVE",
            publishedAt: now,
            publishedBy: auth.userId,
          },
        });
      }

      // Mirror into the live slot the engine already reads.
      try {
        await prisma.settings.upsert({
          where: { businessId: auth.businessId },
          update: { agentBehavior: target.plainText },
          create: withBusinessId({ agentBehavior: target.plainText }),
        });
      } catch (mirrorError) {
        logger.error("Agent desk publish mirrored failed:", mirrorError);
        return NextResponse.json(
          {
            error: "publish_mirror_failed",
            live: publicVersion({ ...target, status: "LIVE" }),
          },
          { status: 500 }
        );
      }

      const live = (await prisma.agentRuleVersion.findMany({
        where: { id: target.id, businessId: auth.businessId },
        take: 1,
      })) as unknown as AgentRuleVersion[];

      return NextResponse.json({
        live: live.length > 0 ? publicVersion(live[0]) : publicVersion({ ...target, status: "LIVE" }),
        previousLiveVersion,
        mirrored: true,
        warnings: validation.warnings,
      });
    } catch (error) {
      logger.error("Failed to publish agent desk version:", error);
      return NextResponse.json(
        { error: "Failed to publish" },
        { status: 500 }
      );
    }
  });
}
