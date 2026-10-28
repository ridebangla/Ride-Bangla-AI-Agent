/**
 * offer-control-store.ts — LEG B (owner offer controls, staged).
 *
 * SERVER-ONLY store layer for src/lib/owner-controls/offer-controls.ts.
 * Never import from client components.
 *
 * WHAT IT WRITES:
 *  - Leg H `coupons` docs: adds/updates ONLY the control fields
 *    (status/pausedAt/pausedBy/updatedAt) and owner-edited offer fields.
 *    It never rewrites Leg H's application path and never touches the
 *    uses counter except by preserving it across a code rename.
 *  - Proposed incentive-control doc: staged video Leg D's
 *    `video_review_reward_configs/{businessId}` doc, extended with the
 *    control fields (status/pausedAt/pausedBy/currencyLabel/askText).
 *    This collection choice is PROPOSED + FLAGGED as owner decision O2
 *    (see LEG-REPORT.md); if the owner picks a different location, only
 *    INCENTIVE_CONTROL_COLLECTION below and the doc-shape mapping move.
 *  - Proposed audit collection `owner_control_audit`: one entry per
 *    mutation and per blocked send that the caller reports. Server
 *    writes only (see the Firestore-rules snippet in
 *    snippets/INTEGRATION-SNIPPETS.md — it folds into the owner's single
 *    final rules package, never a piecemeal deploy).
 *
 * TENANT RULES (fail-closed, on every function):
 *  - Empty businessId -> throws (mutations) or returns null/false
 *    (reads): never an unscoped write.
 *  - A doc whose stored businessId differs from the caller's -> treated
 *    as not found (reads) / refused with code "cross_tenant" (mutations),
 *    and NOTHING is written. The route layer maps cross_tenant to 404
 *    so one tenant's offer existence never leaks to another tenant.
 *  - Actor identity (actorId/actorRole) comes from the authenticated
 *    session (requireAuth), never from the request body.
 *  - Code rename (coupon code edit) runs inside ONE transaction:
 *    read old doc, validate, check the new code is free for this tenant,
 *    delete old + create new preserving uses/createdAt/status/paused
 *    markers, write the audit entry — or write nothing at all.
 *  - Pause/resume/edit are single-doc transactions so a concurrent
 *    application cannot interleave a uses increment with a pause: the
 *    transaction re-reads the doc, so a pause landing mid-application
 *    either precedes it (application then sees paused and blocks) or
 *    follows it (the already-stamped order keeps its line; pause blocks
 *    only NEW applications — history is never rewritten).
 *
 * This file has NO top-level side effects and NO static Firebase
 * imports: store access is via dynamic import inside the async
 * functions (Leg H's pattern), so the pure module stays testable
 * standalone and this file only needs a parse check here.
 */

import {
  validateCouponEdit,
  pauseCoupon,
  resumeCoupon,
  validateIncentiveEdit,
  pauseIncentive,
  resumeIncentive,
  summarizeCoupon,
  summarizeIncentive,
  buildAuditEntry,
  buildBlockedSendEntry,
  normalizeOfferCode,
  type CouponLike,
  type CouponEditPatch,
  type IncentiveControlDoc,
  type IncentiveEditPatch,
  type OwnerControlAuditEntry,
  OWNER_CONTROL_AUDIT_COLLECTION,
} from "./offer-controls";

export const COUPONS_COLLECTION = "coupons";
/** PROPOSED (owner decision O2): reuse of staged Leg D's collection. */
export const INCENTIVE_CONTROL_COLLECTION = "video_review_reward_configs";

type DocRef = {
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
};

type Tx = {
  get: (ref: unknown) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (ref: unknown, data: Record<string, unknown>) => void;
  update: (ref: unknown, data: Record<string, unknown>) => void;
  delete: (ref: unknown) => void;
};

type AdminDb = {
  collection: (name: string) => {
    doc: (id?: string) => DocRef & Record<string, unknown>;
    where: (f: string, op: string, v: unknown) => {
      get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>;
    };
  };
  runTransaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
};

async function getDb(): Promise<AdminDb> {
  const { getAdminDb } = await import("../firestore");
  return getAdminDb() as unknown as AdminDb;
}

function couponDocId(businessId: string, code: string): string {
  return `${businessId}_${normalizeOfferCode(code)}`;
}

