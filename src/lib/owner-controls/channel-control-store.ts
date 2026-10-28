/**
 * CHANNEL + COMMENT CONTROL STORE — adapter seam (settled model).
 *
 * Real repo path (NEW file): src/lib/owner-controls/channel-control-store.ts
 * Adapter seam only: NO Firestore import, NO Prisma model invented
 * here. The merger wires this seam to the business settings document
 * the repo already uses (the same document Leg C's message-controls
 * store reads), or to a new collection ONLY once the single final
 * rules package carries a fragment for it. Until then, no new
 * collection name in this file is a deployed rule — the collection
 * names below are PROPOSAL.
 *
 * TRAIL RULE (one trail at go-live, Leg E canonical shape): trail
 * entries written here MUST be reconciled to Leg E's canonical
 * audit-trail shape before go-live. Do not run two live trails. The
 * entry shape in this file mirrors Leg E's fields (business, actor,
 * timestamp, target, before/after); the merger maps it, it does not
 * silently duplicate it.
 *
 * TRANSACTION RULE (mirrors Leg E): a control change and its trail
 * entry are written together. If the trail write fails, the control
 * change fails. Never persist a control change trailless.
 */

import type {
  ChannelControlMap,
  ChannelControlState,
  ChannelControlAuditEntry,
} from "./channel-controls";
import type { CommentMode, CommentModeAuditEntry } from "./comment-controls";

/** The persisted owner-control document for one business. */
export interface OwnerControlDoc {
  businessId: string;
  /** Per-channel control states, keyed by normalised channel id. */
  channelControls: ChannelControlMap;
  /** Comment handling mode for the business (see comment-controls). */
  commentMode: CommentMode;
  /** Audit entries, newest last. Channel entries and comment-mode
   *  entries share one trail (Leg E one-trail rule at go-live). */
  audit: Array<ChannelControlAuditEntry | CommentModeAuditEntry>;
}

/** Minimal doc adapter the merger supplies. No DB type is assumed. */
export interface OwnerControlDocAdapter {
  getDoc(businessId: string): Promise<OwnerControlDoc | null>;
  /**
   * Replace the doc atomically (transaction where the backend
   * supports it). Implementations must fail — not partially apply —
   * when the trail write cannot be persisted alongside the change.
   */
  putDoc(doc: OwnerControlDoc): Promise<void>;
}

export function emptyDoc(businessId: string): OwnerControlDoc {
  return { businessId, channelControls: {}, commentMode: "auto", audit: [] };
}

/** In-memory adapter for tests and for the harness only. Never a
 *  production backend: it holds no data across processes. */
export class InMemoryOwnerControlDocAdapter implements OwnerControlDocAdapter {
  private docs = new Map<string, OwnerControlDoc>();

  async getDoc(businessId: string): Promise<OwnerControlDoc | null> {
    const doc = this.docs.get(businessId);
    return doc ? structuredClone(doc) : null;
  }

  async putDoc(doc: OwnerControlDoc): Promise<void> {
    this.docs.set(doc.businessId, structuredClone(doc));
  }
}

export interface WriteChannelControlResult {
  ok: true;
  doc: OwnerControlDoc;
}

export interface WriteChannelControlFailure {
  ok: false;
  error: "invalid_business" | "invalid_channel";
}

/**
 * Write one channel's control state + its audit entry (if the mode
 * actually changed) in a single doc write. Other channels in the doc
 * are carried over untouched — this function never clears a channel
 * it was not asked to change.
 */
export async function writeChannelControl(
  adapter: OwnerControlDocAdapter,
  input: {
    businessId: string;
    state: ChannelControlState;
    audit: ChannelControlAuditEntry | null;
  }
): Promise<WriteChannelControlResult | WriteChannelControlFailure> {
  if (typeof input.businessId !== "string" || input.businessId.trim() === "") {
    return { ok: false, error: "invalid_business" };
  }
  if (typeof input.state.channel !== "string" || input.state.channel.trim() === "") {
    return { ok: false, error: "invalid_channel" };
  }
  const existing = (await adapter.getDoc(input.businessId)) ?? emptyDoc(input.businessId);
  const next: OwnerControlDoc = {
    businessId: input.businessId,
    channelControls: { ...existing.channelControls, [input.state.channel]: input.state },
    commentMode: existing.commentMode,
    audit: input.audit ? [...existing.audit, input.audit] : [...existing.audit],
  };
  await adapter.putDoc(next);
  return { ok: true, doc: next };
}

export interface WriteCommentModeResult {
  ok: true;
  doc: OwnerControlDoc;
}

export interface WriteCommentModeFailure {
  ok: false;
  error: "invalid_business" | "invalid_mode";
}

/**
 * Write the business comment mode. Comment mode is per BUSINESS, not
 * per channel: the settled model gives comments one default handling
 * (AI handles), with per-account auto-reply already existing at HEAD
 * for FB/IG. A per-channel comment mode is NOT invented here — if
 * the owner later wants it, it is a new decision, not a silent
 * extension of this field.
 */
export async function writeCommentMode(
  adapter: OwnerControlDocAdapter,
  input: {
    businessId: string;
    mode: CommentMode;
    changedAtMs: number;
    changedBy: string | null;
  }
): Promise<WriteCommentModeResult | WriteCommentModeFailure> {
  if (typeof input.businessId !== "string" || input.businessId.trim() === "") {
    return { ok: false, error: "invalid_business" };
  }
  if (input.mode !== "auto" && input.mode !== "approval" && input.mode !== "owner") {
    return { ok: false, error: "invalid_mode" };
  }
  const existing = (await adapter.getDoc(input.businessId)) ?? emptyDoc(input.businessId);
  const next: OwnerControlDoc = {
    businessId: input.businessId,
    channelControls: { ...existing.channelControls },
    commentMode: input.mode,
    audit: [
      ...existing.audit,
      {
        businessId: input.businessId,
        action: "comment_mode_change",
        beforeMode: existing.commentMode,
        afterMode: input.mode,
        changedAtMs: input.changedAtMs,
        changedBy: input.changedBy,
      } satisfies CommentModeAuditEntry,
    ],
  };
  await adapter.putDoc(next);
  return { ok: true, doc: next };
}
