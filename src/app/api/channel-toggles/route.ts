import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  MESSAGE_CHANNELS,
  isKnownChannel,
  isValidPageKey,
  parseChannelToggles,
  parsePageToggles,
  setChannelToggle,
  setPageToggle,
  extractPageKeys,
  type ChannelToggles,
  type PageToggles,
} from "@/lib/channel-toggles";

/**
 * Leg J — per-channel / per-page AI toggles (STAGED).
 *
 *   GET  /api/channel-toggles
 *   PUT  /api/channel-toggles
 *
 * Tenant-scoped: every read and write runs inside the caller's own
 * business context, and the settings doc is addressed by businessId,
 * so one tenant's toggles can never leak into another tenant's doc.
 * A null businessId (Super Admin with no business) gets 400, the
 * same pattern as the settings route — there is no business whose
 * toggles a Super Admin could meaningfully flip from here.
 *
 * Permissions reuse the existing channels pair (rbac.ts, untouched):
 * channels:read (supervisor, admin) for GET, channels:update (admin
 * only) for PUT. No new permission is invented.
 *
 * PUT body — exactly ONE target per request (idempotent: repeating
 * the same body returns the same state):
 *   { "channel": "messenger", "enabled": false }
 *   { "pageKey": "<accountRef or account id>", "messages": false }
 *   { "pageKey": "<accountRef or account id>", "comments": false }
 *   { "pageKey": "<accountRef or account id>",
 *     "messages": true, "comments": false }
 * A pageKey matching one of the tenant's social accounts by id is
 * normalised to that account's accountRef on write, because the
 * enforcement points read accountRef keys (Meta recipient id /
 * comment parentRef prefix). Unknown channels, mixed targets, and
 * non-boolean switches are 400; nothing is partially applied.
 *
 * This route does NOT touch the global switch (settings.aiEnabled),
 * the per-chat pause (conversations.aiEnabled), or the per-account
 * comment autoReply setting — those live in their own places and
 * keep their own semantics. See src/lib/channel-toggles.ts for the
 * full precedence statement.
 *
 * Dashboard UI is a follow-up (see the leg report §9): this route is
 * the contract it mounts on. All user-facing wording for that UI is
 * PROPOSAL for owner approval, never shipped copy.
 */

interface PageInfo {
  pageKey: string;
  platform: string | null;
  label: string | null;
  source: "account" | "conversation" | "stored";
  messagesEnabled: boolean;
  commentsEnabled: boolean;
}

async function loadAccounts(businessId: string): Promise<
  Array<{
    id: string;
    platform: string;
    label: string;
    accountRef: string;
  }>
