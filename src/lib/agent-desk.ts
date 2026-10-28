/**
 * agent-desk.ts — Agent Desk: plain-language agent rules with
 * preview-before-live, explicit-approval publish, one-click rollback,
 * and append-only version history.
 *
 * STAGED ONLY (agent booking batch, LEG G). Nothing here is live,
 * and nothing here copies any other product's branding, assets, UI
 * text, prompts, or code: every rule, guard, and string below is
 * written from scratch for the Ride Bangla AI Agent platform.
 *
 * DESIGN (read before changing it):
 *
 * 1. PLAIN LANGUAGE, VERBATIM. The owner writes rules in plain
 *    language (e.g. delivery-charge policy, tone, house policies).
 *    The text is stored VERBATIM — there is no parser that turns
 *    prose into structured fields, because a parser that guessed
 *    wrong would silently change what the owner meant. The live
 *    engine already injects per-business behaviour text verbatim
 *    (settings.agentBehavior, "Business Behavior Instructions"
 *    section of buildSystemPrompt); Agent Desk versions that text.
 *
 * 2. THE LIVE SLOT IS UNCHANGED. Publishing does NOT change the
 *    engine: it marks a version LIVE and mirrors its text into
 *    settings.agentBehavior — the exact field the engine already
 *    reads under the tenant context. If no Agent Desk version has
 *    ever gone live, the engine keeps reading whatever
 *    settings.agentBehavior already holds (legacy behaviour), so
 *    existing businesses lose nothing on upgrade. The version
 *    store is the system of record for HISTORY; settings is the
 *    live mirror. A GET that finds mirror != live-version text
 *    reports drift honestly instead of pretending they agree.
 *
 * 3. APPEND-ONLY HISTORY. Version rows are never edited and never
 *    deleted by these routes. Publish demotes the old LIVE row to
 *    SUPERSEDED; rollback creates a NEW LIVE row copying a past
 *    version's text (restoresVersion records which one). A
 *    superseded draft that is replaced by a newer draft becomes
 *    DISCARDED, never deleted, so "who changed what, when" survives.
 *
 * 4. OLD RULE STAYS LIVE UNTIL PUBLISH COMPLETES. Drafts and
 *    previews write nothing to the live mirror. Publish order is:
 *    (a) demote the previous LIVE row(s) to SUPERSEDED,
 *    (b) mark the new version LIVE, (c) mirror into
 *    settings.agentBehavior. A crash between (a) and (b) leaves
 *    NO live row — and the engine then keeps reading the live
 *    mirror, which still holds the OLD text (safe: the old rule
 *    keeps answering). A crash between (b) and (c) leaves the
 *    new text marked LIVE but unmirrored, which the next GET
 *    reports as drift, and a re-publish (LIVE rows may be
 *    re-published to re-mirror) repairs. There is no
 *    cross-document transaction
 *    here — the Firestore delegate's $transaction is documented
 *    in firestore.ts as NOT atomic across documents — so the code
 *    never claims atomic publish.
 *
 * 5. TENANT SCOPING IS STRUCTURAL, NOT POLITE. Every route runs
 *    inside runWithBusiness(auth.businessId), every version query
 *    filters by that businessId, and every version lookup that
 *    misses under that scope answers 404 (not_found), never 403:
 *    a caller must not learn whether another business owns a
 *    version id. Rule text, previews, and history of one business
 *    are unreachable from another business's session.
 *
 * 6. DOCTRINES ENFORCED IN CODE, NOT IN COPY:
 *    - The agent NEVER confirms an order/booking alone (human
 *      team confirms; confirmed = locked). A rule that tells the
 *      agent to confirm without a human/team/owner is REJECTED at
 *      draft creation AND re-checked at publish time.
 *    - Per-surface identity: a rule must not tell the agent to
 *      hide that it is an AI assistant or to pretend to be human.
 *      (The engine already identifies the agent as the AI
 *      assistant for THIS business; a rule must not undo that.)
 *    - The agent never quotes ride fares. Agent Desk rules are a
 *      tenant's own business policies (the task's own example is
 *      a delivery-charge policy); a rule carrying an amount is
 *      NOT blocked — blocking it would defeat the delivery-charge
 *      example — but it is flagged as an amount_in_rule WARNING
 *      on draft, preview, and publish responses, and the owner
 *      must verify the figure against their own catalog/index
 *      before approving. The warning is surfaced, never hidden.
 *    - Secrets in rule text (api keys, tokens, passwords with a
 *      value) are REJECTED: rule text is behaviour prose, never
 *      a place for credentials.
 *    - Rules are BEHAVIOUR, not facts: they never write knowledge
 *      entries, never supersede a website/details index, and
 *      never reach another account's agent (see the per-account
 *      index doctrine — Agent Desk integrates with it, it does
 *      not replace it).
 *
 * 7. PREVIEW IS A TEST, NOT A SEND. The preview route generates
 *    a reply with the SAME prompt builder the live engine uses
 *    (buildSystemPrompt, with agentBehavior replaced by the draft
 *    text and the tenant's live knowledge base), and the SAME
 *    deterministic greeting reply for pure greetings. It writes
 *    no conversation, message, order, or ticket, and it runs NO
 *    tools: a preview can show wording, never a completed order.
 *    Its response is labelled isPreview + notSent on every call.
 *    Preview spend is metered exactly like the existing knowledge
 *    test (subscription + plan-limit gates, recordAiMessage on
 *    success) — previews are not a free quota bypass.
 *
 * This module is pure (no imports) so it can be unit-tested
 * standalone. All Firestore/HTTP work lives in the routes.
 */

