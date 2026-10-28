/**
 * Owner message controls — LEG C (owner offer + reply control batch).
 * STAGED ONLY. Pure, dependency-free: no imports, no I/O, no network.
 *
 * What this module is: the owner-control LAYER that sits ON TOP of the
 * existing send paths. It never sends anything itself and never rewrites
 * any existing scheduler, sender, or delivery loop. A merger inserts ONE
 * call to `resolveMessageControl` immediately before each send (see
 * INTEGRATION-SNIPPETS.md); when the result is not allowed, the caller
 * sends nothing, logs the block, and leaves the record exactly as it was.
 *
 * Families covered (see LEG-REPORT.md §2 for the gap evidence):
 *  - followups:   staged booking Leg F warm/hot follow-ups (+ the HEAD
 *                 dropped_revival / order_checkin kinds that share the
 *                 same processor). Video-2 Leg I delay/number-left
 *                 settings are untouched; this layer adds only the
 *                 missing pause + edit controls on top.
 *  - reminders:   staged booking Leg D booking_reminder records
 *                 (day_before / hours_before slots).
 *  - reviewAsks:  HEAD generic review ask (behaviour.ts), staged
 *                 booking Leg I delivered review request
 *                 (order_review_request) + star-rating request
 *                 (order_rating_request), and staged video Leg B video
 *                 review ask (whose trigger/send path is NOT built yet —
 *                 this gate is staged for that trigger leg and is inert
 *                 until it lands).
 *
 * Fail-closed rules (owner doctrine 2026-10-25, safety-critical):
 *  1. Cross-tenant access is refused before any text is read, so one
 *     business's override text can never leak into another's message.
 *  2. Paused (master, scope, or record), disabled, or empty/missing
 *     message text BLOCKS the send. Nothing goes out, never a guessed
 *     text, never a substituted business name.
 *  3. A pause never deletes and never rewrites: a paused record keeps
 *     its exact status, due time, and message. Resume restores exactly
 *     that — byte-identical text unless a SEPARATE audited edit changed
 *     it in the meantime.
 *  4. An unknown scope key in a control patch is REJECTED, never
 *     silently ignored: a pause typed for a misspelled kind that did
 *     nothing would be worse than an error.
 *
 * Doctrine interpretation, stated so it can be corrected (LEG-REPORT
 * §7, D-C1): the controls layer itself defaults to "no control set",
 * which ALLOWS the send (the family's own switch still governs: e.g.
 * followUpsEnabled, reviewRequestsEnabled, Leg I's OFF-default
 * orderReviewRequestsEnabled, Leg D's slot toggles). The fail-closed
 * rule bites on the send's OWN config — text, link, family switch —
 * and on every explicit pause/disable. Flipping the layer default to
 * "blocked until configured" would silence every HEAD send on landing
 * and is NOT staged; it is a one-line owner decision if wanted.
 *
 * No invented copy: this module ships NO default message text and NO
 * owner-facing wording. Override texts are always owner-supplied; the
 * only strings here are machine reason codes and validation errors.
 * No price, fare, currency, quota, or metering logic lives here.
 */

// ---------------------------------------------------------------------------
// Families, scopes, and the control state stored on the settings doc
// ---------------------------------------------------------------------------

export type MessageFamily = "followups" | "reminders" | "reviewAsks";

/** Follow-up scopes: the followUp record `kind` values this layer gates. */
export type FollowUpScope =
  | "warm_followup"
  | "hot_followup"
  | "dropped_revival"
  | "order_checkin";

/** Reminder scopes: Leg D's two slots. */
export type ReminderScope = "day_before" | "hours_before";

/** Review-ask systems: one pause key each, so the owner can pause one
 *  system without pausing the others. */
export type ReviewAskSystem = "generic" | "delivered" | "video" | "rating";

export type ControlScope = FollowUpScope | ReminderScope | ReviewAskSystem;

