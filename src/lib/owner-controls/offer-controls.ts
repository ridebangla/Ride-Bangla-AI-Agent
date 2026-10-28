/**
 * offer-controls.ts — LEG B (owner offer controls, staged).
 *
 * OWNER DOCTRINE (2026-10-25, FIRM, safety-critical) this module enforces:
 *  (1) Every offer / reply-rule is editable by the shop owner himself.
 *  (2) Every offer can be PAUSED (temporary off) WITHOUT deleting it, and
 *      RESUMED to exactly what was paused — never reset, never regenerated.
 *  (3) The AI NEVER sends an offer on its own: if the owner has not
 *      enabled it, nothing goes out.
 *  (4) Fail-closed: paused, disabled, malformed, or missing config means
 *      NOTHING goes out — never a guessed amount or text. Every block is
 *      returned as a machine code so the caller can log it.
 *
 * SCOPE OF THIS MODULE (pure logic only — no imports, no I/O):
 *  - Coupon edit + pause/resume, layered on staged Presswayy Leg H
 *    coupons (src/lib/coupons.ts). This module does NOT rewrite Leg H's
 *    send/apply path: Leg H's `validateCoupon` / `decideCouponApplication`
 *    gain a pause branch via a separate layering diff (diffs/001), and
 *    this module is the single definition of the pause/edit rules that
 *    the layering diff and the store both use.
 *  - Video-review incentive edit + pause/resume, layered on staged video
 *    Leg B (ask validation/rendering) and Leg D (reward config). Storage
 *    location is PROPOSED in LEG-REPORT.md (extend Leg D's
 *    `video_review_reward_configs/{businessId}` doc) and FLAGGED as an
 *    owner decision — this module does not silently pick a conflicting
 *    store. The doc shape below is that proposal's shape.
 *  - Audit-trail entry shape (PROPOSAL — see LEG-REPORT.md §7). No
 *    owner-controls Leg E trail contract was found in this workspace,
 *    so this shape is defined here and flagged for reconciliation with
 *    Leg E; it must be REPLACED by Leg E's contract at wiring time if
 *    Leg E defines one, never run as a second trail system.
 *  - Welcome credit: DELIBERATELY NOT built here. It is a platform-admin
 *    GTM offer (staged Presswayy Leg G, `ai_gtm_config/current`), not a
 *    tenant shop offer, so it does not fit this tenant offer surface.
 *    See LEG-REPORT.md §5 for the flagged gap + proposed location.
 *
 * DEPENDENCY NOTE: coupon / incentive shapes below are structural
 * ("Like" interfaces) mirroring Leg H / Leg B / Leg D staged shapes, so
 * this module stays import-free and testable standalone. At wiring time
 * the store passes real Leg H / Leg D records into these functions; the
 * harness proves the composition against the staged Leg H + Leg B files.
 *
 * NO DEFAULTS, NO INVENTED FIGURES: every amount, expiry, and text in a
 * code path is owner-supplied or rejected. Demo figures from any shared
 * video (e.g. playbook-example amounts) appear nowhere here — not as
 * defaults, not as fixtures in this module. All owner-facing labels in
 * comments are PROPOSALS for owner approval, never shipped copy.
 * NO FARE LOGIC: nothing here touches fares, delivery pricing, or
 * courier charges. NO LIMIT LOGIC: nothing here meters, counts against
 * quotas, or changes the limit model (company unlimited; trial no usage
 * quotas; free tier ~100 msgs/month — all untouched).
 */

export type OfferStatus = "active" | "paused";

/** Machine codes for "this offer must not go out". Never customer copy. */
export type OfferBlockReason =
  | "not_configured"
  | "paused"
  | "cross_tenant"
  | "invalid_config"
  | "malformed_status";

