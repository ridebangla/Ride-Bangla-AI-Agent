/**
 * Leg J — per-channel / per-page AI toggles (STAGED).
 *
 * Tenant-scoped settings that sit BESIDE, never instead of, the two
 * switches that already exist at HEAD:
 *
 *   - the GLOBAL kill-switch (`settings.aiEnabled`, Settings > AI) — off
 *     silences the agent everywhere;
 *   - the PER-CHAT pause (`conversations.aiEnabled`, the dashboard
 *     takeover switch) — off silences one thread.
 *
 * This module adds the third layer, and a second, independent axis for
 * comments. It is pure (no imports, no I/O, no dates, no randomness) so
 * every rule below is harness-testable without Firestore.
 *
 * STORAGE (on the tenant's own settings doc; see the models/firestore
 * diffs): two plain objects, both defaulting to "everything ON":
 *
 *   channelAiToggles: { [channel]: boolean }   // message replies
 *   pageAiToggles:    { [pageKey]: { messages?: boolean,
 *                                    comments?: boolean } }
 *
 * A missing key, a missing field, or a non-boolean value means ON.
 * Only an explicit `false` switches a surface off. That fail-open
 * reading is deliberate and matches the existing switches: absence of
 * a readable value is not a kill signal (the engine's own
 * `settings.aiEnabled !== false` rule, and the outage philosophy that
 * an unreadable state must not strand a visitor).
 *
 * PAGE KEYS (canonical, in lookup order):
 *   - Meta messages: the conversation's `metadata.metaPageId` — for
 *     Messenger/Instagram this IS the page/IG account's `accountRef`
 *     (the Meta handler stores the recipient id there).
 *   - Website widget: the conversation's `metadata.sourceSite`
 *     (the Origin/Referer host the widget route records), so a tenant
 *     with the widget on several sites can switch AI off on one site.
 *   - FB/IG comments: the connected social account's `accountRef`
 *     (for Facebook, the `<pageId>` prefix of the comment's parentRef).
 * The route normalises a social-account id to its accountRef on write,
 * and decision functions accept a list of candidate keys, so a toggle
 * stored under either spelling still bites.
 *
 * PRECEDENCE — AND semantics, most-specific reason reported first.
 * A reply is allowed ONLY if every applicable layer is ON. An ON at a
 * narrower scope NEVER re-enables a broader OFF:
 *
 *   allowed = global ON  AND  per-chat ON  AND  per-page ON
 *             AND  per-channel ON
 *
 *   blockedBy (first blocking layer, in this order):
 *     1. "global"  — settings.aiEnabled === false
 *     2. "chat"    — conversations.aiEnabled === false (takeover)
 *     3. "page"    — this page's switch is false
 *     4. "channel" — this channel's switch is false
 *
 * This precedence is a LEG J DECISION, not something read out of HEAD:
 * HEAD has no per-channel or per-page switch, so no existing precedence
 * covers them. The alternative — "specific overrides general", where a
 * page ON could resurrect a channel the tenant switched off — was
 * considered and rejected: it would let a narrow switch silently undo
 * a broader one. AND semantics are fail-closed and need no tie-break
 * rule. OWNER DECISION: confirm AND semantics, or choose
 * specific-overrides-general instead (the decision functions are the
 * only place that would change).
 *
 * COMMENTS ARE AN INDEPENDENT AXIS. A comment reply is allowed iff
 * global ON and that page's `comments` switch is ON. It does NOT
 * consult the channel switch, the message switch, or the per-chat
 * pause (a comment is not a conversation thread), and the message
 * switch does NOT consult the comment switch. Switching comments off
 * on a page leaves that page's DMs answering, and vice versa.
 * The existing per-account `autoReply` setting is NOT replaced: it
 * still decides auto-post vs draft-for-approval. The comment toggle
 * sits ABOVE it — auto-post additionally requires comments ON, and
 * draft generation is skipped entirely while comments are off.
 *
 * HISTORY IS NEVER DELETED OR HIDDEN by any toggle here. A blocked
 * message is still stored as a customer message (the engine's existing
 * silent-store path); a blocked comment is still stored as a comment
 * ticket without a draft (the comments module's existing
 * store-without-draft path). Toggling off stops NEW agent replies
 * only; toggling back on resumes with full history intact.
 *
 * NO ORDER, BILLING, LIMIT, OR FARE LOGIC lives here. These toggles
 * do not count against any message quota, do not confirm anything,
 * and never invent a price, a page, or a channel.
 */

