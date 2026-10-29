import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { maskSettingsSecrets } from "@/lib/security";
import { updateSettingsSchema, validateBody } from "@/lib/validations";
import { logger } from "@/lib/logger";
import {
  appendAudit,
  buildAuditEntry,
  mergeControls,
  normalizeControls,
  summarizeControlChanges,
  validateControlPatch,
} from "@/lib/owner-controls/message-controls";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  RESERVED_NAME_ERROR,
  isReservedBusinessName,
} from "@/lib/reserved-names";
import { isCompanyBusiness } from "@/lib/company-identity";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }

    try {
      let settings = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });

      if (!settings) {
        settings = await prisma.settings.create({
          data: { businessId: auth.businessId },
        });
      }

      return NextResponse.json(maskSettingsSecrets(settings));
    } catch (error) {
      logger.error("Failed to fetch settings:", error);
      return NextResponse.json(
        { error: "Failed to fetch settings" },
        { status: 500 }
      );
    }

  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
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

      // Remove fields that should not be updated directly
      delete body.id;
      delete body.businessId;
      delete body.createdAt;
      delete body.updatedAt;

      const validation = validateBody(updateSettingsSchema, body);
      if (!validation.success) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }

      // Platform-name reservation (owner 2026-10-29 ~23:53): a tenant
      // may not RENAME to "Ride Bangla" (exact-match family; see
      // reserved-names.ts). Checked BEFORE the upsert and before the
      // Business.name sync, so a blocked rename writes nothing at
      // all. EXEMPTION: the company's own business is skipped — it
      // already is Ride Bangla and must never be locked out of its
      // own name. On an exemption-check failure the business is
      // treated as non-company (block applies); a company rename
      // during a data-layer outage can simply be retried.
      if (
        typeof validation.data.businessName === "string" &&
        isReservedBusinessName(validation.data.businessName) &&
        !(await isCompanyBusiness(auth.businessId ?? ""))
      ) {
        return NextResponse.json(
          { error: RESERVED_NAME_ERROR },
          { status: 400 }
        );
      }

      // Owner message controls (LEG C): a Settings PUT carrying
      // messageControls must pass the SAME semantic validation as the
      // dedicated route, deep-merge (never replace sibling families),
      // and audit — otherwise a PUT naming one family would silently
      // wipe the others (nested-object replace semantics) and the
      // trail would have a hole. Requires diff 001 (schema field).
      // The audit trail is server-computed, never client input: it is
      // NOT part of updateSettingsSchema (client-sent audit keys stay
      // stripped/rejected by validation). writeData is therefore the
      // schema output PLUS the server-only audit field.
      let writeData: typeof validation.data & {
        messageControlsAudit?: unknown;
      } = validation.data;
      if (validation.data.messageControls !== undefined) {
        const patchCheck = validateControlPatch(validation.data.messageControls);
        if (!patchCheck.ok) {
          return NextResponse.json(
            { error: patchCheck.error, field: patchCheck.field ?? null },
            { status: 400 }
          );
        }
        const existing = await prisma.settings.findUnique({
          where: { businessId: auth.businessId },
        });
        const before = normalizeControls(existing?.messageControls);
        const after = mergeControls(
          before,
          validation.data.messageControls as Record<string, unknown>
        );
        const changes = summarizeControlChanges(before, after);
        if (changes.length > 0) {
          const actorId =
            typeof auth.userId === "string" && auth.userId !== ""
              ? auth.userId
              : null;
          const actorType = actorId
            ? actorId.startsWith("api-key:")
              ? "api-key"
              : "dashboard"
            : "unknown";
          const entry = buildAuditEntry({
            id: crypto.randomUUID(),
            businessId: auth.businessId,
            actorType,
            actorId,
            at: new Date().toISOString(),
            action: "controls_updated",
            family: changes[0].family,
            scope: changes.length === 1 ? changes[0].scope : null,
            recordId: null,
            changes,
          });
          const priorAudit = Array.isArray(existing?.messageControlsAudit)
            ? (existing?.messageControlsAudit as never[])
            : [];
          writeData = {
            ...validation.data,
            messageControls: after,
            messageControlsAudit: appendAudit(priorAudit as never, entry),
          };
        } else {
          // No-change patch: keep the stored controls as-is instead of
          // overwriting them with a partial object.
          writeData = { ...validation.data, messageControls: before };
        }
      }
      const settings = await prisma.settings.upsert({
        where: { businessId: auth.businessId },
        update: writeData,
        create: { businessId: auth.businessId, ...writeData },
      });

      // Identity sync (owner 2026-10-29): Settings.businessName is the
      // name the engine speaks as, but the Channels embed snippet and
      // the widget route read Business.name. A Settings edit must flip
      // BOTH, or the two sources diverge and the snippet keeps the old
      // name. Best-effort with a log (mirrors setup-application): a
      // Business-row failure must not fail the Settings save itself.
      if (
        typeof writeData.businessName === "string" &&
        writeData.businessName.trim().length >= 2
      ) {
        try {
          await prisma.business.update({
            where: { id: auth.businessId },
            data: { name: writeData.businessName.trim().slice(0, 100) },
          });
        } catch (err) {
          logger.warn(
            "[settings] Business.name sync failed after Settings edit",
            { error: err instanceof Error ? err.message : String(err) }
          );
        }
      }

      return NextResponse.json(maskSettingsSecrets(settings));
    } catch (error) {
      logger.error("Failed to update settings:", error);
      return NextResponse.json(
        { error: "Failed to update settings" },
        { status: 500 }
      );
    }

  });
}