/** Machine codes for failed owner mutations. Never customer copy. */
export type OfferControlError =
  | "not_found"
  | "cross_tenant"
  | "invalid_edit"
  | "no_changes"
  | "immutable_field"
  | "duplicate_code"
  | "max_uses_below_uses"
  | "missing_business_id";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isRealLastValidDay(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function hasAtMostTwoDecimals(n: number): boolean {
  return Math.round(n * 100) === n * 100;
}

export function normalizeOfferCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

/**
 * Resolve an offer's control status from its stored record.
 *
 *  - status === "paused"  -> "paused"  (blocks every send).
 *  - status === "active"  -> "active".
 *  - status absent (undefined/null) -> "active" (LEGACY COMPATIBILITY).
 *    Coupons created by Leg H before this control existed carry no
 *    status field; they were created as live offers. Treating them as
 *    paused would silently kill every pre-existing coupon on deploy.
 *    This is the ONE deliberate exception to "missing = blocked", and
 *    it is flagged as owner decision O-C1 in LEG-REPORT.md: if the owner
 *    wants strict fail-closed for legacy coupons, the wiring leg flips
 *    this branch to "paused" — a one-line change, documented there.
 *  - any other value -> "paused" (FAIL-CLOSED on malformed status:
 *    a corrupted status must never be read as permission to send).
 */
export function resolveOfferStatus(record: {
  status?: unknown;
}): OfferStatus {
  const s = record.status;
  if (s === undefined || s === null) return "active";
  if (s === "paused") return "paused";
  if (s === "active") return "active";
  return "paused";
}

/** True when the stored status field itself is malformed (not absent). */
export function hasMalformedStatus(record: { status?: unknown }): boolean {
  const s = record.status;
  return s !== undefined && s !== null && s !== "active" && s !== "paused";
}

/* ------------------------------------------------------------------ */
/* 1. COUPONS — edit + pause/resume (on staged Leg H coupons)         */
/* ------------------------------------------------------------------ */

/**
 * Structural mirror of Leg H's Coupon, plus the control fields this leg
 * adds. `status`/`pausedAt`/`pausedBy` are optional because Leg H docs
 * created before this leg have none of them (see resolveOfferStatus).
 */
export interface CouponLike {
  businessId: string;
  code: string;
  type: "percentage" | "flat" | "free_delivery";
  value: number;
  /** Last valid day, "YYYY-MM-DD" (Leg H UTC end-of-day semantics). */
  expiresAt: string;
  minOrder: number;
  maxUses: number;
  uses: number;
  allowMultiple: boolean;
  createdAt: string;
  updatedAt: string;
  status?: unknown;
  pausedAt?: string | null;
  pausedBy?: string | null;
}

export interface CouponSummary {
  code: string;
  type: string;
  value: number;
  expiresAt: string;
  minOrder: number;
  maxUses: number;
  uses: number;
  allowMultiple: boolean;
  status: OfferStatus;
}

/** Field-level before/after summary for the audit trail (no secrets). */
export function summarizeCoupon(coupon: CouponLike): CouponSummary {
  return {
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    expiresAt: coupon.expiresAt,
    minOrder: coupon.minOrder,
    maxUses: coupon.maxUses,
    uses: coupon.uses,
    allowMultiple: coupon.allowMultiple,
    status: resolveOfferStatus(coupon),
  };
}

/**
 * THE send gate for coupons. Call BEFORE Leg H's validateCoupon (and
 * before any preview/apply): a non-null reason means NOTHING goes out.
 *  - null coupon            -> "not_configured" (never a discount).
 *  - business mismatch      -> "cross_tenant". Callers MUST map this to
 *    "not_found" on any customer-visible path so one tenant's coupon
 *    existence never leaks to another tenant (Leg H already does this
 *    for lookups; the layering diff keeps it).
 *  - malformed status       -> "malformed_status" (fail-closed).
 *  - status paused          -> "paused".
 *  - otherwise              -> null (sendable; Leg H validation still
 *    applies expiry / uses / minimum on top of this gate).
 */
export function couponSendBlockReason(
  coupon: CouponLike | null,
  callerBusinessId: string
): OfferBlockReason | null {
  if (!coupon) return "not_configured";
  if (!callerBusinessId || coupon.businessId !== callerBusinessId) {
    return "cross_tenant";
  }
  if (hasMalformedStatus(coupon)) return "malformed_status";
  if (resolveOfferStatus(coupon) === "paused") return "paused";
  return null;
}

export function isCouponSendable(
  coupon: CouponLike | null,
  callerBusinessId: string
): boolean {
  return couponSendBlockReason(coupon, callerBusinessId) === null;
}

/** Owner-editable coupon fields. Anything else in a patch is rejected. */
export interface CouponEditPatch {
  code?: unknown;
  type?: unknown;
  value?: unknown;
  expiresAt?: unknown;
  minOrder?: unknown;
  maxUses?: unknown;
  allowMultiple?: unknown;
  /** Any of these keys present in a patch is an immutable-field error. */
  businessId?: unknown;
  uses?: unknown;
  status?: unknown;
  pausedAt?: unknown;
  pausedBy?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CouponEditResult =
  | {
      ok: true;
      /** Fields to write (offer fields only — never status/uses). */
      patch: {
        code: string;
        type: CouponLike["type"];
        value: number;
        expiresAt: string;
        minOrder: number;
        maxUses: number;
        allowMultiple: boolean;
      };
      /** True when the code itself changed (store must rename the doc). */
      codeChanged: boolean;
      oldCode: string;
      newCode: string;
    }
  | { ok: false; error: OfferControlError; message: string };

/**
 * Validate an owner coupon edit against the CURRENT record.
 * Rules (all fail-closed, no defaults filled):
 *  - Empty patch -> "no_changes".
 *  - businessId / uses / status / paused* / createdAt / updatedAt in the
 *    patch -> "immutable_field". Status changes ONLY via pause/resume;
 *    uses move ONLY via Leg H's transactional application.
 *  - Each supplied field is validated with Leg H's own rules (code
 *    charset, percentage (0,100], flat > 0, free_delivery value 0/omit,
 *    real YYYY-MM-DD expiry, minOrder >= 0, maxUses integer >= 1).
 *  - maxUses below current uses -> "max_uses_below_uses" (never create
 *    an instantly-exhausted coupon by silent clamp).
 *  - Edit NEVER touches status: editing a paused coupon keeps it paused;
 *    editing an active coupon keeps it active. The returned patch
 *    contains offer fields only, so the store cannot smuggle a status
 *    change through an edit.
 *  - Edit NEVER rewrites history: uses, createdAt, and (on rename) the
 *    paused state are preserved by the store, not by this patch.
 */
export function validateCouponEdit(
  existing: CouponLike,
  patch: CouponEditPatch
): CouponEditResult {
  const keys = [
    "code",
    "type",
    "value",
    "expiresAt",
    "minOrder",
    "maxUses",
    "allowMultiple",
  ] as const;
  const supplied = keys.filter(
    (k) => patch[k] !== undefined
  );
  for (const imm of [
    "businessId",
    "uses",
    "status",
    "pausedAt",
    "pausedBy",
    "createdAt",
    "updatedAt",
  ] as const) {
    if (patch[imm] !== undefined) {
      return {
        ok: false,
        error: "immutable_field",
        message: `Field ${imm} cannot be changed by editing; use pause/resume or the coupon application path.`,
      };
    }
  }
  if (supplied.length === 0) {
    return { ok: false, error: "no_changes", message: "No editable field supplied." };
  }

  let code = existing.code;
  if (patch.code !== undefined) {
    code = normalizeOfferCode(patch.code);
    if (!CODE_RE.test(code)) {
      return {
        ok: false,
        error: "invalid_edit",
        message:
          "Coupon code must be 3-32 characters of letters, digits, hyphen or underscore (no spaces).",
      };
    }
  }

  let type = existing.type;
  if (patch.type !== undefined) {
    if (patch.type !== "percentage" && patch.type !== "flat" && patch.type !== "free_delivery") {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Coupon type must be percentage, flat, or free_delivery.",
      };
    }
    type = patch.type;
  }

  let value = existing.value;
  if (patch.value !== undefined) {
    const v = Number(patch.value);
    if (type === "percentage") {
      if (!Number.isFinite(v) || v <= 0 || v > 100) {
        return {
          ok: false,
          error: "invalid_edit",
          message: "Percentage value must be > 0 and <= 100.",
        };
      }
    } else if (type === "flat") {
      if (!Number.isFinite(v) || v <= 0) {
        return {
          ok: false,
          error: "invalid_edit",
          message: "Flat value must be > 0.",
        };
      }
    } else if (patch.value !== null && patch.value !== "" && Number(patch.value) !== 0) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Free-delivery coupons carry no value (pass 0 or omit it).",
      };
    }
    value = type === "free_delivery" ? 0 : round2(v);
  } else if (type === "free_delivery" && existing.type !== "free_delivery") {
    // Type changed to free_delivery without a value: value becomes 0.
    value = 0;
  } else if (type !== existing.type && type !== "free_delivery") {
    // Type changed but no value supplied: the old value's validity under
    // the new type is re-checked (e.g. a flat 150 becoming a percentage).
    if (type === "percentage" && (value <= 0 || value > 100)) {
      return {
        ok: false,
        error: "invalid_edit",
        message:
          "Existing value is not valid for the new type; supply a value with the edit.",
      };
    }
  }

  let expiresAt = existing.expiresAt;
  if (patch.expiresAt !== undefined) {
    const e = String(patch.expiresAt ?? "").trim();
    if (!isRealLastValidDay(e)) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Expiry must be a valid last day as YYYY-MM-DD.",
      };
    }
    expiresAt = e;
  }

  let minOrder = existing.minOrder;
  if (patch.minOrder !== undefined) {
    const m = Number(patch.minOrder);
    if (!Number.isFinite(m) || m < 0) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Minimum order must be a number >= 0.",
      };
    }
    minOrder = round2(m);
  }

  let maxUses = existing.maxUses;
  if (patch.maxUses !== undefined) {
    const mu = Number(patch.maxUses);
    if (!Number.isInteger(mu) || mu < 1) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Max uses must be a whole number >= 1.",
      };
    }
    if (mu < existing.uses) {
      return {
        ok: false,
        error: "max_uses_below_uses",
        message: `Max uses (${mu}) cannot be below uses already consumed (${existing.uses}).`,
      };
    }
    maxUses = mu;
  }

  let allowMultiple = existing.allowMultiple;
  if (patch.allowMultiple !== undefined) {
    allowMultiple = Boolean(patch.allowMultiple);
  }

  return {
    ok: true,
    patch: { code, type, value, expiresAt, minOrder, maxUses, allowMultiple },
    codeChanged: code !== existing.code,
    oldCode: existing.code,
    newCode: code,
  };
}

