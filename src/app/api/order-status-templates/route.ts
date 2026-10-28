/**
 * /api/order-status-templates — list + create/edit order-status
 * message templates.
 *
 * STAGED ONLY (owner controls, LEG D). Extends the staged
 * order-status batch's Leg C (order-status messages) WITHOUT
 * rewriting its status-update
 * path: templates live in their own orderStatusTemplates collection
 * and are consulted ONLY by the SNIP-2 gate inside
 * queueOrderStatusUpdate. Nothing here writes an order, changes a
 * status, or sends a message — editing a template only changes what
 * a FUTURE status push would say, and only while the template is
 * active (paused templates send nothing; see the [key]/pause route).
 *
 * GET: all templates for THIS business (key, text, status). Text
 * is returned only to the same tenant's session (route scoping).
 * POST: body { key, text }. key must be one of the four push keys
 * (confirmed:rider, confirmed:own_delivery, confirmed:unrouted,
 * cancelled); text is validated by validateTemplateText (empty /
 * over-long / unknown placeholder / secret / amount-bearing texts
 * are refused with 400 + codes). Editing preserves the row's
 * status: editing a paused template keeps it paused — an edit is
 * not a resume. A new template starts ACTIVE.
 *
 * AUDIT: one ownerControlAudit entry (template_created /
 * template_edited); see @/lib/owner-controls/owner-control-audit
 * for the Leg E reconciliation flag. Audit failure is flagged
 * (auditWritten) rather than hidden, and never un-does the edit.
 *
 * All control labels and all template wording are PROPOSAL for
 * owner approval. Dashboard buttons for these routes are follow-up
 * UI work (see LEG-REPORT.md §8) — the routes are the control.
 *
 * Tenant scoping: requireAuth + runWithBusiness + explicit
 * businessId filter on every query. Null business => 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  editTemplate,
  isTemplateKey,
  validateTemplateText,
  type OrderStatusTemplate,
} from "@/lib/owner-controls/status-templates";
import {
  buildOwnerControlAuditEntry,
  templateAfter,
  templateBefore,
} from "@/lib/owner-controls/owner-control-audit";

function publicTemplate(t: OrderStatusTemplate) {
  return {
    id: t.id,
    key: t.key,
    text: t.text,
    status: t.status,
    pausedAt: t.pausedAt,
    pausedBy: t.pausedBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "order-status-templates:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }
    try {
      const rows = (await prisma.orderStatusTemplate.findMany({
        where: { businessId: auth.businessId },
      })) as unknown as OrderStatusTemplate[];
      return NextResponse.json({
        templates: rows.map(publicTemplate),
      });
    } catch (error) {
      logger.error("Failed to list order status templates:", error);
      return NextResponse.json(
        { error: "Failed to list templates" },
        { status: 500 }
      );
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "order-status-templates:write");
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
      const { key, text } = body ?? {};
      if (!isTemplateKey(key)) {
        return NextResponse.json(
          { error: "Unknown template key" },
          { status: 400 }
        );
      }
      const validation = validateTemplateText(text);
      if (!validation.ok) {
        return NextResponse.json(
          { error: "Template text refused", codes: validation.errors },
          { status: 400 }
        );
      }

      const found = (await prisma.orderStatusTemplate.findMany({
        where: { businessId: auth.businessId, key },
        take: 1,
      })) as unknown as OrderStatusTemplate[];
      const existing = found.length > 0 ? found[0] : null;

      const nowIso = new Date().toISOString();
      const decision = editTemplate({
        existing,
        businessId: auth.businessId,
        authBusinessId: auth.businessId,
        key,
        text,
        actorId: auth.userId,
        actorName: auth.name,
        nowIso,
        newId: "",
      });
      if (!decision.ok) {
        return NextResponse.json(
          { error: decision.reason, codes: decision.errors ?? [] },
          { status: 400 }
        );
      }

      let saved: OrderStatusTemplate;
      if (decision.isNew) {
        // The delegate assigns the id on create; the pure decision's
        // placeholder id is never persisted.
        saved = (await prisma.orderStatusTemplate.create({
          data: withBusinessId({
            key: decision.row.key,
            text: decision.row.text,
            status: "active",
            createdBy: auth.userId,
            createdByName: auth.name,
            createdAt: nowIso,
            updatedAt: nowIso,
            pausedAt: null,
            pausedBy: null,
          }),
        })) as unknown as OrderStatusTemplate;
      } else {
        // Update ONLY text + updatedAt: status and pause fields are
        // deliberately untouched, so an edit never resumes a pause.
        saved = (await prisma.orderStatusTemplate.update({
          where: { id: existing!.id, businessId: auth.businessId },
          data: { text: decision.row.text, updatedAt: nowIso },
        })) as unknown as OrderStatusTemplate;
      }

      let auditWritten = false;
      const audit = buildOwnerControlAuditEntry({
        businessId: auth.businessId,
        objectType: "order_status_template",
        objectId: saved.id,
        objectKey: saved.key,
        action: decision.isNew ? "template_created" : "template_edited",
        actorId: auth.userId,
        actorName: auth.name,
        occurredAt: nowIso,
        beforeSummary: existing
          ? templateBefore(existing.status, existing.text.length)
          : "none",
        afterSummary: templateAfter(saved.status, saved.text.length),
        detail: `status=${saved.status}`,
      });
      if (audit.ok) {
        try {
          await prisma.ownerControlAudit.create({
            data: withBusinessId({ ...audit.entry }),
          });
          auditWritten = true;
        } catch (auditError) {
          logger.error("Order status template audit write failed:", auditError);
        }
      }

      return NextResponse.json({
        template: publicTemplate(saved),
        isNew: decision.isNew,
        warnings: validation.warnings,
        auditWritten,
      });
    } catch (error) {
      logger.error("Failed to save order status template:", error);
      return NextResponse.json(
        { error: "Failed to save template" },
        { status: 500 }
      );
    }
  });
}
