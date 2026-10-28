/**
 * POST /api/order-status-templates/[key]/pause — pause one template.
 *
 * STAGED ONLY (owner controls, LEG D). Repo path when applied:
 * src/app/api/order-status-templates/[key]/pause/route.ts
 *
 * EFFECT: the template's status flips active -> paused and nothing
 * else changes — the text is never touched, never copied, never
 * deleted. While paused, the SNIP-2 gate inside
 * queueOrderStatusUpdate returns { send:false, reason:
 * "template_paused" } and logs the block; the ORDER STATUS CHANGE
 * ITSELF still records (the gate runs after setOrderStatus + the
 * courier bridge, and never throws into them). Pausing a template
 * therefore silences that transition's customer message only — it
 * never blocks, delays, or rewrites the status.
 *
 * REFUSALS (nothing changes): unknown key for this business =>
 * 404 not_found (a foreign key answers the same 404, never 403, so
 * a caller cannot learn whether another business owns that key);
 * already paused => 409 already_paused.
 *
 * AUDIT: one ownerControlAudit entry (template_paused); see
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
  pauseTemplate,
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
      const decision = pauseTemplate({
        row,
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

      const saved = (await prisma.orderStatusTemplate.update({
        where: { id: row.id, businessId: auth.businessId },
        data: {
          status: "paused",
          pausedAt: nowIso,
          pausedBy: auth.userId,
        },
      })) as unknown as OrderStatusTemplate;

      let auditWritten = false;
      const audit = buildOwnerControlAuditEntry({
        businessId: auth.businessId,
        objectType: "order_status_template",
        objectId: row.id,
        objectKey: row.key,
        action: "template_paused",
        actorId: auth.userId,
        actorName: auth.name,
        occurredAt: nowIso,
        beforeSummary: templateBefore(row.status, row.text.length),
        afterSummary: templateAfter("paused", row.text.length),
        detail: "status=paused",
      });
      if (audit.ok) {
        try {
          await prisma.ownerControlAudit.create({
            data: withBusinessId({ ...audit.entry }),
          });
          auditWritten = true;
        } catch (auditError) {
          logger.error("Template pause audit write failed:", auditError);
        }
      }

      return NextResponse.json({
        paused: true,
        template: {
          key: saved.key,
          status: saved.status,
          pausedAt: saved.pausedAt,
        },
        // Pause flips status only: the text is provably untouched.
        textUnchanged: saved.text === row.text,
        auditWritten,
      });
    } catch (error) {
      logger.error("Failed to pause order status template:", error);
      return NextResponse.json(
        { error: "Failed to pause template" },
        { status: 500 }
      );
    }
  });
}
