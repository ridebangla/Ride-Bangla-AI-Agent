/**
 * AUDIT TRAIL — Leg E (owner offer + reply control batch).
 *
 * Real repo path: src/lib/owner-controls/audit-trail.ts (NEW file).
 * Pure module: zero imports, zero I/O. It defines the ONE canonical
 * trail-entry shape that Legs B/C/D (offers / messages / rules
 * controls) must use, builds entries, derives before/after summaries,
 * and refuses trail mutation by construction.
 *
 * RULES (owner doctrine + this leg's fail-closed rule):
 *  - EVERY edit / pause / resume performed through a Leg B/C/D
 *    control writes a trail entry. No entry, no mutation: if the
 *    trail write fails, the mutation fails (enforced by the store
 *    seam in owner-controls-store.ts, which writes both in one
 *    transaction — this pure module only defines the shape).
 *  - Append-only by construction: this module exports NO update and
 *    NO delete for trail entries, and isTrailMutationRefused()
 *    answers true for both. Firestore rules (see rules/ proposal)
 *    additionally deny direct-client create/update/delete; the
 *    server Admin SDK path is append-only because no code path
 *    exists that mutates an entry.
 *  - Tenant-scoped reads: an entry belongs to exactly one businessId;
 *    a reader from another tenant is refused (never handed an empty
 *    list that could be probed). Staff-role gating is PROPOSAL
 *    (see TRAIL_READ_ROLES) for the owner's approval.
 *
 * This trail is the CONTROL-change trail (what the owner/staff
 * changed about offers and reply rules). It is NOT the send-block
 * log (send-gate.ts), which is diagnostic only and is not subject
 * to the mutation-fails rule.
 */

export const TRAIL_ACTIONS = [
  "created",
  "edited",
  "enabled",
  "disabled",
  "paused",
  "resumed",
  "deleted",
] as const;

export type TrailAction = (typeof TRAIL_ACTIONS)[number];

/** What kind of owner-controlled thing changed. */
export const TRAIL_TARGET_KINDS = [
  "offer",
  "coupon",
  "incentive_config",
  "reply_rule",
  "template",
  "followup_setting",
  "reminder_setting",
  "review_setting",
  "send_control",
] as const;

export type TrailTargetKind = (typeof TRAIL_TARGET_KINDS)[number];

/**
 * PROPOSAL — staff roles allowed to READ the trail. Owner decision
 * required before landing. Rationale for this proposal: the trail
 * records configuration history (amounts, texts, who changed what);
 * viewers and front-line agents do not need it for their work, while
 * supervisors need it for operational oversight. Admins (including
 * the business owner acting as admin) always read.
 * Roles are the HEAD role names (viewer / agent / supervisor /
 * admin / super_admin). A null-business Super Admin is refused by
 * the store seam before this check (same fail-closed pattern as
 * every other tenant route).
 */
export const TRAIL_READ_ROLES = ["admin", "supervisor"] as const;

export type TrailActorRole =
  | "admin"
  | "supervisor"
  | "system";

export interface TrailActor {
  /** Dashboard user id that performed the change. Never empty. */
  id: string;
  /**
   * Role at the time of the change. "system" ONLY for automatic
   * entries the platform itself writes (e.g. a timed pause lapsing
   * into a resume entry written by a sweep) — never for a human
   * action, and never as a fallback when the actor is unknown
   * (unknown actor = entry refused, mutation fails).
   */
  role: TrailActorRole;
}

export interface TrailTarget {
  kind: TrailTargetKind;
  /**
   * The send type (send-gate.ts SEND_TYPES) for send_control targets,
   * otherwise the control key the owning leg uses (e.g. a coupon
   * code, a template key, a settings field name). Free-form but
   * never empty; the merger checklist maps each leg's keys here.
   */
  type: string;
  /** Id of the changed record (coupon doc id, control doc id, ...). */
  id: string;
}

export interface TrailFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * CANONICAL trail-entry shape. Legs B/C/D must use exactly this
 * shape — no parallel trail shape, no extra top-level fields that
 * duplicate these (extra detail belongs inside before/after).
 * before/after hold the CHANGED record's fields (full values for
 * changed fields only — see summarizeChange). Null before = the
 * record was created; null after = the record was deleted.
 */
export interface OwnerControlTrailEntry {
  /** Server-generated opaque id. Never client-supplied. */
  id: string;
  businessId: string;
  actor: TrailActor;
  actedAtMs: number;
  action: TrailAction;
  target: TrailTarget;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Field names that differ between before and after (derived). */
  changedFields: string[];
  /** Per-field before/after pairs (derived). */
  changeSummary: TrailFieldChange[];
}

export interface BuildTrailEntryInput {
  id: string;
  businessId: string;
  actor: TrailActor;
  actedAtMs?: number;
  action: TrailAction;
  target: TrailTarget;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? "null";
}

