/**
 * COMMENT MODE API (WIRED, staged).
 * Repo path when applied: src/app/api/owner-controls/comments/mode/route.ts
 *
 * GET  — the business comment mode (auto | approval | owner).
 * POST — set the comment mode. Body: { "mode": "auto"|"approval"|"owner" }.
 *   Permission: "settings:update".
 *   Mode is per BUSINESS, not per channel (see comment-controls.ts).
 *   Existing businesses keep their current approval behaviour until
 *   the owner flips the mode — this route never flips anyone
 *   silently, and a POST with the current mode writes no new audit
 *   entry beyond the mode-change record for a real change.
 *
 * WIRING (this round): getAdapter() returns the settings-doc
 * adapter (see the channel list route's header for the storage
 * note). A 503 now means the store itself failed, never "not wired".
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { isCommentMode } from "@/lib/owner-controls/comment-controls";
import {
  type OwnerControlDocAdapter,
  emptyDoc,
  writeCommentMode,
} from "@/lib/owner-controls/channel-control-store";
import { getSettingsOwnerControlAdapter } from "@/lib/owner-controls/settings-owner-control-adapter";

function getAdapter(): OwnerControlDocAdapter {
  return getSettingsOwnerControlAdapter();
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }
  let doc;
  try {
    doc = (await getAdapter().getDoc(auth.businessId)) ?? emptyDoc(auth.businessId);
  } catch {
    return NextResponse.json({ error: "Owner controls store unavailable." }, { status: 503 });
  }
  return NextResponse.json({ commentMode: doc.commentMode });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const mode = (body as Record<string, unknown> | null)?.mode;
  if (!isCommentMode(mode)) {
    return NextResponse.json(
      { error: "mode must be auto, approval, or owner." },
      { status: 400 }
    );
  }
  try {
    const written = await writeCommentMode(getAdapter(), {
      businessId: auth.businessId,
      mode,
      changedAtMs: Date.now(),
      changedBy:
        typeof auth.userId === "string" && auth.userId !== "" ? auth.userId : null,
    });
    if (!written.ok) {
      return NextResponse.json({ error: written.error }, { status: 400 });
    }
    return NextResponse.json({ commentMode: written.doc.commentMode });
  } catch {
    return NextResponse.json({ error: "Owner controls store unavailable." }, { status: 503 });
  }
}
