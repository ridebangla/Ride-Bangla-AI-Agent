/**
 * Leg C (Presswayy-video round 2) — page-post comments in the unified inbox.
 *
 * PURE module: no Prisma, no fetch, no platform calls. Every function below
 * is unit-testable with plain objects, so the harness runs without a repo
 * toolchain or live platform access.
 *
 * What HEAD already had (verified from code, not assumed):
 *   - FB/IG comment ingestion exists twice: the Meta webhook stores FB feed
 *     comments via `handleCommentEvent` (src/lib/social/comments.ts), and
 *     the engagement sync stores FB + IG post comments directly as
 *     `socialInteraction` rows (src/lib/social/engagement.ts).
 *   - A comment approval queue already exists on the SAME dashboard page
 *     (Inbox > Comments tab, GET /api/social/comments, approve/dismiss
 *     routes) — but it is a SEGREGATED queue: the facebook/instagram
 *     message tabs (GET /api/inbox) query `conversation` rows only, so a
 *     page-post comment never appears alongside messages on its channel.
 *   - A platform reply path already exists (`postReply` in engagement.ts,
 *     POST /{comment-id}/comments for fb_comment/ig_comment targets) and
 *     the approve route already uses it.
 *
 * What this leg adds (staged diffs LC-01..LC-06):
 *   1. Normalisation of a stored `socialInteraction` (kind "comment") into
 *      a unified inbox item, distinctly labelled by channel and post.
 *   2. A deterministic merge of message items + comment items into one
 *      per-channel list, newest first.
 *   3. Reply gating: AI actions (draft generation, auto-post) are blocked
 *      by the existing global AI kill-switch and by any per-thread /
 *      per-channel AI pause that a caller supplies. Manual staff replies
 *      are NOT blocked by AI toggles — see `decideCommentReplyGate` for
 *      the takeover-consistent reasoning, and LEG-REPORT §5 decision D2
 *      for the owner call that would change it.
 *   4. Strict reply-account resolution: never fall back to the first
 *      account of a platform (HEAD's approve path did), which could post
 *      a reply through the wrong Page/account when several are connected.
 *
 * Deliberately NOT in this module (see LEG-REPORT):
 *   - No auto-reply default is introduced. Auto-post still requires the
 *     tenant's existing per-account `autoReply` setting.
 *   - No 24-hour-window claim: nothing in HEAD code states a window rule
 *     for public comment replies, and DMs and public comments are
 *     different surfaces. Whether any Meta window applies to comment
 *     replies is an open verification item (LEG-REPORT §7), never asserted
 *     here.
 *   - No per-channel toggle layer is built here (that is the toggles
 *     leg's work). Callers pass `perChannelEnabled` when that layer
 *     exists; `null`/`undefined` today means "no channel gate configured"
 *     and is NOT treated as a block.
 *   - No demo/competitor data, no invented copy: every user-facing string
 *     in the staged UI diffs is a PROPOSAL for owner approval.
 */

export type CommentPlatform = "facebook" | "instagram";

export type ReplyTargetKind = "fb_comment" | "ig_comment";

/** Minimal shape of a stored socialInteraction row (kind "comment"). */
export interface RawCommentInput {
  id: string;
  platform: string;
  kind: string;
  externalId: string;
  /** Post/media id the comment was left on (FB "<pageId>_<postId>" or IG media id). */
  parentRef: string;
  customerRef: string;
  /**
   * Legacy stored form: "<authorName>: <text>". New rows (LC-02) also carry
   * `authorName` + `commentText` separately; those win when present.
   */
  content: string;
  likes?: number | null;
  replied: boolean;
  repliedAt?: Date | string | null;
  replyRef?: string | null;
  draftReply?: string | null;
  createdAt: Date | string;
  /** New in LC-02 (optional — legacy rows do not have these). */
  authorName?: string | null;
  commentText?: string | null;
  socialAccountId?: string | null;
  businessId?: string | null;
}