export interface PauseResumeResult {
  /** False when the coupon is already in the requested state (no-op). */
  changed: boolean;
  /** Firestore patch to write, or null for a no-op. */
  patch: {
    status: OfferStatus;
    pausedAt: string | null;
    pausedBy: string | null;
    updatedAt: string;
  } | null;
}

/**
 * Pause a coupon. Idempotent: pausing an already-paused coupon is a
 * no-op (changed: false, patch: null) — no audit churn, no state change.
 * Pause touches ONLY status/pausedAt/pausedBy/updatedAt. Code, amount,
 * expiry, terms, and the uses counter are never touched by a pause.
 */
export function pauseCoupon(
  coupon: CouponLike,
  actorId: string,
  nowMs = Date.now()
): PauseResumeResult {
  if (resolveOfferStatus(coupon) === "paused") {
    return { changed: false, patch: null };
  }
  return {
    changed: true,
    patch: {
      status: "paused",
      pausedAt: new Date(nowMs).toISOString(),
      pausedBy: actorId,
      updatedAt: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * Resume a coupon. Restores EXACTLY what was paused: the patch touches
 * only status/pausedAt/pausedBy/updatedAt, clearing the pause markers.
 * Code, amount, expiry, terms, uses, and createdAt are byte-identical
 * before pause and after resume — the harness asserts this field by
 * field. Resuming an active coupon is a no-op.
 */
export function resumeCoupon(
  coupon: CouponLike,
  _actorId: string,
  nowMs = Date.now()
): PauseResumeResult {
  if (resolveOfferStatus(coupon) === "active") {
    return { changed: false, patch: null };
  }
  return {
    changed: true,
    patch: {
      status: "active",
      pausedAt: null,
      pausedBy: null,
      updatedAt: new Date(nowMs).toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. VIDEO-REVIEW INCENTIVE — edit + pause/resume                     */
/*                                                                     */
/* Storage proposal (FLAGGED owner decision O2 — see LEG-REPORT.md):   */
/* extend staged video Leg D's `video_review_reward_configs/{id}` doc  */
/* (doc id = businessId) with the control fields below, so the amount  */
/* the ask promises and the amount the reward mints can never drift.  */
/* Canonical stored expiry field is Leg D's `expiresAt`; this module   */
/* maps it to Leg B's ask-shape `expiry` when building the ask input.  */
/* ------------------------------------------------------------------ */

/**
 * Proposed stored incentive-control doc (superset of Leg D's reward
 * config {amount, expiresAt, minOrder, updatedAt}).
 *  - amount / expiresAt / minOrder: Leg D's fields, same meanings.
 *    minOrder is reward-only and is NEVER edited through this leg's
 *    incentive edit (see validateIncentiveEdit): the ask promises an
 *    amount, not a threshold.
 *  - currencyLabel: Leg B's ask-rendering label, or null when the
 *    tenant set none. Never defaulted by this module.
 *  - askText: per-language ask-text OVERRIDES (PROPOSAL wording, owner
 *    approval required). null = use Leg B's template text for that
 *    language. An override is stored verbatim and never machine-
 *    translated; a missing language falls back to the template.
 *  - status / pausedAt / pausedBy: this leg's control fields.
 */
export interface IncentiveControlDoc {
  businessId: string;
  amount: number;
  expiresAt: string;
  minOrder: number;
  currencyLabel: string | null;
  askText: { en: string | null; bn: string | null };
  status?: unknown;
  pausedAt?: string | null;
  pausedBy?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface IncentiveSummary {
  amount: number;
  expiresAt: string;
  minOrder: number;
  currencyLabel: string | null;
  askText: { en: string | null; bn: string | null };
  status: OfferStatus;
}

export function summarizeIncentive(doc: IncentiveControlDoc): IncentiveSummary {
  return {
    amount: doc.amount,
    expiresAt: doc.expiresAt,
    minOrder: doc.minOrder,
    currencyLabel: doc.currencyLabel,
    askText: { en: doc.askText.en, bn: doc.askText.bn },
    status: resolveOfferStatus(doc),
  };
}

/** Leg B ask-shape incentive built from a control doc (expiry mapped). */
export interface AskIncentive {
  businessId: string;
  type: "flat";
  amount: number;
  currencyLabel: string | null;
  expiry: string;
}

export type IncentiveResolveResult =
  | {
      ok: true;
      /** Ask-shape incentive, or null when no offer line may render. */
      incentive: AskIncentive | null;
      /** Ask-text overrides to apply at render time (null = template). */
      askText: { en: string | null; bn: string | null };
      reason: "ok" | "not_configured";
    }
  | {
      ok: false;
      incentive: null;
      askText: { en: string | null; bn: string | null };
      reason: OfferBlockReason;
    };

function isValidIncentiveValues(doc: {
  amount: unknown;
  expiresAt: unknown;
}): boolean {
  return (
    typeof doc.amount === "number" &&
    Number.isFinite(doc.amount) &&
    doc.amount > 0 &&
    hasAtMostTwoDecimals(doc.amount) &&
    isRealLastValidDay(doc.expiresAt)
  );
}

/**
 * THE ask gate. The sender calls this BEFORE Leg B's renderVideoReviewAsk
 * and passes `incentive` (possibly null) into the render input:
 *  - doc null/undefined       -> ok, incentive null ("not_configured"):
 *    the ask renders with NO offer line (Leg B's existing behaviour).
 *  - business mismatch        -> blocked "cross_tenant", incentive null,
 *    and NO amount/expiry/ask-text leaks in the result.
 *  - malformed status         -> blocked, fail-closed.
 *  - status paused            -> blocked "paused": no offer line, and
 *    (via resolveIncentiveForReward) no reward either.
 *  - invalid amount/expiry    -> blocked "invalid_config": never render
 *    a guessed figure from a corrupt doc.
 *  - otherwise                -> ok, incentive built verbatim from the
 *    owner's own amount / currencyLabel / expiry.
 */
export function resolveIncentiveForAsk(
  doc: IncentiveControlDoc | null | undefined,
  callerBusinessId: string
): IncentiveResolveResult {
  const emptyText = { en: null, bn: null };
  if (!doc) {
    return { ok: true, incentive: null, askText: emptyText, reason: "not_configured" };
  }
  if (!callerBusinessId || doc.businessId !== callerBusinessId) {
    return { ok: false, incentive: null, askText: emptyText, reason: "cross_tenant" };
  }
  if (hasMalformedStatus(doc)) {
    return { ok: false, incentive: null, askText: emptyText, reason: "malformed_status" };
  }
  if (resolveOfferStatus(doc) === "paused") {
    return { ok: false, incentive: null, askText: emptyText, reason: "paused" };
  }
  if (!isValidIncentiveValues(doc)) {
    return { ok: false, incentive: null, askText: emptyText, reason: "invalid_config" };
  }
  return {
    ok: true,
    incentive: {
      businessId: doc.businessId,
      type: "flat",
      amount: doc.amount,
      currencyLabel: doc.currencyLabel,
      expiry: doc.expiresAt,
    },
    askText: { en: doc.askText.en, bn: doc.askText.bn },
    reason: "ok",
  };
}

export type IncentiveRewardResult =
  | {
      ok: true;
      config: { amount: number; expiresAt: string; minOrder: number };
    }
  | { ok: false; reason: OfferBlockReason };

/**
 * THE reward gate. The reward leg calls this BEFORE minting any coupon:
 * a paused / missing / invalid / cross-tenant incentive issues NOTHING.
 * A block here writes NO issuance record and NO coupon, so a later
 * resume does not retroactively burn the receipt — but whether a
 * pre-pause ask's promise should still be honoured after a pause is an
 * OPEN owner decision (O-C3 in LEG-REPORT.md): this module follows the
 * task's explicit rule (paused = no reward issued) and flags the tension
 * instead of silently grandfathering.
 */
export function resolveIncentiveForReward(
  doc: IncentiveControlDoc | null | undefined,
  callerBusinessId: string
): IncentiveRewardResult {
  if (!doc) return { ok: false, reason: "not_configured" };
  if (!callerBusinessId || doc.businessId !== callerBusinessId) {
    return { ok: false, reason: "cross_tenant" };
  }
  if (hasMalformedStatus(doc)) return { ok: false, reason: "malformed_status" };
  if (resolveOfferStatus(doc) === "paused") return { ok: false, reason: "paused" };
  if (!isValidIncentiveValues(doc)) return { ok: false, reason: "invalid_config" };
  return {
    ok: true,
    config: { amount: doc.amount, expiresAt: doc.expiresAt, minOrder: doc.minOrder },
  };
}

/** Owner-editable incentive fields (status is NOT editable here). */
export interface IncentiveEditPatch {
  amount?: unknown;
  currencyLabel?: unknown;
  expiresAt?: unknown;
  askText?: unknown;
  /** Any of these keys present is an immutable-field error. */
  businessId?: unknown;
  status?: unknown;
  pausedAt?: unknown;
  pausedBy?: unknown;
  minOrder?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

export type IncentiveEditResult =
  | {
      ok: true;
      /** Full stored values after the edit (for the store to write). */
      value: {
        amount: number;
        currencyLabel: string | null;
        expiresAt: string;
        askText: { en: string | null; bn: string | null };
      };
      /** True when this edit creates the doc (no doc existed before). */
      created: boolean;
    }
  | { ok: false; error: OfferControlError; message: string };

/**
 * Validate an owner incentive edit (create-or-update).
 *  - Creating (existing null) REQUIRES amount + expiresAt; anything
 *    missing is rejected with Leg B's codes ("missing_amount" /
 *    "missing_expiry" wording in message) — never defaulted.
 *  - Updating with no supplied field -> "no_changes".
 *  - status / minOrder / businessId / paused* in the patch ->
 *    "immutable_field": pause/resume own status; minOrder stays owned
 *    by Leg D's reward-config path (see LEG-REPORT.md §3 boundary).
 *  - amount: > 0, at most 2 decimals (Leg B's rule, mirrored).
 *  - expiresAt: real YYYY-MM-DD last valid day.
 *  - currencyLabel: string or null (null/empty clears it; never invented).
 *  - askText: {en?, bn?} partial overrides; a supplied language replaces
 *    that language only, the other language's override is preserved.
 *    An explicit null clears that language's override back to template.
 *  - Edit NEVER changes status: a paused incentive stays paused after
 *    an edit, so an owner cannot accidentally re-enable an offer by
 *    editing its amount.
 */
export function validateIncentiveEdit(
  existing: IncentiveControlDoc | null,
  patch: IncentiveEditPatch
): IncentiveEditResult {
  for (const imm of [
    "businessId",
    "status",
    "pausedAt",
    "pausedBy",
    "minOrder",
    "updatedAt",
    "updatedBy",
  ] as const) {
    if (patch[imm] !== undefined) {
      return {
        ok: false,
        error: "immutable_field",
        message: `Field ${imm} cannot be changed by editing the incentive.`,
      };
    }
  }
  const supplied =
    patch.amount !== undefined ||
    patch.currencyLabel !== undefined ||
    patch.expiresAt !== undefined ||
    patch.askText !== undefined;
  if (!supplied) {
    return { ok: false, error: "no_changes", message: "No editable field supplied." };
  }

  const base = existing
    ? {
        amount: existing.amount,
        currencyLabel: existing.currencyLabel,
        expiresAt: existing.expiresAt,
        askText: { en: existing.askText.en, bn: existing.askText.bn },
      }
    : null;

  let amount: number | undefined = base?.amount;
  if (patch.amount !== undefined) {
    const a = patch.amount;
    if (
      typeof a !== "number" ||
      !Number.isFinite(a) ||
      a <= 0 ||
      !hasAtMostTwoDecimals(a)
    ) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Incentive amount must be a number > 0 with at most 2 decimals.",
      };
    }
    amount = a;
  }

  let expiresAt: string | undefined = base?.expiresAt;
  if (patch.expiresAt !== undefined) {
    const e = String(patch.expiresAt ?? "").trim();
    if (!isRealLastValidDay(e)) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Expiry must be a valid last day as YYYY-MM-DD.",
      };
    }
    expiresAt = e;
  }

  if (existing === null) {
    if (amount === undefined) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "missing_amount: creating an incentive requires an amount.",
      };
    }
    if (expiresAt === undefined) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "missing_expiry: creating an incentive requires an expiry.",
      };
    }
  }

  let currencyLabel: string | null = base ? base.currencyLabel : null;
  if (patch.currencyLabel !== undefined) {
    if (patch.currencyLabel === null) {
      currencyLabel = null;
    } else if (typeof patch.currencyLabel === "string") {
      const t = patch.currencyLabel.trim();
      currencyLabel = t === "" ? null : t;
    } else {
      return {
        ok: false,
        error: "invalid_edit",
        message: "Currency label must be a string or null.",
      };
    }
  }

  let askText: { en: string | null; bn: string | null } = base
    ? { en: base.askText.en, bn: base.askText.bn }
    : { en: null, bn: null };
  if (patch.askText !== undefined) {
    if (typeof patch.askText !== "object" || patch.askText === null || Array.isArray(patch.askText)) {
      return {
        ok: false,
        error: "invalid_edit",
        message: "askText must be an object with optional en/bn strings.",
      };
    }
    const rec = patch.askText as Record<string, unknown>;
    const next = { ...askText };
    if (rec.en !== undefined) {
      if (rec.en !== null && typeof rec.en !== "string") {
        return { ok: false, error: "invalid_edit", message: "askText.en must be a string or null." };
      }
      const t = typeof rec.en === "string" ? rec.en.trim() : null;
      next.en = t === "" ? null : t;
    }
    if (rec.bn !== undefined) {
      if (rec.bn !== null && typeof rec.bn !== "string") {
        return { ok: false, error: "invalid_edit", message: "askText.bn must be a string or null." };
      }
      const t = typeof rec.bn === "string" ? rec.bn.trim() : null;
      next.bn = t === "" ? null : t;
    }
    askText = next;
  }

  return {
    ok: true,
    value: {
      amount: amount as number,
      currencyLabel,
      expiresAt: expiresAt as string,
      askText,
    },
    created: existing === null,
  };
}