/** Scopes each family recognises. Anything else in a patch is rejected. */
export const FAMILY_SCOPES: Record<MessageFamily, readonly string[]> = {
  followups: ["warm_followup", "hot_followup", "dropped_revival", "order_checkin"],
  reminders: ["day_before", "hours_before"],
  reviewAsks: ["generic", "delivered", "video", "rating"],
};

/**
 * followUp record kinds a per-record pause/edit may touch. Deliberately
 * EXCLUDES "broadcast" / "broadcast_test": Leg F's test-send rule
 * requires a byte-identical sent test, and editing or pausing broadcast
 * records would silently interact with that invariant. Broadcast
 * controls are a separate owner decision (LEG-REPORT §7, D-C5).
 */
export const CONTROLLED_RECORD_KINDS: readonly string[] = [
  "warm_followup",
  "hot_followup",
  "dropped_revival",
  "order_checkin",
  "booking_reminder",
  "order_rating_request",
  "order_review_request",
];

/** Which family a record kind belongs to (null = not controlled). */
export function familyForRecordKind(kind: string | null | undefined): MessageFamily | null {
  if (!kind) return null;
  if (
    kind === "warm_followup" ||
    kind === "hot_followup" ||
    kind === "dropped_revival" ||
    kind === "order_checkin"
  ) {
    return "followups";
  }
  if (kind === "booking_reminder") return "reminders";
  if (kind === "order_rating_request" || kind === "order_review_request") {
    return "reviewAsks";
  }
  return null;
}

/** Which scope key a record kind maps to for pause/text lookups. */
export function scopeForRecordKind(kind: string | null | undefined): string | null {
  if (!kind) return null;
  if (kind === "booking_reminder") return null; // slot lives on the record, not the kind
  if (kind === "order_rating_request") return "rating";
  if (kind === "order_review_request") return "delivered";
  if (familyForRecordKind(kind) === "followups") return kind;
  return null;
}

/**
 * A pause. `pausedUntil` is an optional ISO timestamp: while set and in
 * the future, the pause holds; once it passes, the pause lapses on its
 * own (auto-resume) — the owner "paused it for a time". An unparseable
 * `pausedUntil` NEVER auto-resumes (fail-closed). Explicit resume
 * clears the pause regardless of `pausedUntil`.
 */
export interface PauseState {
  paused: boolean;
  pausedAt: string | null;
  pausedUntil: string | null;
  /** Owner-supplied note (free text, never shipped copy). */
  note: string | null;
}

export function unpaused(): PauseState {
  return { paused: false, pausedAt: null, pausedUntil: null, note: null };
}

/** True while this pause blocks a send at `nowMs`. */
export function isPauseActive(pause: PauseState | null | undefined, nowMs: number): boolean {
  if (!pause || pause.paused !== true) return false;
  if (pause.pausedUntil === null || pause.pausedUntil === undefined) return true;
  const until = Date.parse(pause.pausedUntil);
  if (Number.isNaN(until)) return true; // unparseable expiry never auto-resumes
  return nowMs < until;
}

export interface FamilyControls {
  /** Family-level on/off. false blocks every send in the family. */
  enabled: boolean;
  /** Master pause: blocks every scope in the family while active. */
  masterPause: PauseState;
  /** Per-scope pauses, keyed by scope (see FAMILY_SCOPES). */
  kinds: Record<string, PauseState>;
  /**
   * Per-scope owner override texts. null/absent = no override (the
   * record's / builder's text is used). An override, when set, is used
   * VERBATIM at delivery (templated scopes render placeholders first).
   * No default text is ever supplied by this module.
   */
  texts: Record<string, string | null>;
}

export function defaultFamilyControls(): FamilyControls {
  return { enabled: true, masterPause: unpaused(), kinds: {}, texts: {} };
}

export interface MessageControlState {
  followups: FamilyControls;
  reminders: FamilyControls;
  reviewAsks: FamilyControls;
}

export function defaultMessageControls(): MessageControlState {
  return {
    followups: defaultFamilyControls(),
    reminders: defaultFamilyControls(),
    reviewAsks: defaultFamilyControls(),
  };
}

