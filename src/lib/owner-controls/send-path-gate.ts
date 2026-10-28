/**
 * SEND-PATH GATE HELPER — server-side, wired to the settings-doc adapter.
 * Repo path when applied: src/lib/owner-controls/send-path-gate.ts (NEW)
 *
 * This is the call-site helper the prior snippets described but never
 * wrote. It does NOT invent a store: it reads the already-wired
 * settings-doc adapter (settings.ownerControls — NO new collection),
 * then delegates the decision to the staged channel-send-gate
 * (decideChannelSend). It exists so every AI send path calls ONE
 * helper with the same fail-closed behaviour, instead of each path
 * re-implementing adapter reads and getting the throw behaviour wrong.
 *
 * FAIL-CLOSED, IN ORDER (never reordered):
 *  1. Existing suppressions in the caller run FIRST (global off,
 *     per-conversation off, Leg F delivery gate, platform windows,
 *     already-ordered, closed thread). This helper never overrides
 *     a suppression that already blocked, and an allow here never
 *     re-enables anything.
 *  2. Adapter throw / corrupt stored doc / Firestore down -> BLOCK
 *     the AI send. Silently defaulting corrupt data to AI would
 *     re-enable AI on a channel the owner holds.
 *  3. Cross-tenant doc (doc.businessId !== businessId) -> BLOCK.
 *  4. Otherwise decideChannelSend decides (channel gate, then for
 *     kind "offer" the Leg E offer control as well: enabled + not
 *     paused + owner-configured content; missing offer control
 *     blocks — the settled 2026-10-28 fail-closed send rule).
 *
 * NEVER GATED HERE (deliberate non-changes, verified against HEAD):
 *  - Owner dashboard replies: deliverOwnerReply (src/lib/channels/
 *    deliver.ts, HEAD 162 lines) delivers OWNER replies only and is
 *    NEVER routed through this helper. Owner answering while holding
 *    a channel is always allowed.
 *  - The inbox handleSendReply (role "admin") is likewise ungated.
 *
 * TESTABILITY: resolveOwnerControlsForSend takes the doc (or the
 * throw) as an argument instead of importing Firestore, so the
 * decision logic is unit-testable without a live store. The only
 * Firestore-touching wrapper is getOwnerControlsDocForSend(), which
 * the apply team wires to getSettingsOwnerControlAdapter().getDoc()
 * in the same batch as the wiring set — it is marked below and must
 * not be called before that set lands.
 *
 * Call sites (apply order — all AFTER existing suppressions, BEFORE
 * the actual send call):
 *  - src/lib/social/comments.ts handleCommentEvent auto-post branch
 *    (see comments-auto-reply-gate.diff): commentMode owner/approval
 *    or a held facebook/instagram channel blocks the auto-post; the
 *    draft is still stored and the queue still shows it.
 *  - Staged followups loop (F→I stack): after the Leg F gate passes
 *    and before status="sending" (see followups gate note in the
 *    followups set): a channel-held follow-up is DEFERRED (see
 *    followup-ordering.ts), never double-counted as suppressed.
 *  - Booking reminder sends (staged Leg D) and offer sends (Leg E
 *    paths): same helper, kind "offer" for offer sends, with the
 *    Leg E offer control supplied by the caller — this helper never
 *    supplies offer content.
 */

export type OwnerControlsDocInput = {
  businessId: string;
  channelControls: Record<string, { mode: "ai" | "owner" }>;
  commentMode: "auto" | "approval" | "owner";
} | null;

export type SendPathDecision =
  | { allowed: true }
  | { allowed: false; reason: string; diagnostic: true };