/** One comment, normalised for the unified inbox list. */
export interface UnifiedCommentItem {
  itemKind: "comment";
  /** socialInteraction row id — the id the reply routes take. */
  id: string;
  platform: CommentPlatform;
  /** Inbox channel value, identical to the message-tab channel. */
  channel: CommentPlatform;
  /** Distinct channel label shown on the row (never bare "comment"). */
  channelLabel: string;
  /** Platform comment id — the id a reply is posted against. */
  commentId: string;
  /** Raw post/media ref, shown verbatim (never a guessed post text). */
  postRef: string;
  /** Post label: "Post <parentRef>", or "Post unknown" when absent. */
  postLabel: string;
  authorRef: string;
  authorName: string;
  text: string;
  likes: number;
  replied: boolean;
  repliedAt: string | null;
  replyRef: string;
  draftReply: string;
  createdAt: string;
  /** Sort key = the comment's own creation time. */
  sortAt: string;
  /** Actionable in the inbox = not yet replied (incl. not dismissed). */
  unread: boolean;
  replyTargetKind: ReplyTargetKind;
}

export interface UnifiedMessageItem {
  itemKind: "message";
  sortAt: string;
  // All other fields pass through untouched from the /api/inbox row.
  [key: string]: unknown;
}

export type UnifiedInboxItem = UnifiedMessageItem | UnifiedCommentItem;

const PLATFORM_LABEL: Record<CommentPlatform, string> = {
  facebook: "Facebook comment",
  instagram: "Instagram comment",
};

const REPLY_TARGET: Record<CommentPlatform, ReplyTargetKind> = {
  facebook: "fb_comment",
  instagram: "ig_comment",
};

function isCommentPlatform(value: string): value is CommentPlatform {
  return value === "facebook" || value === "instagram";
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(value).toISOString();
}

/**
 * Split a stored comment into author + text.
 *
 * Preference order (never invents either part):
 *   1. Explicit `commentText` (LC-02 rows) + explicit `authorName`.
 *   2. Legacy "<author>: <text>" content, split at the FIRST ": ".
 *   3. No separator: the whole content is the text, author is "".
 */
export function parseCommentContent(
  content: string,
  authorName?: string | null,
  commentText?: string | null
): { authorName: string; text: string } {
  const raw = typeof content === "string" ? content : "";
  if (typeof commentText === "string") {
    return {
      authorName: typeof authorName === "string" ? authorName.trim() : "",
      text: commentText,
    };
  }
  const sep = raw.indexOf(": ");
  if (sep > 0) {
    return { authorName: raw.slice(0, sep), text: raw.slice(sep + 2) };
  }
  return {
    authorName: typeof authorName === "string" ? authorName.trim() : "",
    text: raw,
  };
}

/**
 * Normalise one stored interaction into a unified inbox comment item.
 * Returns null (dropped, counted by the caller) when the row cannot be
 * shown or replied to as a channel comment:
 *   - kind is not "comment" (messages/posts/likes are not comments);
 *   - platform is not facebook/instagram (no FB/IG comment reply path);
 *   - externalId is empty (a reply has no platform target to post to).
 */
export function normaliseComment(raw: RawCommentInput): UnifiedCommentItem | null {
  if (!raw || raw.kind !== "comment") return null;
  if (!isCommentPlatform(raw.platform)) return null;
  const commentId = (raw.externalId || "").trim();
  if (!commentId) return null;
  const createdAt = toIso(raw.createdAt);
  if (!createdAt) return null;
  const { authorName, text } = parseCommentContent(
    raw.content,
    raw.authorName,
    raw.commentText
  );
  const postRef = typeof raw.parentRef === "string" ? raw.parentRef : "";
  return {
    itemKind: "comment",
    id: raw.id,
    platform: raw.platform,
    channel: raw.platform,
    channelLabel: PLATFORM_LABEL[raw.platform],
    commentId,
    postRef,
    postLabel: postRef ? `Post ${postRef}` : "Post unknown",
    authorRef: typeof raw.customerRef === "string" ? raw.customerRef : "",
    authorName,
    text,
    likes: typeof raw.likes === "number" && Number.isFinite(raw.likes) ? raw.likes : 0,
    replied: raw.replied === true,
    repliedAt: toIso(raw.repliedAt),
    replyRef: typeof raw.replyRef === "string" ? raw.replyRef : "",
    draftReply: typeof raw.draftReply === "string" ? raw.draftReply : "",
    createdAt,
    sortAt: createdAt,
    unread: raw.replied !== true,
    replyTargetKind: REPLY_TARGET[raw.platform],
  };
}

