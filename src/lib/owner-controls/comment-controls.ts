/**
 * COMMENT CONTROLS — pure module (settled model, 2026-10-28).
 *
 * Real repo path (NEW file): src/lib/owner-controls/comment-controls.ts
 * Pure: zero imports, zero I/O, zero invented platform behaviour.
 *
 * SETTLED MODEL (owner, 2026-10-28):
 * - COMMENTS are handled by the AI by default. Tenant owner
 *   intervention is NOT required for the comment section.
 * - Owner optional actions, each separate:
 *   (a) comment himself, if he ever wants to;
 *   (b) write a separate comment to a customer;
 *   (c) EDIT the AI's comment (edit option exists).
 *
 * RELATION TO HEAD (honest, read from HEAD inbox page):
 * HEAD already has a FB/IG comment approval queue: an AI-drafted
 * reply, editable as a DRAFT before sending, posted only on owner
 * approval ("nothing is posted until you approve it"), with an
 * "Enable auto-reply per account in Channels to skip approval" note.
 * That queue is NOT replaced by this module. This module adds the
 * missing MODE layer on top of it:
 *   auto     = AI handles comments (posts/answers) without owner
 *              approval — the settled default for NEW businesses.
 *   approval = AI drafts, owner approves/edits before posting —
 *              HEAD's current behaviour, preserved.
 *   owner    = AI posts nothing for comments; the owner posts.
 * MIGRATION (flagged, not silently flipped): existing businesses
 * keep their current approval behaviour until the owner flips the
 * mode to auto. Silently switching existing tenants to auto-post
 * would post unapproved comments live without their say-so.
 *
 * POSTED-COMMENT EDIT — hard limit, do not invent around it:
 * Editing a DRAFT before posting is already supported at HEAD and
 * is fully modelled here (original draft preserved in history).
 * Editing a comment AFTER it is posted depends on the platform:
 * most social platforms do not offer a comment-edit API. This
 * module therefore returns "platform_edit_not_supported" for a
 * posted edit unless the caller proves platform support with an
 * explicit `platformAllowsEdit: true` flag. No platform edit API
 * is invented here. Where editing is not supported, the honest
 * owner paths are: delete + repost (if the platform allows it and
 * the owner approves it), or leave the posted comment and post a
 * corrected follow-up comment. Neither is auto-chosen here.
 */

/** How this business handles comments. */
export type CommentMode = "auto" | "approval" | "owner";

/** The settled default for a business with no mode record. */
export const DEFAULT_COMMENT_MODE: CommentMode = "auto";

export function isCommentMode(value: unknown): value is CommentMode {
  return value === "auto" || value === "approval" || value === "owner";
}

export interface CommentModeAuditEntry {
  businessId: string;
  action: "comment_mode_change";
  beforeMode: CommentMode;
  afterMode: CommentMode;
  changedAtMs: number;
  changedBy: string | null;
}

/** A comment the AI drafted (not yet posted). */
export interface CommentDraft {
  commentId: string;
  businessId: string;
  /** The customer comment this draft answers. */
  originalCommentText: string;
  /** Current draft text (owner-editable before posting). */
  draftText: string;
  /** Every prior draft text, oldest first. Never deleted by editing. */
  draftHistory: string[];
  /** Who last edited the draft: "ai" or a dashboard user id. */
  lastEditedBy: string;
  editedAtMs: number;
}

export interface EditDraftResult {
  ok: true;
  draft: CommentDraft;
}

export interface EditDraftFailure {
  ok: false;
  error: "invalid_comment" | "invalid_business" | "empty_text";
}

/**
 * Owner edits an AI draft BEFORE posting. The previous text is kept
 * in draftHistory, so an edit never destroys the AI's original.
 * Editing a draft never posts it (posting is a separate approval /
 * auto step, decided by comment mode).
 */
export function editCommentDraft(input: {
  draft: CommentDraft;
  newText: string;
  editedBy: string;
  editedAtMs: number;
}): EditDraftResult | EditDraftFailure {
  if (typeof input.draft.commentId !== "string" || input.draft.commentId.trim() === "") {
    return { ok: false, error: "invalid_comment" };
  }
  if (typeof input.draft.businessId !== "string" || input.draft.businessId.trim() === "") {
    return { ok: false, error: "invalid_business" };
  }
  if (typeof input.newText !== "string" || input.newText.trim() === "") {
    return { ok: false, error: "empty_text" };
  }
  return {
    ok: true,
    draft: {
      ...input.draft,
      draftHistory: [...input.draft.draftHistory, input.draft.draftText],
      draftText: input.newText,
      lastEditedBy: input.editedBy,
      editedAtMs: input.editedAtMs,
    },
  };
}