export function decideAiSendWithOwnerControls(input: {
  businessId: string;
  /** The adapter doc, or null when no doc exists (missing = defaults). */
  doc: OwnerControlsDocInput;
  /** True when the adapter threw (corrupt doc / store down). */
  docError: boolean;
  channel: string;
  /** HEAD per-conversation switch; false = owner took that thread. */
  conversationAiEnabled: boolean;
  /** HEAD global kill-switch. */
  globalAiOff: boolean;
  /** Onboarding predicate inputs; see channel-controls canAiWork. */
  onboarding: { websiteAttached: boolean; hasActiveTrialOrPaid: boolean; isInternalHolder?: boolean };
  kind: "message" | "offer";
  /** Leg E offer control, for kind "offer" only; null = missing = block. */
  offerControl?: {
    enabled: boolean;
    paused: boolean;
    pausedUntilMs?: number | null;
    contentFromOwnerConfig: boolean;
  } | null;
  nowMs: number;
}): SendPathDecision {
  if (input.docError) {
    return { allowed: false, reason: "owner_controls_store_unavailable", diagnostic: true };
  }
  if (input.doc !== null && input.doc.businessId !== input.businessId) {
    return { allowed: false, reason: "cross_tenant", diagnostic: true };
  }
  // Onboarding gate (channel-controls precedence 1), then global off (2).
  const isHolder = input.onboarding.isInternalHolder === true;
  if (!isHolder && !(input.onboarding.websiteAttached && input.onboarding.hasActiveTrialOrPaid)) {
    return { allowed: false, reason: "onboarding_not_complete", diagnostic: true };
  }
  if (input.globalAiOff === true) {
    return { allowed: false, reason: "global_ai_off", diagnostic: true };
  }
  // Channel gate (3): missing channel record = "ai" (settled default;
  // deploying changes no existing tenant until its owner flips it).
  const channelMode = input.doc?.channelControls?.[input.channel]?.mode ?? "ai";
  if (channelMode === "owner") {
    return { allowed: false, reason: "channel_owner_controlled", diagnostic: true };
  }
  // Conversation gate (4).
  if (input.conversationAiEnabled === false) {
    return { allowed: false, reason: "conversation_owner_controlled", diagnostic: true };
  }
  if (input.kind === "message") return { allowed: true };
  // Offer gate (Leg E, settled fail-closed): needs the offer control too.
  const offer = input.offerControl ?? null;
  if (!offer) return { allowed: false, reason: "offer_not_enabled", diagnostic: true };
  if (offer.enabled !== true) return { allowed: false, reason: "offer_not_enabled", diagnostic: true };
  if (offer.pausedUntilMs !== undefined && offer.pausedUntilMs !== null) {
    if (offer.pausedUntilMs > input.nowMs) {
      return { allowed: false, reason: "offer_paused", diagnostic: true };
    }
  } else if (offer.paused === true) {
    return { allowed: false, reason: "offer_paused", diagnostic: true };
  }
  if (offer.contentFromOwnerConfig !== true) {
    return { allowed: false, reason: "offer_content_not_configured", diagnostic: true };
  }
  return { allowed: true };
}

/** Comment-mode decision for the comments auto-post call site. */
export function decideCommentAutoPost(input: {
  doc: OwnerControlsDocInput;
  docError: boolean;
  platform: "facebook" | "instagram";
  accountAutoReply: boolean;
}): { post: boolean; reason: string } {
  if (input.docError) return { post: false, reason: "owner_controls_store_unavailable" };
  if (input.doc !== null && input.doc.channelControls?.[input.platform]?.mode === "owner") {
    return { post: false, reason: "channel_owner_controlled" };
  }
  const mode = input.doc?.commentMode ?? "auto";
  if (mode === "owner") return { post: false, reason: "mode_owner" };
  if (mode === "approval") return { post: false, reason: "mode_approval" };
  // mode "auto": HEAD behaviour unchanged — auto-post only when the
  // connected account itself enabled autoReply. Existing businesses
  // keep HEAD approval-queue behaviour until their owner flips the
  // mode; nothing here backfills anyone to "auto".
  if (!input.accountAutoReply) return { post: false, reason: "account_auto_reply_off" };
  return { post: true, reason: "mode_auto" };
}

// Firestore-touching wrapper — wire ONLY in the same batch as the
// wiring set (getSettingsOwnerControlAdapter). NOT imported by the
// harness; shown here so the apply team does not invent a second
// reader. Signature (apply team fills the import):
//   import { getSettingsOwnerControlAdapter } from
//     "@/lib/owner-controls/settings-owner-control-adapter";
//   export async function getOwnerControlsDocForSend(businessId: string) {
//     try {
//       const doc = await getSettingsOwnerControlAdapter().getDoc(businessId);
//       return { doc, docError: false };
//     } catch {
//       return { doc: null, docError: true };
//     }
//   }
