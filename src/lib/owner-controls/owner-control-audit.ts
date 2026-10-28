/**
 * owner-control-audit.ts — LEG D (owner controls, STAGED ONLY):
 * the audit-trail ENTRY SHAPE for every Leg D mutation, plus the
 * fail-closed blocked-send log shape.
 *
 * *** RECONCILIATION FLAG — READ BEFORE APPLYING (Leg E) ***
 * This module defines an ENTRY SHAPE ONLY. It is a PROPOSAL for the
 * owner-controls batch's Leg E (audit trail) to adopt, replace, or
 * map — it is NOT a second trail system, and the merger must not
 * keep two trails alive side by side:
 * - If Leg E's trail writer lands FIRST: the Leg D routes call
 *   Leg E's writer with the entry this builder produces (field
 *   mapping is the merger's one job here), and the interim
 *   `ownerControlAudit` collection in diff LD-03 / the routes'
 *   direct create call is DELETED, not kept as a parallel trail.
 * - If Leg D lands FIRST: routes write the entry to the interim
 *   `ownerControlAudit` collection (tenant-scoped, businessId on
 *   every row, same pattern as Leg G's version rows). When Leg E
 *   lands, those rows are MIGRATED into Leg E's trail (or Leg E
 *   adopts this collection as its own) — never duplicated, never
 *   left as a shadow trail the owner cannot see in one place.
 * Either way, exactly ONE trail is the system of record at go-live.
 * This flag is repeated in LEG-REPORT.md §5 so it cannot be lost
 * in a merge.
 *
 * WHAT EVERY ENTRY CARRIES (owner doctrine 2026-10-25 §13:05):
 * actor identity, timestamp, what changed, before/after summary.
 * Summaries are SHORT system-generated strings (status + version /
 * key), never a dump of full rule/template text into a log line:
 * the full text stays on its own row, where the owner's own session
 * can read it under tenant scoping.
 *
 * This module is pure (no imports) so it can be unit-tested
 * standalone. Actor identity comes from the route's verified auth
 * (auth.userId, or "api-key:<id>" for key auth, mirroring Leg G's
 * createdBy convention) — never invented, never defaulted.
 */

export const OWNER_CONTROL_AUDIT_VERSION = 1;

export type OwnerControlObjectType =
  | "agent_rule"
  | "order_status_template";

export type OwnerControlAction =
  | "rule_paused"
  | "rule_resumed"
  | "template_created"
  | "template_edited"
  | "template_paused"
  | "template_resumed"
  | "send_blocked";

export interface OwnerControlAuditEntry {
  auditVersion: 1;
  businessId: string;
  objectType: OwnerControlObjectType;
  /** Version-row id (rules) or template-row id (templates). */
  objectId: string;
  /** Rules: "v<versionNumber>". Templates: the template key. */
  objectKey: string;
  action: OwnerControlAction;
  actorId: string;
  actorName: string;
  /** "human" for dashboard sessions, "api-key" for key auth. */
  actorType: "human" | "api-key";
  /** ISO timestamp, caller-supplied (test seam). */
  occurredAt: string;
  beforeSummary: string;
  afterSummary: string;
  /** Short machine-readable detail, e.g. "mirrored=false". */
  detail: string;
  /** Only for send_blocked entries: the gate's machine reason. */
  blockedReason: string | null;
}

export function deriveActorType(actorId: string): "human" | "api-key" {
  return actorId.startsWith("api-key:") ? "api-key" : "human";
}

/** Consistent rule summaries, so routes cannot invent wording. */
export function rulePauseBefore(versionNumber: number): string {
  return `LIVE v${versionNumber} active`;
}
export function rulePauseAfter(versionNumber: number): string {
  return `LIVE v${versionNumber} PAUSED (text preserved, version unchanged)`;
}
export function ruleResumeBefore(versionNumber: number): string {
  return `LIVE v${versionNumber} PAUSED (text preserved, version unchanged)`;
}
export function ruleResumeAfter(versionNumber: number): string {
  return `LIVE v${versionNumber} active (same text, same version)`;
}

/** Consistent template summaries, so routes cannot invent wording. */
export function templateBefore(
  status: string,
  textLength: number
): string {
  return `${status} (text ${textLength} chars)`;
}
export function templateAfter(
  status: string,
  textLength: number
): string {
  return `${status} (text ${textLength} chars)`;
}

/**
 * Build one audit entry. Refuses (returning a reason, writing
 * nothing) when identity or scope is missing — an unattributed
 * entry is worse than no entry, because it pretends to account.
 */
export function buildOwnerControlAuditEntry(args: {
  businessId: string | null;
  objectType: OwnerControlObjectType;
  objectId: string;
  objectKey: string;
  action: OwnerControlAction;
  actorId: string;
  actorName: string;
  occurredAt: string;
  beforeSummary: string;
  afterSummary: string;
  detail: string;
  blockedReason?: string | null;
}):
  | { ok: true; entry: OwnerControlAuditEntry }
  | { ok: false; reason: string } {
  const {
    businessId,
    objectType,
    objectId,
    objectKey,
    action,
    actorId,
    actorName,
    occurredAt,
    beforeSummary,
    afterSummary,
    detail,
    blockedReason,
  } = args;
  if (!businessId) return { ok: false, reason: "missing_business" };
  if (!objectId) return { ok: false, reason: "missing_object" };
  if (!actorId) return { ok: false, reason: "missing_actor" };
  if (!occurredAt) return { ok: false, reason: "missing_timestamp" };
  return {
    ok: true,
    entry: {
      auditVersion: OWNER_CONTROL_AUDIT_VERSION,
      businessId,
      objectType,
      objectId,
      objectKey,
      action,
      actorId,
      actorName,
      actorType: deriveActorType(actorId),
      occurredAt,
      beforeSummary,
      afterSummary,
      detail,
      blockedReason: blockedReason ?? null,
    },
  };
}

/**
 * Shape for the fail-closed blocked-send log line (routes pass this
 * object to logger.warn; the follow-up processor's own delivery
 * logging is unchanged). The blocked reason is a machine code, never
 * customer-facing copy, and no message text is ever logged here.
 */
export function blockedSendLog(args: {
  businessId: string;
  orderId: string;
  toStatus: string;
  reason: string;
}): {
  tag: string;
  businessId: string;
  orderId: string;
  toStatus: string;
  reason: string;
  sent: false;
} {
  return {
    tag: "owner-control-send-blocked",
    businessId: args.businessId,
    orderId: args.orderId,
    toStatus: args.toStatus,
    reason: args.reason,
    sent: false,
  };
}
