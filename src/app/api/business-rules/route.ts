/**
 * POST/GET /api/business-rules — LEG G (Presswayy-video round 2,
 * STAGED ONLY).
 *
 * SUPPLEMENTARY path only. This is a tenant-dashboard endpoint:
 * the business owner answers the missing business-rule questions
 * and the answers are saved as tenant configuration. It is NOT
 * customer chat, NOT onboarding, and NOT a way for the agent to
 * learn the business — website-first indexing governs, and this
 * endpoint only fills gaps the website and details indexes left.
 *
 * - GET: missing-field detection + plain-language prompts for
 *   EXACTLY the missing fields (no others), plus the supplementary
 *   framing note. Read-only: a missing rules document is a valid
 *   "nothing set yet" state and is never auto-created here.
 * - POST: answer capture. Body: { answers: { field: value | null },
 *   confirmConflict?: boolean }. Validation is per-field; any
 *   validation error => 400, nothing written. Any website/details
 *   conflict without confirmConflict => 409, nothing written
 *   (atomic per request). With confirmConflict, conflicting fields
 *   save with an overridesWebsite record; the website/details
 *   knowledge entry itself is never touched.
 *
 * Tenancy: requireAuth + runWithBusiness, auth-derived businessId
 * only — the body carries no businessId, so a tenant can never
 * address another tenant's rules. Null businessId (Super Admin
 * without a business) => 400, mirroring the settings route.
 * No new quota gate: dashboard rule answers are not AI messages
 * and are not counted toward any message allowance (company
 * unlimited / trial no usage quotas / free tier ~100 msgs/month
 * are untouched — this endpoint neither meters nor exempts).
 *
 * No order, coupon, lead, campaign, takeover, or customer-chat
 * path is touched here. No agent tool writes rules.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  detectRules,
  validateAnswers,
  applyAnswers,
  SUPPLEMENTARY_NOTE,
  type BusinessRulesDoc,
  type RuleKnowledgeEntry,
} from "@/lib/business-rules";

/** Detection scans at most this many highest-priority active
 *  entries. Beyond it, coverage could be missed and a prompt may
 *  ask an already-covered question — the safe failure (prompting
 *  again, then the conflict check on save), never an invented
 *  figure. Raising the cap is an owner decision (see report). */
const DETECTION_ENTRY_CAP = 500;

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "business-rules:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }
    try {
      const rules = (await prisma.businessRules.findUnique({
        where: { businessId: auth.businessId },
      })) as unknown as BusinessRulesDoc | null;
      const rawEntries = await prisma.knowledgeEntry.findMany({
        where: { isActive: true },
        orderBy: { priority: "desc" },
      });
      const entries: RuleKnowledgeEntry[] = rawEntries
        .slice(0, DETECTION_ENTRY_CAP)
        .map((e) => ({
          id: (e as { id?: string }).id,
          sourceWebsiteId: (e as { sourceWebsiteId?: string | null })
            .sourceWebsiteId,
          metadata: (e as { metadata?: { source?: unknown } | null })
            .metadata,
          title: (e as { title?: string }).title,
          content: (e as { content?: string }).content,
        }));
      const detection = detectRules(rules, entries);
      return NextResponse.json({
        supplementaryNote: SUPPLEMENTARY_NOTE,
        primarySource: "website",
        fields: detection.fields,
        missingFields: detection.missingFields,
        prompts: detection.prompts,
      });
    } catch (error) {
      logger.error("Failed to load business rules:", error);
      return NextResponse.json(
        { error: "Failed to load business rules" },
        { status: 500 }
      );
    }
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "business-rules:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }
    const businessId = auth.businessId;
    try {
      const body = await request.json();
      const { clean, errors } = validateAnswers(body?.answers);
      if (errors.length > 0) {
        return NextResponse.json(
          { error: "invalid_answers", errors },
          { status: 400 }
        );
      }
      const confirmConflict = body?.confirmConflict === true;
      const current = ((await prisma.businessRules.findUnique({
        where: { businessId },
      })) as unknown as BusinessRulesDoc | null) ?? { businessId };
      const rawEntries = await prisma.knowledgeEntry.findMany({
        where: { isActive: true },
        orderBy: { priority: "desc" },
      });
      const entries: RuleKnowledgeEntry[] = rawEntries
        .slice(0, DETECTION_ENTRY_CAP)
        .map((e) => ({
          id: (e as { id?: string }).id,
          sourceWebsiteId: (e as { sourceWebsiteId?: string | null })
            .sourceWebsiteId,
          metadata: (e as { metadata?: { source?: unknown } | null })
            .metadata,
          title: (e as { title?: string }).title,
          content: (e as { content?: string }).content,
        }));
      const detection = detectRules(current, entries);
      const result = applyAnswers(current, clean, detection, {
        confirmConflict,
        nowIso: new Date().toISOString(),
      });
      if (result.conflicts.length > 0 && !confirmConflict) {
        // CONFLICT RULE: surface for tenant confirmation, write
        // nothing — not the conflicting fields, not the rest.
        return NextResponse.json(
          {
            error: "website_conflict",
            message:
              "Your website or business details already state something about these fields. " +
              "Confirm explicitly to save your answers beside them, or correct them at the source instead.",
            conflicts: result.conflicts,
            saved: false,
          },
          { status: 409 }
        );
      }
      // Never write the read-back timestamps or the where-key back:
      // the delegate owns createdAt/updatedAt, and businessId is the
      // upsert key, not an updatable field.
      const {
        businessId: _omitBusiness,
        createdAt: _omitCreated,
        updatedAt: _omitUpdated,
        ...writable
      } = result.next;
      void _omitBusiness;
      void _omitCreated;
      void _omitUpdated;
      const saved = (await prisma.businessRules.upsert({
        where: { businessId },
        update: writable,
        create: { businessId, ...writable },
      })) as unknown as BusinessRulesDoc;
      return NextResponse.json({
        success: true,
        applied: result.applied,
        cleared: result.cleared,
        conflictsConfirmed: result.conflicts.length > 0,
        rules: saved,
      });
    } catch (error) {
      logger.error("Failed to save business rules:", error);
      return NextResponse.json(
        { error: "Failed to save business rules" },
        { status: 500 }
      );
    }
  });
}
