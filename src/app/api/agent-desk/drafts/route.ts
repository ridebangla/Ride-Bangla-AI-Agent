/**
 * POST /api/agent-desk/drafts — save a new open draft.
 *
 * STAGED ONLY (agent booking batch, LEG G).
 * The owner writes rules in plain language; nothing here goes
 * live. Saving a draft:
 *  - validates the text (blocking codes in agent-desk.ts; a draft
 *    that tells the agent to confirm alone, hide its AI identity,
 *    or that carries credential-shaped text is refused with 400),
 *  - marks any previous open DRAFT for this business DISCARDED
 *    (never deleted — history keeps who wrote what, when),
 *  - creates a new DRAFT row with the next version number.
 * Saving a draft never touches settings.agentBehavior, so the old
 * rule keeps answering customers until an approved publish.
 *
 * Tenant scoping: runWithBusiness + explicit businessId on every
 * query; the created row is built with withBusinessId (fail-closed
 * when no tenant context is active).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  nextVersionNumber,
  publicVersion,
  validateChangeNote,
  validateRuleText,
  type AgentRuleVersion,
} from "@/lib/agent-desk";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "agent-desk:write");
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
      const { plainText, changeNote } = body ?? {};

      const validation = validateRuleText(plainText);
      if (!validation.ok) {
        return NextResponse.json(
          { error: "Rule text refused", codes: validation.errors },
          { status: 400 }
        );
      }
      if (!validateChangeNote(changeNote)) {
        return NextResponse.json(
          { error: "Change note is too long" },
          { status: 400 }
        );
      }

      const existing = (await prisma.agentRuleVersion.findMany({
        where: { businessId: auth.businessId },
        orderBy: [{ versionNumber: "desc" }],
      })) as unknown as AgentRuleVersion[];

      // One open draft at a time: previous drafts are discarded,
      // never deleted, so their text stays in history.
      for (const row of existing) {
        if (row.status === "DRAFT") {
          await prisma.agentRuleVersion.update({
            where: { id: row.id, businessId: auth.businessId },
            data: { status: "DISCARDED" },
          });
        }
      }

      const created = (await prisma.agentRuleVersion.create({
        data: withBusinessId({
          versionNumber: nextVersionNumber(
            existing.map((r) => r.versionNumber)
          ),
          status: "DRAFT",
          plainText: (plainText as string).trim(),
          changeNote:
            typeof changeNote === "string" ? changeNote.trim() : "",
          createdBy: auth.userId,
          createdByName: auth.name,
          publishedAt: null,
          publishedBy: null,
          origin: "draft",
          restoresVersion: null,
        }),
      })) as unknown as AgentRuleVersion;

      return NextResponse.json({
        draft: publicVersion(created),
        warnings: validation.warnings,
      });
    } catch (error) {
      logger.error("Failed to save agent desk draft:", error);
      return NextResponse.json(
        { error: "Failed to save draft" },
        { status: 500 }
      );
    }
  });
}