function decodeCoupon(id: string, data: Record<string, unknown>): CouponLike {
  void id;
  return {
    businessId: String(data.businessId ?? ""),
    code: normalizeOfferCode(data.code),
    type: data.type as CouponLike["type"],
    value: Number(data.value ?? 0),
    expiresAt: String(data.expiresAt ?? ""),
    minOrder: Number(data.minOrder ?? 0),
    maxUses: Number(data.maxUses ?? 1),
    uses: Number(data.uses ?? 0),
    allowMultiple: Boolean(data.allowMultiple ?? false),
    createdAt: String(data.createdAt ?? ""),
    updatedAt: String(data.updatedAt ?? ""),
    status: (data.status as string | undefined) ?? undefined,
    pausedAt: typeof data.pausedAt === "string" ? data.pausedAt : null,
    pausedBy: typeof data.pausedBy === "string" ? data.pausedBy : null,
  };
}

function decodeIncentive(
  businessId: string,
  data: Record<string, unknown>
): IncentiveControlDoc {
  const askText =
    data.askText && typeof data.askText === "object"
      ? (data.askText as Record<string, unknown>)
      : {};
  return {
    businessId,
    amount: Number(data.amount ?? 0),
    expiresAt: String(data.expiresAt ?? ""),
    minOrder: Number(data.minOrder ?? 0),
    currencyLabel:
      typeof data.currencyLabel === "string" ? data.currencyLabel : null,
    askText: {
      en: typeof askText.en === "string" ? askText.en : null,
      bn: typeof askText.bn === "string" ? askText.bn : null,
    },
    status: (data.status as string | undefined) ?? undefined,
    pausedAt: typeof data.pausedAt === "string" ? data.pausedAt : null,
    pausedBy: typeof data.pausedBy === "string" ? data.pausedBy : null,
    updatedAt: String(data.updatedAt ?? ""),
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
  };
}

function auditData(entry: OwnerControlAuditEntry): Record<string, unknown> {
  return { ...entry };
}

/* ------------------------------------------------------------------ */
/* Coupons                                                             */
/* ------------------------------------------------------------------ */

/** Tenant-scoped coupon read (null when absent OR another tenant's). */
export async function getCouponControl(
  businessId: string,
  rawCode: string
): Promise<CouponLike | null> {
  if (!businessId) return null;
  const code = normalizeOfferCode(rawCode);
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) return null;
  const db = await getDb();
  const snap = await db.collection(COUPONS_COLLECTION).doc(couponDocId(businessId, code)).get();
  if (!snap.exists) return null;
  const coupon = decodeCoupon(couponDocId(businessId, code), snap.data() ?? {});
  if (coupon.businessId !== businessId) return null;
  return coupon;
}

export type CouponControlResult =
  | { ok: true; coupon: CouponLike; changed: boolean }
  | { ok: false; error: string; message: string };

/**
 * Owner coupon edit (incl. code rename). Actor comes from the session.
 * Returns cross_tenant without writing anything when the doc belongs to
 * another tenant; duplicate_code when a rename target already exists.
 */
export async function editCouponControl(args: {
  businessId: string;
  code: string;
  patch: CouponEditPatch;
  actorId: string;
  actorRole: string;
}): Promise<CouponControlResult> {
  if (!args.businessId) throw new Error("businessId is required.");
  const db = await getDb();
  const oldId = couponDocId(args.businessId, args.code);
  const nowIso = new Date().toISOString();
  return db.runTransaction(async (tx) => {
    const ref = db.collection(COUPONS_COLLECTION).doc(oldId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false, error: "not_found", message: "Coupon not found." };
    }
    const existing = decodeCoupon(oldId, snap.data() ?? {});
    if (existing.businessId !== args.businessId) {
      return { ok: false, error: "cross_tenant", message: "Coupon not found." };
    }
    const validated = validateCouponEdit(existing, args.patch);
    if (!validated.ok) {
      return { ok: false, error: validated.error, message: validated.message };
    }
    const before = summarizeCoupon(existing);
    const auditRef = db.collection(OWNER_CONTROL_AUDIT_COLLECTION).doc();
    if (validated.codeChanged) {
      const newId = couponDocId(args.businessId, validated.newCode);
      const clash = await tx.get(db.collection(COUPONS_COLLECTION).doc(newId));
      if (clash.exists) {
        return { ok: false, error: "duplicate_code", message: `Coupon code ${validated.newCode} already exists for this business.` };
      }
      // Rename: new doc preserves uses / createdAt / pause markers.
      const renamed: Record<string, unknown> = {
        ...validated.patch,
        businessId: args.businessId,
        uses: existing.uses,
        createdAt: existing.createdAt,
        updatedAt: nowIso,
        status: existing.status ?? "active",
        pausedAt: existing.pausedAt ?? null,
        pausedBy: existing.pausedBy ?? null,
      };
      tx.delete(ref);
      tx.set(db.collection(COUPONS_COLLECTION).doc(newId), renamed);
      const after = summarizeCoupon({ ...existing, ...validated.patch, status: existing.status ?? "active" });
      tx.set(auditRef, auditData(buildAuditEntry({
        businessId: args.businessId,
        actorId: args.actorId,
        actorRole: args.actorRole,
        action: "coupon_edited",
        targetKind: "coupon",
        targetId: validated.newCode,
        before: before as unknown as Record<string, unknown>,
        after: after as unknown as Record<string, unknown>,
      })));
      return { ok: true, coupon: decodeCoupon(newId, renamed), changed: true };
    }
    const patchData: Record<string, unknown> = { ...validated.patch, updatedAt: nowIso };
    tx.update(ref, patchData);
    const after = summarizeCoupon({ ...existing, ...validated.patch });
    tx.set(auditRef, auditData(buildAuditEntry({
      businessId: args.businessId,
      actorId: args.actorId,
      actorRole: args.actorRole,
      action: "coupon_edited",
      targetKind: "coupon",
      targetId: existing.code,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    })));
    return { ok: true, coupon: { ...existing, ...validated.patch, updatedAt: nowIso }, changed: true };
  });
}