/** Read a possibly-absent controls object as a full state (missing
 *  families/scopes behave as "no control set" — see the doctrine note
 *  at the top of this file). Never throws on malformed input. */
export function normalizeControls(input: unknown): MessageControlState {
  const base = defaultMessageControls();
  if (!input || typeof input !== "object") return base;
  const src = input as Record<string, unknown>;
  for (const family of ["followups", "reminders", "reviewAsks"] as const) {
    const f = src[family];
    if (!f || typeof f !== "object") continue;
    const fr = f as Record<string, unknown>;
    if (typeof fr.enabled === "boolean") base[family].enabled = fr.enabled;
    if (isPauseLike(fr.masterPause)) base[family].masterPause = toPause(fr.masterPause);
    if (fr.kinds && typeof fr.kinds === "object") {
      for (const [k, v] of Object.entries(fr.kinds as Record<string, unknown>)) {
        if (isPauseLike(v)) base[family].kinds[k] = toPause(v);
      }
    }
    if (fr.texts && typeof fr.texts === "object") {
      for (const [k, v] of Object.entries(fr.texts as Record<string, unknown>)) {
        if (typeof v === "string" || v === null) base[family].texts[k] = v;
      }
    }
  }
  return base;
}

function isPauseLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && typeof (v as Record<string, unknown>).paused === "boolean";
}

function toPause(v: Record<string, unknown>): PauseState {
  return {
    paused: v.paused === true,
    pausedAt: typeof v.pausedAt === "string" ? v.pausedAt : null,
    pausedUntil: typeof v.pausedUntil === "string" ? v.pausedUntil : null,
    note: typeof v.note === "string" ? v.note : null,
  };
}

// ---------------------------------------------------------------------------
// Templated overrides: placeholders that MUST resolve, never guessed
// ---------------------------------------------------------------------------

/**
 * Scopes whose override is a TEMPLATE, not plain text, because the
 * message is composed from booking/order facts that must not be lost:
 *  - reminders (both slots): the override MUST contain {{bookingDateTime}}
 *    (Leg D's no-generic-promise rule: every reminder states the absolute
 *    date/time). {{place}} is optional and renders empty when unknown —
 *    never "undefined".
 *  - reviewAsks.delivered: the override MUST contain {{reviewUrl}}
 *    (Leg I's link-only rule: a delivered-review request without the
 *    business's own review link would mislead the customer).
 * Every other scope's override is plain verbatim text.
 */
export const TEMPLATED_SCOPES: Record<string, readonly string[]> = {
  "reminders:day_before": ["{{bookingDateTime}}"],
  "reminders:hours_before": ["{{bookingDateTime}}"],
  "reviewAsks:delivered": ["{{reviewUrl}}"],
};

export interface TemplateContext {
  bookingDateTime?: string | null;
  place?: string | null;
  reviewUrl?: string | null;
}

export type TemplateRender =
  | { ok: true; text: string }
  | { ok: false; error: "template_context_missing" | "unknown_placeholder" };

const PLACEHOLDER_RE = /\{\{([a-zA-Z]+)\}\}/g;

/** Render a templated override. Missing required context BLOCKS (the
 *  caller must not send); an unknown placeholder BLOCKS rather than
 *  leaking literal braces to the customer. */
export function renderTemplatedOverride(
  template: string,
  ctx: TemplateContext
): TemplateRender {
  const values: Record<string, string | null | undefined> = {
    bookingDateTime: ctx.bookingDateTime,
    place: ctx.place,
    reviewUrl: ctx.reviewUrl,
  };
  let missing = false;
  let unknown = false;
  const text = template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (!(name in values)) {
      unknown = true;
      return "";
    }
    const v = values[name];
    if (name === "place") return v ?? ""; // place is optional: empty, never "undefined"
    if (v === null || v === undefined || v === "") {
      missing = true;
      return "";
    }
    return v;
  });
  if (unknown) return { ok: false, error: "unknown_placeholder" };
  if (missing) return { ok: false, error: "template_context_missing" };
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Validation of owner-supplied control patches (both writers use this)
// ---------------------------------------------------------------------------