/**
 * Pause / resume for the incentive control doc. Same guarantees as the
 * coupon pair: idempotent no-ops, and resume restores exactly the
 * amount / expiry / currencyLabel / askText that were paused (the patch
 * touches only status/pausedAt/pausedBy/updatedAt).
 */
export function pauseIncentive(
  doc: IncentiveControlDoc,
  actorId: string,
  nowMs = Date.now()
): PauseResumeResult {
  if (resolveOfferStatus(doc) === "paused") {
    return { changed: false, patch: null };
  }
  return {
    changed: true,
    patch: {
      status: "paused",
      pausedAt: new Date(nowMs).toISOString(),
      pausedBy: actorId,
      updatedAt: new Date(nowMs).toISOString(),
    },
  };
}

export function resumeIncentive(
  doc: IncentiveControlDoc,
  _actorId: string,
  nowMs = Date.now()
): PauseResumeResult {
  if (resolveOfferStatus(doc) === "active") {
    return { changed: false, patch: null };
  }
  return {
    changed: true,
    patch: {
      status: "active",
      pausedAt: null,
      pausedBy: null,
      updatedAt: new Date(nowMs).toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3. AUDIT TRAIL — PROPOSAL shape (reconcile with Leg E, see header)  */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "coupon_edited"
  | "coupon_paused"
  | "coupon_resumed"
  | "incentive_edited"
  | "incentive_paused"
  | "incentive_resumed"
  | "offer_send_blocked";

export interface OwnerControlAuditEntry {
  /** Tenant the entry belongs to. Queries MUST always filter by this. */
  businessId: string;
  /** Who acted: the authenticated owner/staff user id, or "system". */
  actorId: string;
  /** Role at action time, e.g. "owner" | "supervisor" | "admin" | "system". */
  actorRole: string;
  action: AuditAction;
  targetKind: "coupon" | "video_review_incentive";
  /** Coupon code, or the businessId for the single incentive doc. */
  targetId: string;
  /** Field-level summary BEFORE the change (null for blocked sends). */
  before: Record<string, unknown> | null;
  /** Field-level summary AFTER the change (null for blocked sends). */
  after: Record<string, unknown> | null;
  /** Machine reason for a block (e.g. "paused"); null for mutations. */
  reason: string | null;
  outcome: "applied" | "blocked" | "noop";
  createdAt: string;
  createdAtMs: number;
}

/** Proposed audit collection (server-written only — see rules snippet). */
export const OWNER_CONTROL_AUDIT_COLLECTION = "owner_control_audit";

/**
 * Build a mutation audit entry. Callers pass the summaries from
 * summarizeCoupon / summarizeIncentive; this function adds actor,
 * timestamps, and outcome, and never invents values.
 */
export function buildAuditEntry(args: {
  businessId: string;
  actorId: string;
  actorRole: string;
  action: AuditAction;
  targetKind: "coupon" | "video_review_incentive";
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason?: string | null;
  outcome?: "applied" | "blocked" | "noop";
  nowMs?: number;
}): OwnerControlAuditEntry {
  const nowMs = args.nowMs ?? Date.now();
  return {
    businessId: args.businessId,
    actorId: args.actorId,
    actorRole: args.actorRole,
    action: args.action,
    targetKind: args.targetKind,
    targetId: args.targetId,
    before: args.before,
    after: args.after,
    reason: args.reason ?? null,
    outcome: args.outcome ?? "applied",
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs,
  };
}

/**
 * Build a blocked-send audit entry (paused / missing / invalid / cross-
 * tenant). No offer values are recorded — only the target and the
 * machine reason — so a blocked attempt can never leak another tenant's
 * offer figures through the trail.
 */
export function buildBlockedSendEntry(args: {
  businessId: string;
  actorId: string;
  actorRole: string;
  targetKind: "coupon" | "video_review_incentive";
  targetId: string;
  reason: OfferBlockReason;
  nowMs?: number;
}): OwnerControlAuditEntry {
  return buildAuditEntry({
    ...args,
    action: "offer_send_blocked",
    before: null,
    after: null,
    reason: args.reason,
    outcome: "blocked",
  });
}

/**
 * Logger-safe blocked-send record (server logs). Contains NO amounts,
 * NO expiry, NO offer text — only the event, tenant, target, and reason.
 * The caller logs this object whenever a send gate returns non-null.
 */
export function blockedSendLog(args: {
  businessId: string;
  targetKind: "coupon" | "video_review_incentive";
  targetId: string;
  reason: OfferBlockReason;
}): {
  event: "owner_control_blocked";
  businessId: string;
  targetKind: string;
  targetId: string;
  reason: OfferBlockReason;
} {
  return {
    event: "owner_control_blocked",
    businessId: args.businessId,
    targetKind: args.targetKind,
    targetId: args.targetId,
    reason: args.reason,
  };
}