/** An owner-authored comment, separate from any AI draft. */
export interface OwnerComment {
  commentId: string;
  businessId: string;
  /** The customer comment this answers, if it is a reply. Null for
   *  a standalone owner comment. */
  inReplyToCommentId: string | null;
  text: string;
  authoredBy: string;
  authoredAtMs: number;
  /** True when the owner wrote this INSTEAD of using an AI draft. */
  replacesAiDraft: boolean;
}

export interface OwnerCommentFailure {
  ok: false;
  error: "invalid_comment" | "invalid_business" | "empty_text";
}

/**
 * Owner writes his own comment (a) himself, or (b) as a separate
 * comment to a customer. This never overwrites an AI draft: if it
 * replaces a draft, the draft is marked replaced, not deleted, by
 * the caller (the draft record itself is untouched here).
 */
export function writeOwnerComment(input: {
  commentId: string;
  businessId: string;
  inReplyToCommentId?: string | null;
  text: string;
  authoredBy: string;
  authoredAtMs: number;
  replacesAiDraft: boolean;
}): { ok: true; comment: OwnerComment } | OwnerCommentFailure {
  if (typeof input.commentId !== "string" || input.commentId.trim() === "") {
    return { ok: false, error: "invalid_comment" };
  }
  if (typeof input.businessId !== "string" || input.businessId.trim() === "") {
    return { ok: false, error: "invalid_business" };
  }
  if (typeof input.text !== "string" || input.text.trim() === "") {
    return { ok: false, error: "empty_text" };
  }
  return {
    ok: true,
    comment: {
      commentId: input.commentId,
      businessId: input.businessId,
      inReplyToCommentId: input.inReplyToCommentId ?? null,
      text: input.text,
      authoredBy: input.authoredBy,
      authoredAtMs: input.authoredAtMs,
      replacesAiDraft: input.replacesAiDraft,
    },
  };
}

// ---------------------------------------------------------------------------
// What the AI may do with a comment, given the business mode
// ---------------------------------------------------------------------------

export type CommentAiAction =
  | { action: "ai_post"; reason: "mode_auto" }
  | { action: "ai_draft_only"; reason: "mode_approval" }
  | { action: "ai_must_not_post"; reason: "mode_owner" };

/**
 * Decide what the AI may do with a new comment. "ai_post" means the
 * AI handles it without owner approval (settled default). "ai_draft_only"
 * means the AI drafts and waits (HEAD approval queue). "ai_must_not_post"
 * means the owner posts comments himself.
 */
export function decideCommentAiAction(mode: CommentMode): CommentAiAction {
  if (mode === "auto") return { action: "ai_post", reason: "mode_auto" };
  if (mode === "approval") return { action: "ai_draft_only", reason: "mode_approval" };
  return { action: "ai_must_not_post", reason: "mode_owner" };
}

// ---------------------------------------------------------------------------
// Posted-comment edit (platform-limited — see header)
// ---------------------------------------------------------------------------

export type EditPostedCommentResult =
  | { ok: true; editedText: string }
  | { ok: false; error: "platform_edit_not_supported" | "empty_text" | "invalid_comment" };

/**
 * Edit a comment that is ALREADY posted. Only allowed when the
 * caller proves the platform supports editing that comment
 * (platformAllowsEdit === true, supplied by the platform adapter,
 * never assumed). Otherwise blocked with a machine reason — the
 * caller must then offer delete + repost or a corrected follow-up
 * comment, with owner approval, instead of pretending an edit
 * happened.
 */
export function editPostedComment(input: {
  commentId: string;
  newText: string;
  platformAllowsEdit: boolean;
}): EditPostedCommentResult {
  if (typeof input.commentId !== "string" || input.commentId.trim() === "") {
    return { ok: false, error: "invalid_comment" };
  }
  if (typeof input.newText !== "string" || input.newText.trim() === "") {
    return { ok: false, error: "empty_text" };
  }
  if (input.platformAllowsEdit !== true) {
    return { ok: false, error: "platform_edit_not_supported" };
  }
  return { ok: true, editedText: input.newText };
}