/** Channel names the platform actually creates conversations on. Source:
 *  the deliver.ts send switch (whatsapp, telegram, sms, email,
 *  messenger, instagram, x, widget, api, phone, facebook) plus the
 *  widget/voice/vision routes' literal channel "widget" and the Meta
 *  handler's "messenger"/"instagram". The route rejects any channel
 *  outside this list; the decision functions treat an unknown channel
 *  as ON unless it is explicitly listed false (forward-compatible). */
export const MESSAGE_CHANNELS = [
  "widget",
  "messenger",
  "instagram",
  "whatsapp",
  "telegram",
  "sms",
  "email",
  "phone",
  "x",
  "facebook",
  "api",
] as const;

export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export function isKnownChannel(value: unknown): value is MessageChannel {
  return (
    typeof value === "string" &&
    (MESSAGE_CHANNELS as readonly string[]).includes(value)
  );
}

/** channel -> enabled. Missing key = ON. */
export type ChannelToggles = Record<string, boolean>;

export interface PageToggle {
  messages?: boolean;
  comments?: boolean;
}

/** pageKey -> switches. Missing key/field = ON. */
export type PageToggles = Record<string, PageToggle>;

/** Coerce an unknown stored value into ChannelToggles. Only boolean
 *  values survive; anything else (null, strings, nested objects,
 *  arrays) is dropped, never interpreted as off. */
export function parseChannelToggles(value: unknown): ChannelToggles {
  const out: ChannelToggles = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

/** Coerce an unknown stored value into PageToggles. A page entry that
 *  is not an object, or whose fields are not booleans, contributes
 *  nothing (both switches read ON). */
export function parsePageToggles(value: unknown): PageToggles {
  const out: PageToggles = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const entry = v as Record<string, unknown>;
    const page: PageToggle = {};
    if (typeof entry.messages === "boolean") page.messages = entry.messages;
    if (typeof entry.comments === "boolean") page.comments = entry.comments;
    out[key] = page;
  }
  return out;
}

/**
 * Page keys for one conversation's metadata, most specific first.
 * Reads `metaPageId` (Meta pages) then `sourceSite` (widget sites).
 * Unknown shapes, empty strings, and over-long values yield no key —
 * an unkeyed conversation is gated by its channel switch only.
 */
export function extractPageKeys(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const record = metadata as Record<string, unknown>;
  const keys: string[] = [];
  for (const field of ["metaPageId", "sourceSite"]) {
    const v = record[field];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed && trimmed.length <= 200 && !keys.includes(trimmed)) {
        keys.push(trimmed);
      }
    }
  }
  return keys;
}

/**
 * Page key for one FB/IG comment. Prefers the resolved social
 * account's accountRef; falls back to the `<pageId>` prefix of a
 * Facebook parentRef (`<pageId>_<postId>`); otherwise null, meaning
 * the comment cannot be page-gated (it still respects the global
 * switch, and is still stored).
 */
export function commentPageKey(input: {
  accountRef?: string | null;
  parentRef?: string | null;
  platform?: string | null;
}): string | null {
  const ref = (input.accountRef || "").trim();
  if (ref) return ref.slice(0, 200);
  const parent = (input.parentRef || "").trim();
  if (input.platform === "facebook" && parent.includes("_")) {
    const prefix = parent.split("_")[0].trim();
    if (prefix) return prefix.slice(0, 200);
  }
  return null;
}