export const MAX_OVERRIDE_CHARS = 10000; // mirrors the canned-response content cap precedent
export const MAX_NOTE_CHARS = 500;

export type PatchError =
  | "patch_not_object"
  | "unknown_family"
  | "unknown_scope"
  | "invalid_pause"
  | "invalid_enabled"
  | "override_empty"
  | "override_too_long"
  | "override_missing_booking_datetime"
  | "override_missing_review_url"
  | "note_too_long";

export interface PatchValidation {
  ok: boolean;
  error?: PatchError;
  field?: string;
}

function validatePause(v: unknown, field: string): PatchValidation {
  if (!isPauseLike(v)) return { ok: false, error: "invalid_pause", field };
  const p = v as Record<string, unknown>;
  if (p.pausedUntil !== null && p.pausedUntil !== undefined && typeof p.pausedUntil !== "string") {
    return { ok: false, error: "invalid_pause", field };
  }
  if (typeof p.pausedUntil === "string" && Number.isNaN(Date.parse(p.pausedUntil))) {
    return { ok: false, error: "invalid_pause", field };
  }
  if (typeof p.note === "string" && p.note.length > MAX_NOTE_CHARS) {
    return { ok: false, error: "note_too_long", field };
  }
  if (p.note !== null && p.note !== undefined && typeof p.note !== "string") {
    return { ok: false, error: "invalid_pause", field };
  }
  return { ok: true };
}

/** Validate one override text for a family+scope. null = clear (allowed). */
export function validateOverrideText(
  family: MessageFamily,
  scope: string,
  text: string | null
): PatchValidation {
  if (text === null) return { ok: true };
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "override_empty", field: `${family}.texts.${scope}` };
  }
  if (text.length > MAX_OVERRIDE_CHARS) {
    return { ok: false, error: "override_too_long", field: `${family}.texts.${scope}` };
  }
  const required = TEMPLATED_SCOPES[`${family}:${scope}`];
  if (required) {
    for (const ph of required) {
      if (!text.includes(ph)) {
        return {
          ok: false,
          error:
            ph === "{{bookingDateTime}}"
              ? "override_missing_booking_datetime"
              : "override_missing_review_url",
          field: `${family}.texts.${scope}`,
        };
      }
    }
  }
  return { ok: true };
}

/** Validate a partial control patch (unknown keys are rejected). */
export function validateControlPatch(patch: unknown): PatchValidation {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "patch_not_object" };
  }
  for (const [family, fv] of Object.entries(patch as Record<string, unknown>)) {
    if (!(family in FAMILY_SCOPES)) return { ok: false, error: "unknown_family", field: family };
    if (!fv || typeof fv !== "object" || Array.isArray(fv)) {
      return { ok: false, error: "patch_not_object", field: family };
    }
    const f = fv as Record<string, unknown>;
    if (f.enabled !== undefined && typeof f.enabled !== "boolean") {
      return { ok: false, error: "invalid_enabled", field: `${family}.enabled` };
    }
    if (f.masterPause !== undefined) {
      const r = validatePause(f.masterPause, `${family}.masterPause`);
      if (!r.ok) return r;
    }
    if (f.kinds !== undefined) {
      if (!f.kinds || typeof f.kinds !== "object" || Array.isArray(f.kinds)) {
        return { ok: false, error: "invalid_pause", field: `${family}.kinds` };
      }
      for (const [scope, pv] of Object.entries(f.kinds as Record<string, unknown>)) {
        if (!FAMILY_SCOPES[family as MessageFamily].includes(scope)) {
          return { ok: false, error: "unknown_scope", field: `${family}.kinds.${scope}` };
        }
        const r = validatePause(pv, `${family}.kinds.${scope}`);
        if (!r.ok) return r;
      }
    }
    if (f.texts !== undefined) {
      if (!f.texts || typeof f.texts !== "object" || Array.isArray(f.texts)) {
        return { ok: false, error: "patch_not_object", field: `${family}.texts` };
      }
      for (const [scope, tv] of Object.entries(f.texts as Record<string, unknown>)) {
        if (!FAMILY_SCOPES[family as MessageFamily].includes(scope)) {
          return { ok: false, error: "unknown_scope", field: `${family}.texts.${scope}` };
        }
        if (tv !== null && typeof tv !== "string") {
          return { ok: false, error: "patch_not_object", field: `${family}.texts.${scope}` };
        }
        const r = validateOverrideText(family as MessageFamily, scope, tv as string | null);
        if (!r.ok) return r;
      }
    }
  }
  return { ok: true };
}

