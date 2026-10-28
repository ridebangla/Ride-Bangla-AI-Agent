/**
 * POST /api/order-status-templates/[key]/resume — resume one template.
 *
 * STAGED ONLY (owner controls, LEG D). Repo path when applied:
 * src/app/api/order-status-templates/[key]/resume/route.ts
 *
 * EFFECT: the template's status flips paused -> active and nothing
 * else changes. The restored text IS the row's text — no copy was
 * ever made while paused, so resume restores it byte-identically
 * by construction. The route asserts restoredText === row.text
 * before responding; a mismatch (impossible by construction) would
 * answer 500 instead of claiming a restore that did not happen.
 * Resume does not edit, re-validate-and-rewrite, or re-create the
 * template: the next status push for that transition sends the
 * owner's text verbatim (rendered only for {orderRef}).
 *
 * REFUSALS (nothing changes): unknown key for this business =>
 * 404 not_found (foreign keys answer the same 404); not paused =>
 * 409 not_paused (an edit is not a resume, and a resume is not an
 * edit — the two actions stay separate by design).
 *
 * AUDIT: one ownerControlAudit entry (template_resumed); see
 * @/lib/owner-controls/owner-control-audit for the Leg E
 * reconciliation flag. Audit failure is flagged, never hidden.
 *
 * Tenant scoping: requireAuth + runWithBusiness + explicit
 * businessId filter. Null business => 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  isTemplateKey,
  resumeTemplate,
  type OrderStatusTemplate,
} from "@/lib/owner-controls/status-templates";
import {
  buildOwnerControlAuditEntry,
  templateAfter,
  templateBefore,
} from "@/lib/owner-controls/owner-control-audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  const auth = await requireAuth(request, "order-status-templates:write");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }
    if (!isTemplateKey(key)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    try {
      const found = (await prisma.orderStatusTemplate.findMany({
        where: { businessId: auth.businessId, key },
        take: 1,
      })) as unknown as OrderStatusTemplate[];
      if (found.length === 0) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const row = found[0];

      const nowIso = new Date().toISOString();
      const decision = resumeTemplate({
        row,
        authBusinessId: auth.businessId,
        nowIso,
      });
      if (!decision.ok) {
        return NextResponse.json(
          { error: decision.reason },
          { status: 409 }
        );
      }
      if (decision.restoredText !== row.text) {
        return NextResponse.json(
          { error: "resume_restore_mismatch" },
          { status: 500 }
        );
      }

      const saved = (await prisma.orderStatusTemplate.update({
        where: { id: row.id, businessId: auth.businessId },
        data: { status: "active", pausedAt: null, pausedBy: null },
      })) as unknown as OrderStatusTemplate;

      let auditWritten = false;
      const audit = buildOwnerControlAuditEntry({
        businessId: auth.businessId,
        objectType: "order_status_template",
        objectId: row.id,
        objectKey: row.key,
        action: "template_resumed",
        actorId: auth.userId,
        actorName: auth.name,
        occurredAt: nowIso,
        beforeSummary: templateBefore(row.status, row.text.length),
        afterSummary: templateAfter("active", row.text.length),
        detail: "status=active",
      });
      if (audit.ok) {
        try {
          await prisma.ownerControlAudit.create({
            data: withBusinessId({ ...audit.entry }),
          });
          auditWritten = true;
        } catch (auditError) {
          logger.error("Template resume audit write failed:", auditError);
        }
      }

      return NextResponse.json({
        resumed: true,
        template: { key: saved.key, status: saved.status },
        restoredByteIdentical: decision.restoredText === row.text,
        auditWritten,
      });
    } catch (error) {
      logger.error("Failed to resume order status template:", error);
      return NextResponse.json(
        { error: "Failed to resume template" },
        { status: 500 }
      );
    }
  });
}