export type RuleVersionStatus =
  | "DRAFT"
  | "LIVE"
  | "SUPERSEDED"
  | "DISCARDED";

export type RuleVersionOrigin = "draft" | "rollback";

export interface AgentRuleVersion {
  id: string;
  businessId: string;
  versionNumber: number;
  status: RuleVersionStatus;
  /** Owner's verbatim plain-language rules. */
  plainText: string;
  /** Owner's own words on what changed ("" = none given). */
  changeNote: string;
  /** Auth userId of the actor ("api-key:<id>" for key auth). */
  createdBy: string;
  createdByName: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  publishedAt: Date | string | null;
  publishedBy: string | null;
  origin: RuleVersionOrigin;
  /** versionNumber restored by a rollback row; null otherwise. */
  restoresVersion: number | null;
}

/** Hard cap on one rule text: behaviour prose, not a document. */
export const MAX_RULE_CHARS = 4000;
/** Hard cap on the owner's change note. */
export const MAX_CHANGE_NOTE_CHARS = 500;
/** Hard cap on a preview test message. */
export const MAX_TEST_MESSAGE_CHARS = 1000;
/** History page size for GET /api/agent-desk. */
export const HISTORY_LIMIT = 50;

/** Machine codes for rule-text validation failures. */
export type RuleValidationCode =
  | "empty_rule"
  | "rule_too_long"
  | "forbidden_confirm_alone"
  | "forbidden_identity_concealment"
  | "secret_detected";

export interface RuleValidation {
  ok: boolean;
  /** Blocking failures (draft/publish refused while any is present). */
  errors: RuleValidationCode[];
  /** Non-blocking flags the owner must see before approving. */
  warnings: string[];
}

/**
 * Patterns that tell the agent to confirm orders/bookings without a
 * human. Narrow on purpose: "confirm with the team" / "ask the team
 * to confirm" / "send to the team for confirmation" must PASS —
 * those are the correct lifecycle. Only confirm-without-a-human
 * phrasings are blocked.
 */
