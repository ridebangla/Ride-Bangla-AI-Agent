/**
 * rule-pause.ts — LEG D (owner controls, STAGED ONLY): pause / resume
 * for a LIVE Agent Desk rule.
 *
 * Extends staged booking Leg G (Agent Desk) WITHOUT rewriting any of
 * its publish / rollback paths. Leg G's version rows are append-only
 * and are NEVER edited here: pausing writes a SEPARATE pause row and
 * never touches a version row at all.
 *
 * PAUSE vs ROLLBACK (distinct operations, never conflated):
 * - ROLLBACK (Leg G) returns to a PREVIOUS version: it creates a NEW
 *   LIVE row copying an older version's text, and demotes the current
 *   LIVE row to SUPERSEDED. The live version NUMBER changes.
 * - PAUSE keeps the CURRENT version dormant: the LIVE row stays LIVE,
 *   its text is never copied, never edited, never deleted. The engine
 *   simply does not apply it while a pause row is active. RESUME
 *   deactivates the pause row, and exactly the same LIVE row — same
 *   version number, same text, byte-identical — applies again.
 *   Pause-then-resume therefore never rolls anything back, and
 *   rolling back never unpauses anything (a rollback creates a new
 *   LIVE row; a pause row that pointed at the old LIVE row no longer
 *   matches it, so resume after a rollback fails closed with
 *   "pause_version_mismatch" instead of silently reviving a rule).
 *
 * SAFE DEFAULT WHILE PAUSED: the agent gets NO behaviour rule at
 * all (effective text null). It never falls back to legacy settings
 * text, never invents a replacement rule, and never guesses. The
 * engine gate (integration snippet SNIP-1) turns a paused rule into
 * an empty agentBehavior, and buildSystemPrompt already omits the
 * "Business Behavior Instructions" section for an empty value.
 *
 * FAIL-CLOSED: every refusal below returns { ok: false, reason }
 * and changes nothing. Nothing in this module writes, sends, or
 * applies anything — it only decides. All persistence lives in the
 * routes, which also write the audit entry (see
 * ./owner-control-audit.ts; the audit SHAPE is a proposal for Leg E
 * reconciliation — see that module's header).
 *
 * TENANT SCOPING: every decision takes both the row's businessId
 * and the caller's businessId. A mismatch refuses, never leaks
 * whether the other business has a pause row.
 *
 * This module is pure (no imports) so it can be unit-tested
 * standalone. All owner-facing labels in the routes are PROPOSAL
 * wording for owner approval, never silently shipped copy.
 */

export type PauseRowStatus = "active" | "released";

export interface AgentRulePause {
  id: string;
  businessId: string;
  /** LIVE version row this pause pins to. Never a text copy. */
  versionId: string;
  versionNumber: number;
  status: PauseRowStatus;
  pausedAt: Date | string;
  pausedBy: string;
  pausedByName: string;
  /** Owner's own words on why ("" = none given). Never invented. */
  reason: string;
  releasedAt: Date | string | null;
  releasedBy: string | null;
}

/** Minimal shape of a Leg G version row this module needs. */
export interface LiveRuleLike {
  id: string;
  businessId: string;
  versionNumber: number;
  status: string;
  plainText: string;
}

/** Hard cap on the owner's pause reason. */
export const MAX_PAUSE_REASON_CHARS = 500;

export type PauseRefusal =
  | "no_live_rule"
  | "not_live"
  | "business_mismatch"
  | "already_paused"
  | "not_paused"
  | "pause_version_mismatch"
  | "invalid_reason";

export function validatePauseReason(reason: unknown): boolean {
  return (
    reason === undefined ||
    reason === null ||
    (typeof reason === "string" && reason.length <= MAX_PAUSE_REASON_CHARS)
  );
}

/** Pure tenant guard: a row belongs to the caller's business or not. */
export function isSameBusiness(
  rowBusinessId: string,
  authBusinessId: string | null
): boolean {
  return !!authBusinessId && rowBusinessId === authBusinessId;
}

/** True only for an active pause row belonging to this business. */
export function isRulePaused(
  pauseRow: AgentRulePause | null,
  authBusinessId: string | null
): boolean {
  if (!pauseRow || pauseRow.status !== "active") return false;
  return isSameBusiness(pauseRow.businessId, authBusinessId);
}

/**
 * Decide what the engine applies for this business.
 * - Paused => applied false, text null (safe default, never invented).
 * - No live rule => applied false, text null (same safe default).
 * - Live + not paused => applied true, the LIVE row's verbatim text.
 * A live row whose status is not "LIVE" is never applied, even if a
 * caller passes it in by mistake.
 */
