/**
 * Per-record message controls — LEG C (STAGED ONLY).
 * Repo path when applied: src/app/api/message-controls/records/[id]/route.ts
 *
 * PATCH — one of:
 *   { action: "edit_message", message: string }
 *   { action: "pause", pausedUntil?: string | null, note?: string | null }
 *   { action: "resume" }
 * Permission: conversations:update (the Leg D suppress-route precedent
 * for per-record follow-up actions). Tenant-scoped via runWithBusiness:
 * a record belonging to another business is refused with 403 and
 * nothing is written.
 *
 * Rules (all enforced in the store module, stated here for the reader):
 *  - Only controlled kinds (warm/hot/dropped/checkin/reminder/rating/
 *    review-request records). Broadcast records are refused: editing
 *    them would interact with Leg F's byte-identical test-send rule.
 *  - Only PENDING records. A sent/failed/suppressed record is history,
 *    not an editable draft; editing it would rewrite what the customer
 *    already received.
 *  - Pause touches ONLY the owner-pause fields. Resume clears ONLY
 *    those fields. Status, dueAt, and message are never rewritten by a
 *    pause/resume, so resume restores the record exactly.
 *  - Every successful mutation appends an audit entry to the settings
 *    doc's trail (record edit: before/after message text).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  editRecordMessage,
  pauseRecord,
  resumeRecord,
  type MessageControlDb,
} from "@/lib/owner-controls/message-control-store";

function db(): MessageControlDb {
  return prisma as unknown as MessageControlDb;
}

function actorOf(auth: { userId?: string | null }): { type: "dashboard" | "api-key" | "unknown"; id: string | null } {
  const id = typeof auth.userId === "string" && auth.userId !== "" ? auth.userId : null;
  if (!id) return { type: "unknown", id: null };
  // route-auth shapes API-key callers as userId "api-key:<id>" — record
  // that honestly instead of mislabelling them as dashboard users.
  return id.startsWith("api-key:") ? { type: "api-key", id } : { type: "dashboard", id };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json({ error: "No business configured — complete setup first." }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "edit_message" && action !== "pause" && action !== "resume") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  if (
    action === "pause" &&
    body.pausedUntil !== undefined &&
    body.pausedUntil !== null &&
    typeof body.pausedUntil !== "string"
  ) {
    return NextResponse.json({ error: "pausedUntil must be an ISO string or null" }, { status: 400 });
  }
  return runWithBusiness(auth.businessId, async () => {
    try {
      const base = {
        businessId: auth.businessId as string,
        actor: actorOf(auth),
        recordId: id,
        atIso: new Date().toISOString(),
        entryId: crypto.randomUUID(),
      };
      const result =
        action === "edit_message"
          ? await editRecordMessage(db(), {
              ...base,
              message: typeof body.message === "string" ? body.message : "",
            })
          : action === "pause"
            ? await pauseRecord(db(), {
                ...base,
                pausedUntil:
                  typeof body.pausedUntil === "string" ? body.pausedUntil : null,
                note: typeof body.note === "string" ? body.note : null,
              })
            : await resumeRecord(db(), base);
      if (!result.ok) {
        const status =
          result.error === "cross_tenant"
            ? 403
            : result.error === "record_not_found"
              ? 404
              : 400;
        return NextResponse.json(
          { error: result.error, detail: result.detail ?? null },
          { status }
        );
      }
      return NextResponse.json({ success: true, ...result.value });
    } catch (err) {
      logger.error("Message-controls record action failed:", err);
      return NextResponse.json({ error: "Failed to apply record action" }, { status: 500 });
    }
  });
}