> {
  try {
    const accounts = await prisma.socialAccount.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    });
    return (accounts as Array<Record<string, unknown>>)
      .filter((a) => typeof a.id === "string")
      .map((a) => ({
        id: a.id as string,
        platform: typeof a.platform === "string" ? a.platform : "",
        label: typeof a.label === "string" ? a.label : "",
        accountRef: typeof a.accountRef === "string" ? a.accountRef : "",
      }));
  } catch (err) {
    logger.warn("[channel-toggles] social account list failed; continuing without it", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function loadConversationPageKeys(): Promise<
  Array<{ pageKey: string; channel: string }>
> {
  try {
    const convs = await prisma.conversation.findMany({
      select: { channel: true, metadata: true },
      take: 500,
    });
    const seen = new Set<string>();
    const out: Array<{ pageKey: string; channel: string }> = [];
    for (const c of convs as Array<Record<string, unknown>>) {
      const channel = typeof c.channel === "string" ? c.channel : "";
      for (const key of extractPageKeys(c.metadata)) {
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ pageKey: key, channel });
        }
      }
    }
    return out;
  } catch (err) {
    logger.warn("[channel-toggles] conversation page scan failed; continuing without it", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "channels:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }
    try {
      const settings = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });
      const raw = (settings || {}) as Record<string, unknown>;
      const channelToggles: ChannelToggles = parseChannelToggles(
        raw.channelAiToggles
      );
      const pageToggles: PageToggles = parsePageToggles(raw.pageAiToggles);

      const channels = MESSAGE_CHANNELS.map((channel) => ({
        channel,
        enabled: channelToggles[channel] !== false,
      }));

      const byKey = new Map<string, PageInfo>();
      const accounts = await loadAccounts(auth.businessId as string);
      for (const a of accounts) {
        const key = a.accountRef || a.id;
        if (!key) continue;
        const entry = pageToggles[key] || pageToggles[a.id] || {};
        byKey.set(key, {
          pageKey: key,
          platform: a.platform || null,
          label: a.label || null,
          source: "account",
          messagesEnabled: entry.messages !== false,
          commentsEnabled: entry.comments !== false,
        });
      }
      for (const conv of await loadConversationPageKeys()) {
        if (byKey.has(conv.pageKey)) continue;
        const entry = pageToggles[conv.pageKey] || {};
        byKey.set(conv.pageKey, {
          pageKey: conv.pageKey,
          platform: null,
          label: null,
          source: "conversation",
          messagesEnabled: entry.messages !== false,
          commentsEnabled: entry.comments !== false,
        });
      }
      for (const [key, entry] of Object.entries(pageToggles)) {
        if (byKey.has(key)) continue;
        byKey.set(key, {
          pageKey: key,
          platform: null,
          label: null,
          source: "stored",
          messagesEnabled: entry.messages !== false,
          commentsEnabled: entry.comments !== false,
        });
      }

      return NextResponse.json({
        channels,
        pages: Array.from(byKey.values()),
      });
    } catch (error) {
      logger.error("Failed to fetch channel toggles:", error);
      return NextResponse.json(
        { error: "Failed to fetch channel toggles" },
        { status: 500 }
      );
    }
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "channels:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }
    try {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
      }
      const raw = body as Record<string, unknown>;
      const allowedKeys = ["channel", "enabled", "pageKey", "messages", "comments"];
      for (const key of Object.keys(raw)) {
        if (!allowedKeys.includes(key)) {
          return NextResponse.json({ error: `Unknown field: ${key}` }, { status: 400 });
        }
      }
      const hasChannel = raw.channel !== undefined;
      const hasPage = raw.pageKey !== undefined;
      if (hasChannel === hasPage) {
        return NextResponse.json(
          { error: "Exactly one of channel or pageKey is required" },
          { status: 400 }
        );
      }

      const existing = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });
      const existingRaw = (existing || {}) as Record<string, unknown>;
      const channelToggles = parseChannelToggles(existingRaw.channelAiToggles);
      const pageToggles = parsePageToggles(existingRaw.pageAiToggles);

      if (hasChannel) {
        if (!isKnownChannel(raw.channel) || typeof raw.enabled !== "boolean") {
          return NextResponse.json(
            { error: "channel must be a known channel and enabled must be a boolean" },
            { status: 400 }
          );
        }
        if (raw.messages !== undefined || raw.comments !== undefined) {
          return NextResponse.json(
            { error: "messages/comments belong to a pageKey target, not a channel target" },
            { status: 400 }
          );
        }
        const next = setChannelToggle(channelToggles, raw.channel, raw.enabled);
        await prisma.settings.upsert({
          where: { businessId: auth.businessId },
          update: { channelAiToggles: next },
          create: { businessId: auth.businessId, channelAiToggles: next },
        });
        return NextResponse.json({
          ok: true,
          channel: raw.channel,
          enabled: raw.enabled,
        });
      }

      // Page target.
      if (!isValidPageKey(raw.pageKey)) {
        return NextResponse.json({ error: "pageKey must be a non-empty string (max 200 chars, no whitespace)" }, { status: 400 });
      }
      if (raw.enabled !== undefined) {
        return NextResponse.json(
          { error: "enabled belongs to a channel target; use messages/comments for a page" },
          { status: 400 }
        );
      }
      if (typeof raw.messages !== "boolean" && typeof raw.comments !== "boolean") {
        return NextResponse.json(
          { error: "At least one of messages or comments (boolean) is required" },
          { status: 400 }
        );
      }
      let pageKey = (raw.pageKey as string).trim();
      // Normalise a social-account id to its accountRef (the key the
      // enforcement points read). A key matching neither an id nor a
      // ref is stored as given — the settings doc is tenant-scoped,
      // so it can only ever affect this tenant.
      const accounts = await loadAccounts(auth.businessId as string);
      const byId = accounts.find((a) => a.id === pageKey);
      if (byId && byId.accountRef) pageKey = byId.accountRef;

      const patch: { messages?: boolean; comments?: boolean } = {};
      if (typeof raw.messages === "boolean") patch.messages = raw.messages;
      if (typeof raw.comments === "boolean") patch.comments = raw.comments;
      const next = setPageToggle(pageToggles, pageKey, patch);
      await prisma.settings.upsert({
        where: { businessId: auth.businessId },
        update: { pageAiToggles: next },
        create: { businessId: auth.businessId, pageAiToggles: next },
      });
      const entry = next[pageKey] || {};
      return NextResponse.json({
        ok: true,
        pageKey,
        messagesEnabled: entry.messages !== false,
        commentsEnabled: entry.comments !== false,
      });
    } catch (error) {
      logger.error("Failed to update channel toggles:", error);
      return NextResponse.json(
        { error: "Failed to update channel toggles" },
        { status: 500 }
      );
    }
  });
}