export function effectiveRuleText(args: {
  live: LiveRuleLike | null;
  pauseRow: AgentRulePause | null;
  authBusinessId: string | null;
}): { applied: boolean; text: string | null; reason: string } {
  const { live, pauseRow, authBusinessId } = args;
  if (!live || live.status !== "LIVE") {
    return { applied: false, text: null, reason: "no_live_rule" };
  }
  if (!isSameBusiness(live.businessId, authBusinessId)) {
    return { applied: false, text: null, reason: "business_mismatch" };
  }
  if (isRulePaused(pauseRow, authBusinessId)) {
    return { applied: false, text: null, reason: "rule_paused" };
  }
  return { applied: true, text: live.plainText, reason: "live" };
}

/**
 * Pause the current LIVE rule. Returns the pause row to persist
 * (the route assigns the real id; the caller passes newId so this
 * pure function stays testable). Creates NOTHING if it refuses.
 */
export function pauseRule(args: {
  live: LiveRuleLike | null;
  existingPause: AgentRulePause | null;
  authBusinessId: string | null;
  actorId: string;
  actorName: string;
  reason: string;
  nowIso: string;
  newId: string;
}):
  | { ok: true; pauseRow: AgentRulePause }
  | { ok: false; reason: PauseRefusal } {
  const {
    live,
    existingPause,
    authBusinessId,
    actorId,
    actorName,
    reason,
    nowIso,
    newId,
  } = args;
  if (!live) return { ok: false, reason: "no_live_rule" };
  if (live.status !== "LIVE") return { ok: false, reason: "not_live" };
  if (!isSameBusiness(live.businessId, authBusinessId)) {
    return { ok: false, reason: "business_mismatch" };
  }
  if (!validatePauseReason(reason)) {
    return { ok: false, reason: "invalid_reason" };
  }
  if (isRulePaused(existingPause, authBusinessId)) {
    return { ok: false, reason: "already_paused" };
  }
  return {
    ok: true,
    pauseRow: {
      id: newId,
      businessId: live.businessId,
      versionId: live.id,
      versionNumber: live.versionNumber,
      status: "active",
      pausedAt: nowIso,
      pausedBy: actorId,
      pausedByName: actorName,
      reason: reason ?? "",
      releasedAt: null,
      releasedBy: null,
    },
  };
}

/**
 * Resume a paused rule. The restored text IS the LIVE row's text —
 * no copy was ever made, so byte-identical restore holds by
 * construction (harness asserts restoredText === live.plainText).
 * The pause row is flipped to "released", never deleted, so the
 * pause itself stays in history. Refuses (changing nothing) when
 * there is no active pause, or when the pause pins a DIFFERENT
 * version than the current LIVE row (e.g. a rollback happened
 * while paused — reviving the old rule would be wrong).
 */
export function resumeRule(args: {
  live: LiveRuleLike | null;
  pauseRow: AgentRulePause | null;
  authBusinessId: string | null;
  actorId: string;
  nowIso: string;
}):
  | {
      ok: true;
      releasedRow: AgentRulePause;
      restoredText: string;
      restoredVersionNumber: number;
    }
  | { ok: false; reason: PauseRefusal } {
  const { live, pauseRow, authBusinessId, actorId, nowIso } = args;
  if (!live) return { ok: false, reason: "no_live_rule" };
  if (live.status !== "LIVE") return { ok: false, reason: "not_live" };
  if (!isSameBusiness(live.businessId, authBusinessId)) {
    return { ok: false, reason: "business_mismatch" };
  }
  if (!isRulePaused(pauseRow, authBusinessId)) {
    return { ok: false, reason: "not_paused" };
  }
  const row = pauseRow as AgentRulePause;
  if (row.versionId !== live.id) {
    return { ok: false, reason: "pause_version_mismatch" };
  }
  return {
    ok: true,
    releasedRow: {
      ...row,
      status: "released",
      releasedAt: nowIso,
      releasedBy: actorId,
    },
    restoredText: live.plainText,
    restoredVersionNumber: live.versionNumber,
  };
}

/**
 * Pause / resume must leave version rows untouched. The routes
 * never update a version row for pause/resume; this helper lets
 * tests (and the merger) prove it: true only when the version list
 * is identical before and after, in content and order.
 */
export function versionsUnchanged(
  before: LiveRuleLike[],
  after: LiveRuleLike[]
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}