/** Deep-merge a validated patch over a base state (patch wins per
 *  field; per-scope pause/text entries replace wholesale). */
export function mergeControls(
  base: MessageControlState,
  patch: Record<string, unknown>
): MessageControlState {
  const out: MessageControlState = {
    followups: {
      enabled: base.followups.enabled,
      masterPause: { ...base.followups.masterPause },
      kinds: { ...base.followups.kinds },
      texts: { ...base.followups.texts },
    },
    reminders: {
      enabled: base.reminders.enabled,
      masterPause: { ...base.reminders.masterPause },
      kinds: { ...base.reminders.kinds },
      texts: { ...base.reminders.texts },
    },
    reviewAsks: {
      enabled: base.reviewAsks.enabled,
      masterPause: { ...base.reviewAsks.masterPause },
      kinds: { ...base.reviewAsks.kinds },
      texts: { ...base.reviewAsks.texts },
    },
  };
  for (const family of ["followups", "reminders", "reviewAsks"] as const) {
    const f = (patch as Record<string, unknown>)[family] as Record<string, unknown> | undefined;
    if (!f) continue;
    if (typeof f.enabled === "boolean") out[family].enabled = f.enabled;
    if (isPauseLike(f.masterPause)) out[family].masterPause = toPause(f.masterPause);
    if (f.kinds && typeof f.kinds === "object") {
      for (const [k, v] of Object.entries(f.kinds as Record<string, unknown>)) {
        if (isPauseLike(v)) out[family].kinds[k] = toPause(v);
      }
    }
    if (f.texts && typeof f.texts === "object") {
      for (const [k, v] of Object.entries(f.texts as Record<string, unknown>)) {
        if (typeof v === "string" || v === null) out[family].texts[k] = v;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The delivery gate: the single check inserted before every send
// ---------------------------------------------------------------------------

export type BlockReason =
  | "cross_tenant"
  | "family_disabled"
  | "master_paused"
  | "scope_paused"
  | "record_paused"
  | "message_text_missing"
  | "template_context_missing"
  | "unknown_placeholder";

export interface RecordControlView {
  id: string;
  /** The text that would go out if controls allowed it. */
  message: string;
  /** Per-record pause flag stored on the followUp record itself. */
  ownerPaused?: boolean | null;
  ownerPausedUntil?: string | null;
  /** Reminder slot for booking_reminder records (day_before/hour_before). */
  slot?: string | null;
}

export interface ResolveInput {
  family: MessageFamily;
  /** Scope key (kind / slot / ask system). */
  scope: string;
  /** The tenant the send is for. */
  businessId: string;
  /** The tenant that owns the loaded controls doc (null = no doc). */
  controlBusinessId: string | null;
  /** Normalised controls (null = no controls configured at all). */
  controls: MessageControlState | null;
  /** Record-backed sends pass the record; live-append asks pass null. */
  record: RecordControlView | null;
  /** Candidate text for non-record sends (generic/video ask body). */
  text: string | null;
  templateContext?: TemplateContext;
  nowMs: number;
}

export type ResolveResult =
  | {
      allowed: true;
      text: string;
      overrideApplied: boolean;
      overrideScope: string | null;
    }
  | { allowed: false; reason: BlockReason; text: null; overrideApplied: false; overrideScope: null };

/**
 * Decide whether one message may go out, and with what text.
 * Order of checks (first block wins; the reason is the logged block):
 *  1. cross-tenant — refused before any override text is read.
 *  2. family disabled.
 *  3. master pause active.
 *  4. scope pause active.
 *  5. record pause active (record-backed sends only).
 *  6. text resolution: scope override (rendered if templated) wins over
 *     the record/candidate text; an empty or unrenderable result blocks.
 *
 * Existing family switches (followUpsEnabled, reviewRequestsEnabled,
 * Leg I's orderReviewRequestsEnabled, Leg D's slot toggles) and the
 * review doctrine (evaluateReviewAsk) are NOT re-decided here — the
 * caller ANDs them with this result (see `combineWithDoctrine` and
 * INTEGRATION-SNIPPETS.md). This gate only ADDS owner control.
 */
export function resolveMessageControl(input: ResolveInput): ResolveResult {
  const blocked = (reason: BlockReason): ResolveResult => ({
    allowed: false,
    reason,
    text: null,
    overrideApplied: false,
    overrideScope: null,
  });
  if (input.controlBusinessId !== null && input.controlBusinessId !== input.businessId) {
    return blocked("cross_tenant");
  }
  const controls = input.controls;
  if (controls) {
    const fam = controls[input.family];
    if (fam.enabled !== true) return blocked("family_disabled");
    if (isPauseActive(fam.masterPause, input.nowMs)) return blocked("master_paused");
    const scopePause = fam.kinds[input.scope];
    if (isPauseActive(scopePause, input.nowMs)) return blocked("scope_paused");
  }
  if (input.record) {
    const rp: PauseState = {
      paused: input.record.ownerPaused === true,
      pausedAt: null,
      pausedUntil: input.record.ownerPausedUntil ?? null,
      note: null,
    };
    if (isPauseActive(rp, input.nowMs)) return blocked("record_paused");
  }
  // Text resolution: scope override first, then record/candidate text.
  const override = controls ? controls[input.family].texts[input.scope] : undefined;
  if (typeof override === "string") {
    if (TEMPLATED_SCOPES[`${input.family}:${input.scope}`]) {
      const rendered = renderTemplatedOverride(override, input.templateContext ?? {});
      if (!rendered.ok) {
        return blocked(
          rendered.error === "unknown_placeholder" ? "unknown_placeholder" : "template_context_missing"
        );
      }
      if (rendered.text.trim() === "") return blocked("message_text_missing");
      return { allowed: true, text: rendered.text, overrideApplied: true, overrideScope: input.scope };
    }
    if (override.trim() === "") return blocked("message_text_missing");
    return { allowed: true, text: override, overrideApplied: true, overrideScope: input.scope };
  }
  const candidate = input.record ? input.record.message : input.text;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return blocked("message_text_missing");
  }
  return { allowed: true, text: candidate, overrideApplied: false, overrideScope: null };
}

/**
 * Compose the review doctrine with owner controls: the ask goes out
 * ONLY when BOTH allow it. Doctrine reasons (disabled / no_link /
 * negative_or_escalated / capped / no_trigger, from HEAD's
 * evaluateReviewAsk) are evaluated first and stand unchanged — an
 * owner pause must never weaken them, and enabling controls must never
 * override them. Returns the doctrine reason when doctrine blocks, so
 * the caller logs the true cause.
 */
export function combineWithDoctrine(
  doctrine: { ask: boolean; reason?: string },
  control: ResolveResult
): { allowed: boolean; reason: string | null; text: string | null } {
  if (!doctrine.ask) {
    return { allowed: false, reason: doctrine.reason ?? "doctrine_blocked", text: null };
  }
  if (!control.allowed) return { allowed: false, reason: control.reason, text: null };
  return { allowed: true, reason: null, text: control.text };
}

// ---------------------------------------------------------------------------
// Audit trail — shape defined here, FLAGGED for reconciliation with the
// owner-controls batch's Leg E shared trail contract (LEG-REPORT §7,
// D-C4). If Leg E delivers a shared collection, these entries migrate
// to it unchanged: every field below is part of that proposed contract.
// ---------------------------------------------------------------------------

export type ControlActorType = "dashboard" | "api-key" | "system" | "unknown";

export interface ControlChange {
  family: MessageFamily;
  field: string;
  scope: string | null;
  before: unknown;
  after: unknown;
}

export interface OwnerControlAuditEntry {
  id: string;
  businessId: string;
  actorType: ControlActorType;
  actorId: string | null;
  /** True when no verified actor could be attributed — never invented. */
  actorUnverified: boolean;
  at: string;
  action: "controls_updated" | "record_message_edited" | "record_paused" | "record_resumed";
  family: MessageFamily;
  /** Scope key, or null for a family-wide (master/enabled) change. */
  scope: string | null;
  /** Record id for record actions, else null. */
  recordId: string | null;
  changes: ControlChange[];
}

/** Latest-N retention for the audit array on the settings doc. Capping
 *  is a retention policy, not a deletion of any control: pause/enabled
 *  state is unaffected. The cap value is flagged for Leg E (D-C4). */
export const AUDIT_KEEP = 200;

export function buildAuditEntry(input: {
  id: string;
  businessId: string;
  actorType: ControlActorType;
  actorId: string | null;
  at: string;
  action: OwnerControlAuditEntry["action"];
  family: MessageFamily;
  scope: string | null;
  recordId: string | null;
  changes: ControlChange[];
}): OwnerControlAuditEntry {
  return {
    id: input.id,
    businessId: input.businessId,
    actorType: input.actorType,
    actorId: input.actorId,
    actorUnverified: input.actorId === null,
    at: input.at,
    action: input.action,
    family: input.family,
    scope: input.scope,
    recordId: input.recordId,
    changes: input.changes,
  };
}

/** Append one entry, keeping the latest AUDIT_KEEP (oldest drop off). */
export function appendAudit(
  existing: OwnerControlAuditEntry[] | null | undefined,
  entry: OwnerControlAuditEntry
): OwnerControlAuditEntry[] {
  const list = Array.isArray(existing) ? [...existing, entry] : [entry];
  return list.length > AUDIT_KEEP ? list.slice(list.length - AUDIT_KEEP) : list;
}

function pauseSummary(p: PauseState | undefined): unknown {
  if (!p) return null;
  return { paused: p.paused, pausedUntil: p.pausedUntil };
}

/**
 * Diff two control states into auditable changes (used by BOTH writers
 * — the dedicated route and the Settings PUT merge — so the trail has
 * no hole whichever writer the owner used).
 */
export function summarizeControlChanges(
  before: MessageControlState,
  after: MessageControlState
): ControlChange[] {
  const changes: ControlChange[] = [];
  for (const family of ["followups", "reminders", "reviewAsks"] as const) {
    const b = before[family];
    const a = after[family];
    if (b.enabled !== a.enabled) {
      changes.push({ family, field: "enabled", scope: null, before: b.enabled, after: a.enabled });
    }
    if (
      b.masterPause.paused !== a.masterPause.paused ||
      b.masterPause.pausedUntil !== a.masterPause.pausedUntil
    ) {
      changes.push({
        family,
        field: "masterPause",
        scope: null,
        before: pauseSummary(b.masterPause),
        after: pauseSummary(a.masterPause),
      });
    }
    const scopes = new Set([...Object.keys(b.kinds), ...Object.keys(a.kinds)]);
    for (const scope of scopes) {
      const bp = b.kinds[scope];
      const ap = a.kinds[scope];
      if (
        (bp?.paused ?? false) !== (ap?.paused ?? false) ||
        (bp?.pausedUntil ?? null) !== (ap?.pausedUntil ?? null)
      ) {
        changes.push({
          family,
          field: "pause",
          scope,
          before: pauseSummary(bp),
          after: pauseSummary(ap),
        });
      }
    }
    const tscopes = new Set([...Object.keys(b.texts), ...Object.keys(a.texts)]);
    for (const scope of tscopes) {
      if ((b.texts[scope] ?? null) !== (a.texts[scope] ?? null)) {
        changes.push({
          family,
          field: "text",
          scope,
          before: b.texts[scope] ?? null,
          after: a.texts[scope] ?? null,
        });
      }
    }
  }
  return changes;
}
