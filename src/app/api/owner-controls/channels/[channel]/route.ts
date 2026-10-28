/**
 * CHANNEL CONTROL API — one channel (WIRED, staged).
 * Repo path when applied:
 *   src/app/api/owner-controls/channels/[channel]/route.ts
 *
 * GET  — one channel's control state.
 * POST — takeover or hand-back for ONE channel only.
 *   Body: { "action": "takeover" | "handback", "reason"?: string }
 *   Permission: "settings:update" (HEAD's settings write permission).
 *   A takeover/hand-back changes ONLY that channel; the store
 *   carries every other channel over untouched (one off != all off).
 *   A no-change POST (already in the requested mode) returns ok
 *   with no new audit entry — an audit entry is written only when
 *   the mode actually changes.
 *
 * WIRING (this round): getAdapter() returns the settings-doc
 * adapter (see the list route's header for the storage note). A
 * 503 now means the store itself failed, never "not wired".
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  normalizeChannel,
  takeOverChannel,
  handBackChannel,
} from "@/lib/owner-controls/channel-controls";
import {
  type OwnerControlDocAdapter,
  emptyDoc,
  writeChannelControl,
} from "@/lib/owner-controls/channel-control-store";
import { getSettingsOwnerControlAdapter } from "@/lib/owner-controls/settings-owner-control-adapter";

function getAdapter(): OwnerControlDocAdapter {
  return getSettingsOwnerControlAdapter();
}

function actorOf(auth: { userId?: string | null }): string | null {
  const id = typeof auth.userId === "string" && auth.userId !== "" ? auth.userId : null;
  if (!id) return null;
  return id;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> }
) {
  const { channel: rawChannel } = await params;
  const auth = await requireAuth(request, "settings:read");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }
  const channel = normalizeChannel(rawChannel);
  if (!channel) {
    return NextResponse.json({ error: "Invalid channel." }, { status: 400 });
  }
  let doc;
  try {
    doc = (await getAdapter().getDoc(auth.businessId)) ?? emptyDoc(auth.businessId);
  } catch {
    return NextResponse.json({ error: "Owner controls store unavailable." }, { status: 503 });
  }
  const state = doc.channelControls[channel] ?? null;
  return NextResponse.json({
    channel,
    mode: state ? state.mode : "ai",
    state,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> }
) {
  const { channel: rawChannel } = await params;
  const auth = await requireAuth(request, "settings:update");
  if (!isAuthenticated(auth)) return auth;
  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }
  const channel = normalizeChannel(rawChannel);
  if (!channel) {
    return NextResponse.json({ error: "Invalid channel." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = (body as Record<string, unknown> | null)?.action;
  if (action !== "takeover" && action !== "handback") {
    return NextResponse.json(
      { error: "action must be takeover or handback." },
      { status: 400 }
    );
  }
  const reasonRaw = (body as Record<string, unknown> | null)?.reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : null;
  let doc;
  try {
    doc = (await getAdapter().getDoc(auth.businessId)) ?? emptyDoc(auth.businessId);
  } catch {
    return NextResponse.json({ error: "Owner controls store unavailable." }, { status: 503 });
  }
  const nowMs = Date.now();
  const actor = actorOf(auth);
  const transition =
    action === "takeover"
      ? takeOverChannel({
          businessId: auth.businessId,
          channel,
          controls: doc.channelControls,
          changedAtMs: nowMs,
          changedBy: actor,
          reason,
        })
      : handBackChannel({
          businessId: auth.businessId,
          channel,
          controls: doc.channelControls,
          changedAtMs: nowMs,
          changedBy: actor,
          reason,
        });
  if (!transition.ok) {
    return NextResponse.json({ error: transition.error }, { status: 400 });
  }
  try {
    const written = await writeChannelControl(getAdapter(), {
      businessId: auth.businessId,
      state: transition.state,
      audit: transition.audit,
    });
    if (!written.ok) {
      return NextResponse.json({ error: written.error }, { status: 400 });
    }
    return NextResponse.json({ channel, mode: transition.state.mode, state: transition.state });
  } catch {
    return NextResponse.json({ error: "Owner controls store unavailable." }, { status: 503 });
  }
}
