/**
 * Owner message controls — store operations (LEG C, STAGED ONLY).
 * Depends ONLY on the pure module in this directory (relative import);
 * all I/O goes through the injected `db` so the harness can run this
 * file against a fake store and the route can pass the real prisma
 * delegates. This file never imports prisma, logger, or route-auth
 * itself — the route owns auth + logging.
 *
 * Tenancy: every operation re-checks that the loaded settings doc /
 * followUp record belongs to the caller's businessId. A mismatch is
 * refused with `cross_tenant` and writes NOTHING.
 *
 * Pause semantics (see the pure module): pausing a record sets ONLY
 * the owner-pause fields. It never changes status, dueAt, or message,
 * so resume restores the record byte-identically (unless a separate
 * audited edit changed the message in between). Editing a message
 * changes ONLY the message, and only while the record is pending.
 */

import {
  CONTROLLED_RECORD_KINDS,
  appendAudit,
  buildAuditEntry,
  familyForRecordKind,
  mergeControls,
  normalizeControls,
  scopeForRecordKind,
  summarizeControlChanges,
  validateControlPatch,
  type ControlActorType,
  type MessageControlState,
  type MessageFamily,
  type OwnerControlAuditEntry,
} from "./message-controls";

/** Minimal structural shape of the delegates this module uses. */
export interface MessageControlDb {
  settings: {
    findFirst(): Promise<Record<string, unknown> | null>;
    update(args: {
      where: { businessId: string };
      data: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
    upsert(args: {
      where: { businessId: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
  };
  followUp: {
    findUnique(args: { where: { id: string } }): Promise<Record<string, unknown> | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
  };
}

export interface ControlActor {
  type: ControlActorType;
  id: string | null;
}

export type StoreError =
  | "cross_tenant"
  | "settings_not_found"
  | "record_not_found"
  | "record_kind_not_controlled"
  | "record_not_pending"
  | "record_not_paused"
  | "message_empty"
  | "message_too_long"
  | "invalid_patch";

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError; detail?: string };

export const MAX_RECORD_MESSAGE_CHARS = 10000;

function businessOf(doc: Record<string, unknown>): string | null {
  return typeof doc.businessId === "string" ? doc.businessId : null;
}

/**
 * Append one audit entry to the settings doc's trail (upsert so the
 * trail exists even before any settings doc was created by the Settings
 * GET path). Record mutations and control mutations BOTH go through
 * here — there is no mutation path in this module that skips the trail.
 * LIMIT, stated plainly (same class as booking Leg B's audit note): a
 * record mutation is two writes (record + trail), not one transaction.
 * If the second write fails, the caller gets an error and must surface
 * it; the record change itself is not rolled back by this module.
 */
async function appendSettingsAudit(
  db: MessageControlDb,
  businessId: string,
  entry: OwnerControlAuditEntry
): Promise<void> {
  const doc = await db.settings.findFirst();
  if (doc && businessOf(doc) !== businessId) throw new Error("cross_tenant");
  const audit = appendAudit(
    doc ? (doc.messageControlsAudit as OwnerControlAuditEntry[] | undefined) : null,
    entry
  );
  await db.settings.upsert({
    where: { businessId },
    update: { messageControlsAudit: audit },
    create: { businessId, messageControlsAudit: audit },
  });
}

/** Load the caller's controls (normalised). No doc yet = defaults. */
export async function loadControls(
  db: MessageControlDb,
  businessId: string
): Promise<
  | { ok: true; controls: MessageControlState; settingsDoc: Record<string, unknown> | null }
  | { ok: false; error: StoreError }
> {
  const doc = await db.settings.findFirst();
  if (doc && businessOf(doc) !== businessId) return { ok: false, error: "cross_tenant" };
  return {
    ok: true,
    controls: normalizeControls(doc ? doc.messageControls : null),
    settingsDoc: doc,
  };
}

/**
 * Apply a validated control patch: deep-merge + audit append, in one
 * settings-doc write. Returns the new state and the audit entry.
 * A patch that changes nothing still writes nothing (no empty entry).
 */
export async function updateControls(
  db: MessageControlDb,
  input: {
    businessId: string;
    actor: ControlActor;
    patch: unknown;
    atIso: string;
    entryId: string;
  }
): Promise<
  StoreResult<{ controls: MessageControlState; auditEntry: OwnerControlAuditEntry | null }>
> {
  const validation = validateControlPatch(input.patch);
  if (!validation.ok) {
    return { ok: false, error: "invalid_patch", detail: validation.error };
  }
  const loaded = await loadControls(db, input.businessId);
  if (!loaded.ok) return loaded;
  const before = loaded.controls;
  const after = mergeControls(before, input.patch as Record<string, unknown>);
  const changes = summarizeControlChanges(before, after);
  if (changes.length === 0) return { ok: true, value: { controls: after, auditEntry: null } };
  // The entry's family/scope are for filtering only: family = the first
  // change's family, scope = that change's scope only when the patch
  // touched exactly one scope. `changes` itself is authoritative and
  // carries every family's every field.
  const entry = buildAuditEntry({
    id: input.entryId,
    businessId: input.businessId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    at: input.atIso,
    action: "controls_updated",
    family: changes[0].family,
    scope: changes.length === 1 ? changes[0].scope : null,
    recordId: null,
    changes,
  });
  const audit = appendAudit(
    loaded.settingsDoc ? (loaded.settingsDoc.messageControlsAudit as OwnerControlAuditEntry[]) : null,
    entry
  );
  await db.settings.upsert({
    where: { businessId: input.businessId },
    update: { messageControls: after, messageControlsAudit: audit },
    create: { businessId: input.businessId, messageControls: after, messageControlsAudit: audit },
  });
  return { ok: true, value: { controls: after, auditEntry: entry } };
}

/** Load + tenant-check one followUp record. */
async function loadRecord(
  db: MessageControlDb,
  businessId: string,
  recordId: string
): Promise<StoreResult<Record<string, unknown>>> {
  const rec = await db.followUp.findUnique({ where: { id: recordId } });
  if (!rec) return { ok: false, error: "record_not_found" };
  if (businessOf(rec) !== businessId) return { ok: false, error: "cross_tenant" };
  return { ok: true, value: rec };
}

function recordFamilyAndScope(rec: Record<string, unknown>): {
  family: MessageFamily;
  scope: string;
} | null {
  const kind = typeof rec.kind === "string" ? rec.kind : null;
  if (!kind || !CONTROLLED_RECORD_KINDS.includes(kind)) return null;
  const family = familyForRecordKind(kind);
  if (!family) return null;
  let scope = scopeForRecordKind(kind);
  if (kind === "booking_reminder") {
    scope = typeof rec.slot === "string" ? rec.slot : null;
    if (scope !== "day_before" && scope !== "hours_before") return null;
  }
  if (!scope) return null;
  return { family, scope };
}

/** Edit a PENDING record's message (audited, before/after full text). */
export async function editRecordMessage(
  db: MessageControlDb,
  input: {
    businessId: string;
    actor: ControlActor;
    recordId: string;
    message: string;
    atIso: string;
    entryId: string;
  }
): Promise<StoreResult<{ recordId: string; message: string }>> {
  if (typeof input.message !== "string" || input.message.trim() === "") {
    return { ok: false, error: "message_empty" };
  }
  if (input.message.length > MAX_RECORD_MESSAGE_CHARS) {
    return { ok: false, error: "message_too_long" };
  }
  const loaded = await loadRecord(db, input.businessId, input.recordId);
  if (!loaded.ok) return loaded;
  const rec = loaded.value;
  const fs = recordFamilyAndScope(rec);
  if (!fs) return { ok: false, error: "record_kind_not_controlled" };
  if (rec.status !== "pending") return { ok: false, error: "record_not_pending" };
  const before = typeof rec.message === "string" ? rec.message : "";
  const entry = buildAuditEntry({
    id: input.entryId,
    businessId: input.businessId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    at: input.atIso,
    action: "record_message_edited",
    family: fs.family,
    scope: fs.scope,
    recordId: input.recordId,
    changes: [{ family: fs.family, field: "message", scope: fs.scope, before, after: input.message }],
  });
  await db.followUp.update({
    where: { id: input.recordId },
    data: { message: input.message },
  });
  await appendSettingsAudit(db, input.businessId, entry);
  return { ok: true, value: { recordId: input.recordId, message: input.message } };
}

/**
 * Pause one PENDING record. Sets ONLY owner-pause fields; status,
 * dueAt, and message are untouched, so resume is byte-exact.
 */
export async function pauseRecord(
  db: MessageControlDb,
  input: {
    businessId: string;
    actor: ControlActor;
    recordId: string;
    pausedUntil: string | null;
    note: string | null;
    atIso: string;
    entryId: string;
  }
): Promise<StoreResult<{ recordId: string }>> {
  const loaded = await loadRecord(db, input.businessId, input.recordId);
  if (!loaded.ok) return loaded;
  const rec = loaded.value;
  const fs = recordFamilyAndScope(rec);
  if (!fs) return { ok: false, error: "record_kind_not_controlled" };
  if (rec.status !== "pending") return { ok: false, error: "record_not_pending" };
  const beforePaused = rec.ownerPaused === true;
  await db.followUp.update({
    where: { id: input.recordId },
    data: {
      ownerPaused: true,
      ownerPausedAt: input.atIso,
      ownerPausedUntil: input.pausedUntil,
      ownerPauseNote: input.note,
    },
  });
  await appendSettingsAudit(
    db,
    input.businessId,
    buildAuditEntry({
      id: input.entryId,
      businessId: input.businessId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      at: input.atIso,
      action: "record_paused",
      family: fs.family,
      scope: fs.scope,
      recordId: input.recordId,
      changes: [
        {
          family: fs.family,
          field: "ownerPaused",
          scope: fs.scope,
          before: beforePaused,
          after: true,
        },
      ],
    })
  );
  return { ok: true, value: { recordId: input.recordId } };
}

/** Resume one record: clears ONLY the owner-pause fields. */
export async function resumeRecord(
  db: MessageControlDb,
  input: {
    businessId: string;
    actor: ControlActor;
    recordId: string;
    atIso: string;
    entryId: string;
  }
): Promise<StoreResult<{ recordId: string }>> {
  const loaded = await loadRecord(db, input.businessId, input.recordId);
  if (!loaded.ok) return loaded;
  const rec = loaded.value;
  const fs = recordFamilyAndScope(rec);
  if (!fs) return { ok: false, error: "record_kind_not_controlled" };
  if (rec.ownerPaused !== true) return { ok: false, error: "record_not_paused" };
  await db.followUp.update({
    where: { id: input.recordId },
    data: {
      ownerPaused: false,
      ownerPausedAt: null,
      ownerPausedUntil: null,
      ownerPauseNote: null,
    },
  });
  await appendSettingsAudit(
    db,
    input.businessId,
    buildAuditEntry({
      id: input.entryId,
      businessId: input.businessId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      at: input.atIso,
      action: "record_resumed",
      family: fs.family,
      scope: fs.scope,
      recordId: input.recordId,
      changes: [
        { family: fs.family, field: "ownerPaused", scope: fs.scope, before: true, after: false },
      ],
    })
  );
  return { ok: true, value: { recordId: input.recordId } };
}