/**
 * Field-level diff between before and after snapshots. A field
 * present in only one snapshot counts as changed. Values are kept
 * verbatim (numbers, booleans, enums, texts) — truncating a changed
 * text would destroy exactly what the audit is for. Merger note:
 * Firestore documents cap at 1 MiB; a template edit with a very
 * large text plus its before-image must be checked against that
 * cap at apply time (see LEG-REPORT §6) — the answer is never to
 * silently drop fields from the trail.
 */
export function summarizeChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): TrailFieldChange[] {
  // Plain array (not Set iteration) so this module typechecks even
  // under a default ES5 target, not only under the repo's config.
  const fields: string[] = [];
  const addField = (key: string): void => {
    if (fields.indexOf(key) === -1) fields.push(key);
  };
  if (before) for (const key of Object.keys(before)) addField(key);
  if (after) for (const key of Object.keys(after)) addField(key);
  const changes: TrailFieldChange[] = [];
  for (const field of fields) {
    const b = before ? before[field] : undefined;
    const a = after ? after[field] : undefined;
    if (stable(b) !== stable(a)) {
      changes.push({ field, before: b ?? null, after: a ?? null });
    }
  }
  return changes;
}

function fail(message: string): never {
  throw new Error(`owner_control_trail_invalid: ${message}`);
}

/**
 * Builds a canonical entry, validating every fail-closed rule.
 * Throws on any violation — the caller (store seam) must let the
 * throw abort the mutation transaction. Never "repair" a bad entry
 * (no invented actor, no guessed timestamp, no defaulted action).
 */
export function buildTrailEntry(input: BuildTrailEntryInput): OwnerControlTrailEntry {
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    fail("id missing");
  }
  if (typeof input.businessId !== "string" || input.businessId.trim().length === 0) {
    fail("businessId missing");
  }
  if (!isRecord(input.actor) || typeof input.actor.id !== "string" || input.actor.id.trim().length === 0) {
    fail("actor missing");
  }
  if (
    input.actor.role !== "admin" &&
    input.actor.role !== "supervisor" &&
    input.actor.role !== "system"
  ) {
    fail("actor role unknown");
  }
  const actedAtMs = input.actedAtMs ?? Date.now();
  if (!Number.isFinite(actedAtMs)) {
    fail("actedAtMs invalid");
  }
  if (!(TRAIL_ACTIONS as readonly string[]).includes(input.action)) {
    fail("action unknown");
  }
  if (!(TRAIL_TARGET_KINDS as readonly string[]).includes(input.target.kind)) {
    fail("target kind unknown");
  }
  if (typeof input.target.type !== "string" || input.target.type.trim().length === 0) {
    fail("target type missing");
  }
  if (typeof input.target.id !== "string" || input.target.id.trim().length === 0) {
    fail("target id missing");
  }
  if (input.before !== null && !isRecord(input.before)) {
    fail("before must be an object or null");
  }
  if (input.after !== null && !isRecord(input.after)) {
    fail("after must be an object or null");
  }
  if (input.action === "created" && input.before !== null) {
    fail("created entry must have null before");
  }
  if (input.action === "deleted" && input.after !== null) {
    fail("deleted entry must have null after");
  }
  const changeSummary = summarizeChange(input.before, input.after);
  return {
    id: input.id,
    businessId: input.businessId,
    actor: input.actor,
    actedAtMs,
    action: input.action,
    target: input.target,
    before: input.before,
    after: input.after,
    changedFields: changeSummary.map((c) => c.field),
    changeSummary,
  };
}

/**
 * Append-only by construction: update and delete of trail entries
 * are refused, always. There is no code path in this batch that
 * performs them, and the rules proposal denies them to clients.
 */
export function isTrailMutationRefused(
  operation: "create" | "update" | "delete" | "read",
): boolean {
  return operation === "update" || operation === "delete";
}

/**
 * Validates a stored entry against its owning tenant. Returns an
 * error code string, or null when the entry is valid for this tenant.
 * Cross-tenant entries are invalid FOR THIS READER (the store seam
 * refuses the read; it never returns another tenant's entries).
 */
export function validateTrailEntryForTenant(
  entry: OwnerControlTrailEntry,
  businessId: string,
): string | null {
  if (entry.businessId !== businessId) return "cross_tenant";
  if (!(TRAIL_ACTIONS as readonly string[]).includes(entry.action)) {
    return "action_unknown";
  }
  if (!(TRAIL_TARGET_KINDS as readonly string[]).includes(entry.target.kind)) {
    return "target_kind_unknown";
  }
  return null;
}

/** PROPOSAL role gate for trail reads (see TRAIL_READ_ROLES). */
export function canReadTrail(role: string): boolean {
  return (TRAIL_READ_ROLES as readonly string[]).includes(role);
}

/** Proposed trail collection name (server Admin SDK path). */
export const OWNER_CONTROL_TRAIL_COLLECTION = "ownerControlTrail";
/** Proposed block-log collection name (diagnostic only, not the trail). */
export const OWNER_CONTROL_BLOCK_LOG_COLLECTION = "ownerControlSendBlocks";
/** Proposed owner-control record collection name. */
export const OWNER_SEND_CONTROLS_COLLECTION = "ownerSendControls";
