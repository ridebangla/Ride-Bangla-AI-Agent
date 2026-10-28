/**
 * LEG E TRAIL MAPPING — owner-controls audit → canonical trail.
 * Repo path when applied: src/lib/owner-controls/leg-e-trail-map.ts (NEW)
 * Pure module: zero imports, zero I/O. No new collection, no new trail.
 *
 * PROBLEM IT CLOSES (owed since the owner-controls build): the wired
 * settings-doc adapter stores audit entries in
 * `settings.ownerControls.audit` as ChannelControlAuditEntry /
 * CommentModeAuditEntry, while Leg E defines ONE canonical trail shape
 * (OwnerControlTrailEntry). Running two live trails would split the
 * audit. This module is the single mapping: adapter entries are
 * CONVERTED to Leg E shape when read/exported — never stored twice.
 *
 * LEG E SHAPE (copied from leg-e-gate audit-trail.ts, not reinvented):
 *   id, businessId, actor {id, role}, actedAtMs, action, target
 *   {kind, type, id}, before, after, changedFields, changeSummary.
 * Leg E actions: created | edited | enabled | disabled | paused |
 * resumed | deleted. There is no "takeover" action in Leg E, so the
 * mapping is semantic, not literal:
 *   channel_takeover  -> action "disabled", target kind "send_control",
 *                        type "channel:<channel>" (AI disabled on it)
 *   channel_handback  -> action "enabled",  target kind "send_control",
 *                        type "channel:<channel>" (AI re-enabled on it)
 *   comment_mode_change -> action "edited", target kind "reply_rule",
 *                        type "comment_mode"
 * Target id is the channel string, or "comment_mode" for comment mode.
 * before/after hold ONLY the mode field that changed.
 *
 * FAIL-CLOSED RULES (Leg E, preserved, not softened):
 *  - changedBy null -> REFUSED (throw). Leg E: unknown actor = entry
 *    refused, mutation fails; never invent an actor, never "system"
 *    for a human change. The adapter permits null changedBy on write;
 *    the mapping refuses it on trail conversion, so a null-actor
 *    entry can never appear in the canonical trail.
 *  - Empty id / businessId / channel -> throw. The server generates
 *    the id; this module never generates one (a generated id here
 *    would be client-suppliable in disguise).
 *  - Actor role: adapter carries no role, so the mapped role is
 *    "admin" ONLY when the caller proves it (actorRole argument);
 *    otherwise throw. No role is guessed from changedBy.
 *
 * BLOCK LOGS ARE NOT TRAIL ENTRIES (Leg E, explicit): a send-block
 * (channel-send-gate buildBlockLogEntry) is diagnostic only. It is
 * NEVER mapped to a TrailEntry. mapBlockLog() returns a diagnostic
 * record in a deliberately different shape so no reader can mistake
 * a blocked send for a control change.
 */

export type LegETrailAction =
  | "created"
  | "edited"
  | "enabled"
  | "disabled"
  | "paused"
  | "resumed"
  | "deleted";

export type LegETrailTargetKind =
  | "offer"
  | "coupon"
  | "incentive_config"
  | "reply_rule"
  | "template"
  | "followup_setting"
  | "reminder_setting"
  | "review_setting"
  | "send_control";

export interface LegETrailEntry {
  id: string;
  businessId: string;
  actor: { id: string; role: "admin" | "supervisor" | "system" };
  actedAtMs: number;
  action: LegETrailAction;
  target: { kind: LegETrailTargetKind; type: string; id: string };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
  changeSummary: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface AdapterChannelAudit {
  businessId: string;
  channel: string;
  action: "channel_takeover" | "channel_handback";
  beforeMode: "ai" | "owner";
  afterMode: "ai" | "owner";
  changedAtMs: number;
  changedBy: string | null;
}

export interface AdapterCommentAudit {
  businessId: string;
  action: "comment_mode_change";
  beforeMode: "auto" | "approval" | "owner";
  afterMode: "auto" | "approval" | "owner";
  changedAtMs: number;
  changedBy: string | null;
}

export type AdapterAuditEntry = AdapterChannelAudit | AdapterCommentAudit;

export interface ChannelBlockLog {
  businessId: string;
  channel: string;
  kind: "message" | "offer";
  reason: string;
  atMs: number;
}

/** Diagnostic block record — deliberately NOT a LegETrailEntry. */
export interface SendBlockDiagnostic {
  diagnostic: true;
  notATrailEntry: true;
  businessId: string;
  channel: string;
  kind: "message" | "offer";
  reason: string;
  atMs: number;
}

function fail(message: string): never {
  throw new Error(`leg_e_trail_map_invalid: ${message}`);
}

function requireActor(
  changedBy: string | null,
  actorRole: "admin" | "supervisor" | "system" | null | undefined,
): { id: string; role: "admin" | "supervisor" | "system" } {
  if (typeof changedBy !== "string" || changedBy.trim() === "") {
    fail("unknown actor — entry refused, never invent an actor");
  }
  if (actorRole !== "admin" && actorRole !== "supervisor" && actorRole !== "system") {
    fail("actor role not proven by caller — never guess a role");
  }
  return { id: changedBy as string, role: actorRole };
}

export function mapAdapterAuditToLegETrail(
  entry: AdapterAuditEntry,
  input: { id: string; actorRole: "admin" | "supervisor" | "system" | null | undefined },
): LegETrailEntry {
  if (typeof input.id !== "string" || input.id.trim() === "") fail("id missing");
  if (typeof entry.businessId !== "string" || entry.businessId.trim() === "") {
    fail("businessId missing");
  }
  const actor = requireActor(entry.changedBy, input.actorRole);
  if (entry.action === "channel_takeover" || entry.action === "channel_handback") {
    if (typeof entry.channel !== "string" || entry.channel.trim() === "") {
      fail("channel missing");
    }
    const isTakeover = entry.action === "channel_takeover";
    return {
      id: input.id,
      businessId: entry.businessId,
      actor,
      actedAtMs: entry.changedAtMs,
      action: isTakeover ? "disabled" : "enabled",
      target: { kind: "send_control", type: `channel:${entry.channel}`, id: entry.channel },
      before: { mode: entry.beforeMode },
      after: { mode: entry.afterMode },
      changedFields: ["mode"],
      changeSummary: [{ field: "mode", before: entry.beforeMode, after: entry.afterMode }],
    };
  }
  return {
    id: input.id,
    businessId: entry.businessId,
    actor,
    actedAtMs: entry.changedAtMs,
    action: "edited",
    target: { kind: "reply_rule", type: "comment_mode", id: "comment_mode" },
    before: { mode: entry.beforeMode },
    after: { mode: entry.afterMode },
    changedFields: ["mode"],
    changeSummary: [{ field: "mode", before: entry.beforeMode, after: entry.afterMode }],
  };
}

/**
 * A send-block is diagnostic only (Leg E). It must never be written
 * into the control-change trail, and this function cannot produce a
 * LegETrailEntry — its return type has no trail fields at all.
 */
export function mapBlockLogToDiagnostic(log: ChannelBlockLog): SendBlockDiagnostic {
  return {
    diagnostic: true,
    notATrailEntry: true,
    businessId: log.businessId,
    channel: log.channel,
    kind: log.kind,
    reason: log.reason,
    atMs: log.atMs,
  };
}
