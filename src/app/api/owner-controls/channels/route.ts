/**
 * CHANNEL CONTROLS API — list (WIRED, staged).
 * Repo path when applied: src/app/api/owner-controls/channels/route.ts
 *
 * GET — the business's per-channel control states + comment mode.
 * Permission: "settings:read" (HEAD's settings permission; no new
 * permission is invented here).
 *
 * WIRING (this round): getAdapter() below returns the settings-doc
 * adapter (src/lib/owner-controls/settings-owner-control-adapter.ts),
 * backed by HEAD's existing per-business settings document
 * (Firestore collection "settings", via prisma.settings). No new
 * Prisma model and no new Firestore collection are introduced, so
 * no rules fragment is required for this storage. A 503 from this
 * route now means the store itself failed (Firestore unavailable /
 * unconfigured, or a corrupt stored doc) — never "not wired".
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  type OwnerControlDocAdapter,
  emptyDoc,
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
  return NextResponse.json({
    channelControls: doc.channelControls,
    commentMode: doc.commentMode,
  });
}
