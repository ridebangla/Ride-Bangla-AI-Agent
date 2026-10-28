/**
 * Owner message controls API — LEG C (STAGED ONLY).
 * Repo path when applied: src/app/api/message-controls/route.ts
 *
 * GET  — the business's controls + recent audit entries (settings:read).
 * PUT  — partial control patch (settings:update, admin only, same as the
 *        Settings API). Deep-merges over the stored controls, validates
 *        with the pure module (unknown scopes rejected, templated
 *        overrides must carry their required placeholder), and appends
 *        exactly one audit entry when anything changed. A no-change
 *        patch writes nothing and returns the current state.
 *
 * This route is the PRIMARY writer. The Settings PUT path (see
 * diff 002) accepts the same `messageControls` field and applies the
 * same validation + merge + audit, so the trail has no hole whichever
 * writer the owner used. Dashboard UI for these controls is NOT staged
 * (apply-time work, like Leg D's reminder settings UI).
 *
 * All user-facing wording here is functional (labels / error codes),
 * not shipped customer copy. No default message text exists anywhere
 * in this leg: override texts are always owner-supplied.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  loadControls,
  updateControls,
  type MessageControlDb,
} from "@/lib/owner-controls/message-control-store";

function db(): MessageControlDb {
  // Structural pass-through: the real prisma delegates already carry
  // the findFirst/update/upsert shapes the store module uses.
  return prisma as unknown as MessageControlDb;
}

function actorOf(auth: { userId?: string | null }): { type: "dashboard" | "api-key" | "unknown"; id: string | null } {
  const id = typeof auth.userId === "string" && auth.userId !== "" ? auth.userId : null;
  if (!id) return { type: "unknown", id: null };
  // route-auth shapes API-key callers as userId "api-key:<id>" — record
  // that honestly instead of mislabelling them as dashboard users.
  return id.startsWith("api-key:") ? { type: "api-key", id } : { type: "dashboard", id };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "No business configured — complete setup first." }, { status: 400 });
  }
  return runWithBusiness(auth.businessId, async () => {
    const loaded = await loadControls(db(), auth.businessId as string);
    if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: 403 });
    const audit = Array.isArray(loaded.settingsDoc?.messageControlsAudit)
      ? (loaded.settingsDoc?.messageControlsAudit as unknown[]).slice(-50)
      : [];
    return NextResponse.json({ controls: loaded.controls, audit });
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "No business configured — complete setup first." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch = (body as Record<string, unknown> | null)?.controls;
  if (patch === undefined) {
    return NextResponse.json({ error: "controls patch is required" }, { status: 400 });
  }
  return runWithBusiness(auth.businessId, async () => {
    try {
      const result = await updateControls(db(), {
        businessId: auth.businessId as string,
        actor: actorOf(auth),
        patch,
        atIso: new Date().toISOString(),
        entryId: crypto.randomUUID(),
      });
      if (!result.ok) {
        const status = result.error === "cross_tenant" ? 403 : 400;
        return NextResponse.json(
          { error: result.error, detail: result.detail ?? null },
          { status }
        );
      }
      return NextResponse.json({
        controls: result.value.controls,
        auditEntry: result.value.auditEntry,
      });
    } catch (err) {
      logger.error("Message-controls update failed:", err);
      return NextResponse.json({ error: "Failed to update message controls" }, { status: 500 });
    }
  });
}