/** True when any candidate key is explicitly switched off for messages. */
export function isPageMessagesOff(
  pageToggles: PageToggles,
  pageKeys: readonly string[]
): boolean {
  return pageKeys.some((k) => pageToggles[k]?.messages === false);
}

/** True when any candidate key is explicitly switched off for comments. */
export function isPageCommentsOff(
  pageToggles: PageToggles,
  pageKeys: readonly string[]
): boolean {
  return pageKeys.some((k) => pageToggles[k]?.comments === false);
}

export type BlockReason = "global" | "chat" | "channel" | "page";

export interface MessageReplyDecision {
  allowed: boolean;
  blockedBy: BlockReason | null;
}

/**
 * The message-reply gate. Callers pass the already-resolved global and
 * per-chat states (they are owned by the engine's existing blocks);
 * this function adds the channel/page layers and reports the first
 * blocking layer in precedence order: global, chat, page, channel.
 * `globalOn`/`chatOn` are booleans, not raw settings values, so the
 * caller's own missing-means-on rule stays in exactly one place.
 */
export function decideMessageReply(input: {
  globalOn: boolean;
  chatOn: boolean;
  channel: string;
  pageKeys: readonly string[];
  channelToggles: ChannelToggles;
  pageToggles: PageToggles;
}): MessageReplyDecision {
  if (!input.globalOn) return { allowed: false, blockedBy: "global" };
  if (!input.chatOn) return { allowed: false, blockedBy: "chat" };
  if (isPageMessagesOff(input.pageToggles, input.pageKeys)) {
    return { allowed: false, blockedBy: "page" };
  }
  if (input.channelToggles[input.channel] === false) {
    return { allowed: false, blockedBy: "channel" };
  }
  return { allowed: true, blockedBy: null };
}

export interface CommentReplyDecision {
  allowed: boolean;
  blockedBy: "global" | "page" | null;
}

/**
 * The comment-reply gate — deliberately independent of the message
 * gate: no channel switch, no message switch, no per-chat pause.
 * `autoReply` is NOT an input here: the caller applies it separately
 * (auto-post requires allowed AND autoReply; drafting requires
 * allowed; a human's own manually-written reply is not an agent reply
 * and is not gated by this function at all — see the approve guard in
 * comments.ts, which blocks only an UNMODIFIED AI draft).
 */
export function decideCommentReply(input: {
  globalOn: boolean;
  pageKey: string | null;
  pageToggles: PageToggles;
}): CommentReplyDecision {
  if (!input.globalOn) return { allowed: false, blockedBy: "global" };
  if (input.pageKey && isPageCommentsOff(input.pageToggles, [input.pageKey])) {
    return { allowed: false, blockedBy: "page" };
  }
  return { allowed: true, blockedBy: null };
}

/**
 * Validate a pageKey supplied to the toggles route. Format-only: the
 * tenant-scoped settings doc is the isolation boundary (a tenant can
 * only write their own doc), so an unknown-but-well-formed key harms
 * nobody else; the GET endpoint lists the tenant's real pages so the
 * UI never has to guess keys.
 */
export function isValidPageKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return false;
  // Control characters and whitespace inside a key are never valid.
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return false;
  return true;
}

/** Immutable single-channel update (route + harness share this). */
export function setChannelToggle(
  current: ChannelToggles,
  channel: string,
  enabled: boolean
): ChannelToggles {
  return { ...current, [channel]: enabled };
}

/** Immutable single-page update: merges fields, never wipes the other
 *  switch on the same page. */
export function setPageToggle(
  current: PageToggles,
  pageKey: string,
  patch: PageToggle
): PageToggles {
  const prev = current[pageKey] || {};
  return { ...current, [pageKey]: { ...prev, ...patch } };
}