/**
 * Owner coupon pause / resume. Idempotent: an already-paused coupon
 * paused again (or active resumed again) returns changed: false and
 * writes nothing — including no audit entry for the no-op.
 */
export async function setCouponPaused(args: {
  businessId: string;
  code: string;
  paused: boolean;
  actorId: string;
  actorRole: string;
}): Promise<CouponControlResult> {
  if (!args.businessId) throw new Error("businessId is required.");
  const db = await getDb();
  const id = couponDocId(args.businessId, args.code);
  return db.runTransaction(async (tx) => {
    const ref = db.collection(COUPONS_COLLECTION).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false, error: "not_found", message: "Coupon not found." };
    }
    const existing = decodeCoupon(id, snap.data() ?? {});
    if (existing.businessId !== args.businessId) {
      return { ok: false, error: "cross_tenant", message: "Coupon not found." };
    }
    const transition = args.paused
      ? pauseCoupon(existing, args.actorId)
      : resumeCoupon(existing, args.actorId);
    if (!transition.changed || !transition.patch) {
      return { ok: true, coupon: existing, changed: false };
    }
    const before = summarizeCoupon(existing);
    tx.update(ref, transition.patch as unknown as Record<string, unknown>);
    const afterCoupon: CouponLike = {
      ...existing,
      status: transition.patch.status,
      pausedAt: transition.patch.pausedAt,
      pausedBy: transition.patch.pausedBy,
      updatedAt: transition.patch.updatedAt,
    };
    const after = summarizeCoupon(afterCoupon);
    tx.set(db.collection(OWNER_CONTROL_AUDIT_COLLECTION).doc(), auditData(buildAuditEntry({
      businessId: args.businessId,
      actorId: args.actorId,
      actorRole: args.actorRole,
      action: args.paused ? "coupon_paused" : "coupon_resumed",
      targetKind: "coupon",
      targetId: existing.code,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    })));
    return { ok: true, coupon: afterCoupon, changed: true };
  });
}

/* ------------------------------------------------------------------ */
/* Video-review incentive                                              */
/* ------------------------------------------------------------------ */

/** Tenant-scoped incentive-control read (null when never configured). */
export async function getIncentiveControl(
  businessId: string
): Promise<IncentiveControlDoc | null> {
  if (!businessId) return null;
  const db = await getDb();
  const snap = await db.collection(INCENTIVE_CONTROL_COLLECTION).doc(businessId).get();
  if (!snap.exists) return null;
  const doc = decodeIncentive(businessId, snap.data() ?? {});
  if (doc.businessId !== businessId) return null;
  return doc;
}

export type IncentiveControlResult =
  | { ok: true; doc: IncentiveControlDoc; changed: boolean }
  | { ok: false; error: string; message: string };

/**
 * Owner incentive edit (create-or-update). The store writes the full
 * superset doc; Leg D's minOrder is preserved untouched on update and
 * defaults to 0 on create (Leg D's stated "no threshold" semantic).
 * Status is never changed by an edit (see validateIncentiveEdit).
 */