/** Normalise a batch; returns items + how many rows were dropped. */
export function normaliseComments(
  rows: RawCommentInput[]
): { items: UnifiedCommentItem[]; skipped: number } {
  const items: UnifiedCommentItem[] = [];
  let skipped = 0;
  for (const row of rows) {
    const item = normaliseComment(row);
    if (item) items.push(item);
    else skipped++;
  }
  return { items, skipped };
}

/**
 * Merge message rows (from /api/inbox) with normalised comment items into
 * one list, newest first. Ties break deterministically: messages before
 * comments, then id ascending — so the same inputs always render the same
 * order and no item is silently dropped by the merge.
 */
export function mergeInboxItems(
  messages: Array<Record<string, unknown>>,
  comments: UnifiedCommentItem[]
): { items: UnifiedInboxItem[]; messageCount: number; commentCount: number; pendingCommentCount: number } {
  const messageItems: UnifiedMessageItem[] = messages.map((m) => {
    const updatedAt = toIso((m["updatedAt"] as Date | string | undefined) ?? null);
    const createdAt = toIso((m["createdAt"] as Date | string | undefined) ?? null);
    return { ...m, itemKind: "message", sortAt: updatedAt || createdAt || "" };
  });
  const items: UnifiedInboxItem[] = [...messageItems, ...comments];
  items.sort((a, b) => {
    const ta = new Date(a.sortAt).getTime();
    const tb = new Date(b.sortAt).getTime();
    if (tb !== ta) return tb - ta;
    if (a.itemKind !== b.itemKind) return a.itemKind === "message" ? -1 : 1;
    const ida = String((a as { id?: unknown }).id ?? "");
    const idb = String((b as { id?: unknown }).id ?? "");
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });
  return {
    items,
    messageCount: messageItems.length,
    commentCount: comments.length,
    pendingCommentCount: comments.filter((c) => !c.replied).length,
  };
}

/** In-memory search over a normalised comment window (author + text). */
export function filterCommentsBySearch(
  comments: UnifiedCommentItem[],
  query: string
): UnifiedCommentItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return comments;
  return comments.filter(
    (c) =>
      c.authorName.toLowerCase().includes(q) || c.text.toLowerCase().includes(q)
  );
}

// ---------------------------------------------------------------------------
// Reply gating
// ---------------------------------------------------------------------------

export type CommentReplyAction = "draft" | "auto_post" | "manual_reply";

export interface CommentReplyGateInput {
  /**
   * Global kill-switch (settings.aiEnabled). Engine semantics are honoured:
   * `false` = off; anything else (true / missing / null) = on. Callers must
   * pass the real settings value, never a default of false.
   */
  globalAiEnabled?: boolean | null;
  /**
   * Per-thread AI pause (a conversation's aiEnabled). Comments have no
   * conversation, so callers pass null today; the parameter exists so a
   * future per-comment pause plugs in without changing this function.
   */
  perThreadAiEnabled?: boolean | null;
  /**
   * Per-channel AI toggle (the toggles leg's layer). Null/undefined today
   * = no channel gate configured = NOT a block. Never default this to
   * false: a missing toggle must not silently disable a channel.
   */
  perChannelEnabled?: boolean | null;
  /** The tenant's per-account autoReply setting (auto_post only). */
  autoReplyEnabled?: boolean;
  action: CommentReplyAction;
}

export interface CommentReplyGateDecision {
  allowed: boolean;
  reason: string | null;
  /** Which gates were actually consulted, for logging / UI honesty. */
  gatesChecked: {
    globalAiOff: boolean;
    threadPaused: boolean;
    channelPaused: boolean;
  };
}