const CONFIRM_ALONE_PATTERNS: RegExp[] = [
  /\bconfirm(s|ed|ing)?\b[^.!?\n]{0,80}\b(without|no|never|don't|do not|no need for)\b[^.!?\n]{0,40}\b(human|team|approval|owner|checking)\b/i,
  /\bauto[-\s]?confirm\b/i,
  /\bconfirm (orders?|bookings?|it) (automatically|yourself|alone|on your own)\b/i,
  /\bnever (ask|tell|notify|escalate|check with)\b[^.!?\n]{0,60}\b(the )?(team|human|owner)\b/i,
];

/**
 * Patterns that tell the agent to hide its AI identity or pretend
 * to be human. The engine identifies the agent as the AI assistant
 * for this business; a rule must not undo that disclosure.
 */
const IDENTITY_CONCEALMENT_PATTERNS: RegExp[] = [
  /\bpretend (to be|you are|you're) human\b/i,
  /\bdo not (mention|say|reveal|admit) (that )?you (are|were) (an )?ai\b/i,
  /\bnever (mention|say|reveal) (that )?you (are|were) (an )?ai\b/i,
  /\byou are (not|no longer) (an )?ai\b/i,
  /\bsay you are (a )?human\b/i,
];

/** Credential-shaped material has no place in behaviour prose. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(api[_-]?key|apikey|secret|password|passwd|access[_-]?token)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9]{8,}\b/,
  /\bBearer\s+\S+/i,
];

/** Amount-bearing prose: warning only, never a block (see header §6). */
const AMOUNT_PATTERN =
  /[৳$€£]\s?\d|\b(USD|BDT|TK)\s?\d|\b\d+\s?(taka|tk)\b/i;

export function validateRuleText(plainText: unknown): RuleValidation {
  const errors: RuleValidationCode[] = [];
  const warnings: string[] = [];
  if (typeof plainText !== "string" || plainText.trim().length === 0) {
    return { ok: false, errors: ["empty_rule"], warnings };
  }
  if (plainText.length > MAX_RULE_CHARS) errors.push("rule_too_long");
  if (CONFIRM_ALONE_PATTERNS.some((re) => re.test(plainText))) {
    errors.push("forbidden_confirm_alone");
  }
  if (IDENTITY_CONCEALMENT_PATTERNS.some((re) => re.test(plainText))) {
    errors.push("forbidden_identity_concealment");
  }
  if (SECRET_PATTERNS.some((re) => re.test(plainText))) {
    errors.push("secret_detected");
  }
  if (AMOUNT_PATTERN.test(plainText)) {
    warnings.push("amount_in_rule");
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateChangeNote(changeNote: unknown): boolean {
  return (
    changeNote === undefined ||
    changeNote === null ||
    (typeof changeNote === "string" &&
      changeNote.length <= MAX_CHANGE_NOTE_CHARS)
  );
}

export function validateTestMessage(testMessage: unknown): boolean {
  return (
    typeof testMessage === "string" &&
    testMessage.trim().length > 0 &&
    testMessage.length <= MAX_TEST_MESSAGE_CHARS
  );
}

/**
 * Line-level "what changed" between two rule texts, for history.
 * Order-preserving, blank lines skipped, duplicates kept (a rule
 * repeated twice is two lines of intent, not one).
 */
export function diffRuleText(
  oldText: string,
  newText: string
): { added: string[]; removed: string[] } {
  const lines = (t: string): string[] =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const oldLines = lines(oldText || "");
  const newLines = lines(newText || "");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    added: newLines.filter((l) => !oldSet.has(l)),
    removed: oldLines.filter((l) => !newSet.has(l)),
  };
}

/** Next version number for a business: max existing + 1, or 1. */
export function nextVersionNumber(existing: number[]): number {
  if (existing.length === 0) return 1;
  return Math.max(...existing) + 1;
}

/** Highest-versionNumber LIVE row, or null (no live rule yet). */
export function getLiveVersion(
  versions: AgentRuleVersion[]
): AgentRuleVersion | null {
  const live = versions.filter((v) => v.status === "LIVE");
  if (live.length === 0) return null;
  return live.reduce((a, b) => (b.versionNumber > a.versionNumber ? b : a));
}

/** The single open draft, or null. */
export function getOpenDraft(
  versions: AgentRuleVersion[]
): AgentRuleVersion | null {
  const drafts = versions.filter((v) => v.status === "DRAFT");
  if (drafts.length === 0) return null;
  return drafts.reduce((a, b) => (b.versionNumber > a.versionNumber ? b : a));
}

/**
 * One-click rollback target: the most recent version that WAS live
 * before the current live version. Null when there is nothing to
 * roll back to (first-ever live version, or no live version).
 */
export function getRollbackTarget(
  versions: AgentRuleVersion[],
  live: AgentRuleVersion | null
): AgentRuleVersion | null {
  if (!live) return null;
  const candidates = versions.filter(
    (v) => v.status === "SUPERSEDED" && v.versionNumber < live.versionNumber
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    b.versionNumber > a.versionNumber ? b : a
  );
}

/**
 * Which statuses may be published. DRAFT = promote; SUPERSEDED =
 * restore a past version through the approval path (rollback is
 * the one-click shortcut for the same outcome); LIVE = re-mirror
 * only (repairs drift after an interrupted publish). DISCARDED
 * drafts may never be published — write a new draft instead.
 */
export function canPublish(status: RuleVersionStatus): boolean {
  return status === "DRAFT" || status === "SUPERSEDED" || status === "LIVE";
}

/** Pure tenant guard: a row belongs to the caller's business or not. */
export function isSameBusiness(
  rowBusinessId: string,
  authBusinessId: string | null
): boolean {
  return !!authBusinessId && rowBusinessId === authBusinessId;
}

/**
 * Public shape of a version row for API responses: the owner's own
 * rule text is returned only to the same tenant's session (the
 * routes guarantee that); nothing secret is ever stored on a row,
 * because secret-shaped text is rejected at validation.
 */
export function publicVersion(v: AgentRuleVersion): {
  id: string;
  versionNumber: number;
  status: RuleVersionStatus;
  plainText: string;
  changeNote: string;
  createdByName: string;
  createdAt: Date | string;
  publishedAt: Date | string | null;
  publishedBy: string | null;
  origin: RuleVersionOrigin;
  restoresVersion: number | null;
} {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    plainText: v.plainText,
    changeNote: v.changeNote,
    createdByName: v.createdByName,
    createdAt: v.createdAt,
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
    origin: v.origin,
    restoresVersion: v.restoresVersion,
  };
}

/**
 * Phone-preview envelope: exactly what the dashboard renders inside
 * the phone frame, and exactly what the API returns for a preview.
 * isPreview + notSent are unconditional — no preview response may
 * ever be mistaken for a message sent to a customer.
 */
export function toPhonePreview(args: {
  businessName: string;
  reply: string;
  rulesVersionNumber: number | null;
  source: "draft" | "unsaved_text" | "version";
  warnings: string[];
  model: string;
}): {
  businessName: string;
  reply: string;
  isPreview: true;
  notSent: true;
  rulesVersionNumber: number | null;
  source: "draft" | "unsaved_text" | "version";
  warnings: string[];
  model: string;
} {
  return {
    businessName: args.businessName,
    reply: args.reply,
    isPreview: true,
    notSent: true,
    rulesVersionNumber: args.rulesVersionNumber,
    source: args.source,
    warnings: args.warnings,
    model: args.model,
  };
}