export async function editIncentiveControl(args: {
  businessId: string;
  patch: IncentiveEditPatch;
  actorId: string;
  actorRole: string;
}): Promise<IncentiveControlResult> {
  if (!args.businessId) throw new Error("businessId is required.");
  const db = await getDb();
  const nowIso = new Date().toISOString();
  return db.runTransaction(async (tx) => {
    const ref = db.collection(INCENTIVE_CONTROL_COLLECTION).doc(args.businessId);
    const snap = await tx.get(ref);
    const existing = snap.exists ? decodeIncentive(args.businessId, snap.data() ?? {}) : null;
    if (existing && existing.businessId !== args.businessId) {
      return { ok: false, error: "cross_tenant", message: "Incentive not found." };
    }
    const validated = validateIncentiveEdit(existing, args.patch);
    if (!validated.ok) {
      return { ok: false, error: validated.error, message: validated.message };
    }
    const before = existing ? summarizeIncentive(existing) : null;
    const doc: Record<string, unknown> = {
      businessId: args.businessId,
      amount: validated.value.amount,
      expiresAt: validated.value.expiresAt,
      minOrder: existing ? existing.minOrder : 0,
      currencyLabel: validated.value.currencyLabel,
      askText: validated.value.askText,
      status: existing ? (existing.status ?? "active") : "active",
      pausedAt: existing ? (existing.pausedAt ?? null) : null,
      pausedBy: existing ? (existing.pausedBy ?? null) : null,
      updatedAt: nowIso,
      updatedBy: args.actorId,
    };
    tx.set(ref, doc);
    const afterDoc = decodeIncentive(args.businessId, doc);
    const after = summarizeIncentive(afterDoc);
    tx.set(db.collection(OWNER_CONTROL_AUDIT_COLLECTION).doc(), auditData(buildAuditEntry({
      businessId: args.businessId,
      actorId: args.actorId,
      actorRole: args.actorRole,
      action: "incentive_edited",
      targetKind: "video_review_incentive",
      targetId: args.businessId,
      before: before as unknown as Record<string, unknown> | null,
      after: after as unknown as Record<string, unknown>,
    })));
    return { ok: true, doc: afterDoc, changed: true };
  });
}

/** Owner incentive pause / resume (idempotent, same guarantees). */
export async function setIncentivePaused(args: {
  businessId: string;
  paused: boolean;
  actorId: string;
  actorRole: string;
}): Promise<IncentiveControlResult> {
  if (!args.businessId) throw new Error("businessId is required.");
  const db = await getDb();
  return db.runTransaction(async (tx) => {
    const ref = db.collection(INCENTIVE_CONTROL_COLLECTION).doc(args.businessId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false, error: "not_found", message: "Incentive not configured." };
    }
    const existing = decodeIncentive(args.businessId, snap.data() ?? {});
    if (existing.businessId !== args.businessId) {
      return { ok: false, error: "cross_tenant", message: "Incentive not found." };
    }
    const transition = args.paused
      ? pauseIncentive(existing, args.actorId)
      : resumeIncentive(existing, args.actorId);
    if (!transition.changed || !transition.patch) {
      return { ok: true, doc: existing, changed: false };
    }
    const before = summarizeIncentive(existing);
    tx.update(ref, transition.patch as unknown as Record<string, unknown>);
    const afterDoc: IncentiveControlDoc = {
      ...existing,
      status: transition.patch.status,
      pausedAt: transition.patch.pausedAt,
      pausedBy: transition.patch.pausedBy,
      updatedAt: transition.patch.updatedAt,
    };
    const after = summarizeIncentive(afterDoc);
    tx.set(db.collection(OWNER_CONTROL_AUDIT_COLLECTION).doc(), auditData(buildAuditEntry({
      businessId: args.businessId,
      actorId: args.actorId,
      actorRole: args.actorRole,
      action: args.paused ? "incentive_paused" : "incentive_resumed",
      targetKind: "video_review_incentive",
      targetId: args.businessId,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    })));
    return { ok: true, doc: afterDoc, changed: true };
  });
}

/**
 * Append a blocked-send audit entry (best-effort: a trail-write failure
 * must never unblock a send — callers log the block first, then call
 * this; failures here are swallowed by the caller, never thrown up).
 */
export async function appendBlockedSendEntry(args: {
  businessId: string;
  actorId: string;
  actorRole: string;
  targetKind: "coupon" | "video_review_incentive";
  targetId: string;
  reason: "not_configured" | "paused" | "cross_tenant" | "invalid_config" | "malformed_status";
}): Promise<void> {
  if (!args.businessId) return;
  const db = await getDb();
  const entry = buildBlockedSendEntry(args);
  await db.runTransaction(async (tx) => {
    tx.set(
      db.collection(OWNER_CONTROL_AUDIT_COLLECTION).doc(),
      auditData(entry)
    );
  });
}