/**
 * Decide whether a comment-reply action may proceed.
 *
 * Rules (pinned by the harness):
 *   - "draft" (AI writes a reply): blocked when the global kill-switch is
 *     off, when the thread is paused, or when the channel toggle is off.
 *   - "auto_post" (AI reply posted without staff approval): same blocks as
 *     draft, PLUS autoReplyEnabled must be exactly true. No autoReply
 *     setting, no auto-post — the tenant setting is the only auto-post
 *     authority (task scope: reply-ability, not auto-reply by default).
 *   - "manual_reply" (staff writes/sends from the inbox): NEVER blocked by
 *     an AI toggle. This is the takeover-consistent reading of the gates:
 *     the engine's own pause semantics store the customer message in
 *     silence precisely so the human team can answer it (Presswayy Leg D
 *     takeover: staff replies are the point of a pause). Blocking staff
 *     replies while AI is off would leave a taken-over thread unanswerable.
 *     The gate is still CHECKED (gatesChecked is returned) and the route
 *     records it; if the owner wants manual replies blocked under
 *     global-off, that is decision D2 in LEG-REPORT — a one-line change
 *     here, not a silent behaviour.
 */
export function decideCommentReplyGate(
  input: CommentReplyGateInput
): CommentReplyGateDecision {
  const globalAiOff = input.globalAiEnabled === false;
  const threadPaused = input.perThreadAiEnabled === false;
  const channelPaused = input.perChannelEnabled === false;
  const gatesChecked = { globalAiOff, threadPaused, channelPaused };

  if (input.action === "manual_reply") {
    return { allowed: true, reason: null, gatesChecked };
  }
  if (globalAiOff) return { allowed: false, reason: "global_ai_off", gatesChecked };
  if (threadPaused) return { allowed: false, reason: "thread_paused", gatesChecked };
  if (channelPaused) return { allowed: false, reason: "channel_paused", gatesChecked };
  if (input.action === "auto_post" && input.autoReplyEnabled !== true) {
    return { allowed: false, reason: "auto_reply_not_enabled", gatesChecked };
  }
  return { allowed: true, reason: null, gatesChecked };
}

// ---------------------------------------------------------------------------
// Reply routing (strict — never guess an account)
// ---------------------------------------------------------------------------

export interface ReplyAccount {
  id: string;
  platform: string;
}

export type ResolveAccountResult =
  | { account: ReplyAccount }
  | { error: "account_not_found" | "account_ambiguous" };

/**
 * Resolve the account a comment reply must be posted through.
 *
 *   1. A stored socialAccountId on the interaction wins, exactly.
 *      If that account is not among the tenant's active accounts, the
 *      result is account_not_found — NEVER a fallback to another account.
 *   2. Without a stored account: exactly one active account of the
 *      platform = that account; zero = not found; more than one =
 *      ambiguous (posting through an arbitrary one could reply from the
 *      wrong Page/profile).
 *
 * HEAD's approve path fell back to the FIRST account of the platform in
 * every case, which misroutes whenever several Pages are connected.
 */
export function resolveCommentAccount(
  accounts: ReplyAccount[],
  interaction: { platform: string; socialAccountId?: string | null }
): ResolveAccountResult {
  if (interaction.socialAccountId) {
    const stored = accounts.find((a) => a.id === interaction.socialAccountId);
    if (!stored) return { error: "account_not_found" };
    return { account: stored };
  }
  const candidates = accounts.filter((a) => a.platform === interaction.platform);
  if (candidates.length === 0) return { error: "account_not_found" };
  if (candidates.length > 1) return { error: "account_ambiguous" };
  return { account: candidates[0] };
}

/** Reply target kind for a platform, or null when there is no comment path. */
export function resolveReplyTarget(
  platform: string,
  commentId: string
): ReplyTargetKind | null {
  if (!commentId || !isCommentPlatform(platform)) return null;
  return REPLY_TARGET[platform];
}

/** Strict tenant equality for the reply path (null never matches). */
export function isSameTenant(
  businessId: string | null | undefined,
  interactionBusinessId: string | null | undefined
): boolean {
  if (!businessId || !interactionBusinessId) return false;
  return businessId === interactionBusinessId;
}
