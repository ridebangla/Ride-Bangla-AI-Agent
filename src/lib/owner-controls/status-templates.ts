/**
 * status-templates.ts — LEG D (owner controls, STAGED ONLY): owner
 * edit + pause / resume for order-status message templates.
 *
 * Extends the staged order-status batch's Leg C (order-status
 * messages — LC-01 / LC-04 / LC-05; see LEG-REPORT.md §2 for the
 * naming reconciliation:
 * the booking batch's Leg C is advance payments and has NO status
 * message path, so there is nothing to extend there). Leg C's
 * messages today are HARDCODED in buildOrderStatusUpdateMessage
 * (order-tracking.ts) and queueOrderStatusUpdate (order-status-
 * updates.ts) always sends the built text. This leg does NOT rewrite
 * that status-update path: the merger inserts ONE resolution call
 * (integration snippet SNIP-2) at the message-build point inside
 * queueOrderStatusUpdate, and the status write itself (setOrderStatus
 * + courier bridge) is untouched — a blocked template never blocks
 * the status change, only the message.
 *
 * TEMPLATE KEYS (one template per push transition, because Leg C
 * only pushes on moves TO confirmed/cancelled, with a different
 * honest variant per delivery path on confirm):
 * - "confirmed:rider"        — confirmed + courier link booked
 * - "confirmed:own_delivery" — confirmed + link owner_notified
 * - "confirmed:unrouted"     — confirmed + any other / no link
 * - "cancelled"              — cancelled (any link state)
 * Any other transition (pending, confirmed -> pending, same-status
 * re-save) has NO key and sends nothing — exactly Leg C's rule.
 *
 * FAIL-CLOSED SEND GATE (resolveTemplateForSend). Once SNIP-2 is
 * merged, a status message goes out ONLY when an ACTIVE template
 * row for this business and this key exists and renders:
 * - no template row        => blocked, reason "template_missing"
 * - template paused        => blocked, reason "template_paused"
 * - template disabled/unknown status => blocked, "template_disabled"
 * - cross-tenant row       => blocked, "business_mismatch"
 * - stored text fails today's guard => blocked, "invalid_template"
 * - unfillable placeholder => blocked, "message_build_failed"
 * There is deliberately NO fallback to Leg C's hardcoded text: a
 * fallback would be a default send, and the owner doctrine forbids
 * defaults (missing config = no send, never a guessed text). This
 * is a BEHAVIOUR CHANGE on merge, flagged for the coordinator in
 * LEG-REPORT.md §6: until the owner creates templates, pushes stop
 * (status changes still record). Leg C's hardcoded wordings remain
 * available only as PROPOSAL seed text the owner may adopt verbatim
 * through the edit route — they are never auto-seeded.
 *
 * EDIT NEVER UNPAUSES, PAUSE NEVER EDITS: editing a paused template
 * keeps it paused (a text change is not a resume); pausing flips
 * only the status and never touches the text, so resume restores
 * exactly the same text, byte-identical, by construction.
 *
 * TEXT GUARDS (validateTemplateText): empty and over-long texts are
 * refused; the ONLY supported placeholder is {orderRef} — any other
 * {…} token is refused, because an unfilled placeholder would go
 * out as literal braces or be guessed; credential-shaped text is
 * refused (a status message is customer-facing prose, never a place
 * for secrets); AMOUNT-bearing text is refused — Leg C's channel
 * carries no money figures by construction, and the agent never
 * quotes fares, so a status template must not become a price
 * channel (owner decision D-T3 in LEG-REPORT.md: the owner may
 * explicitly allow a tenant's own figure here later; staged = block).
 * A template WITHOUT {orderRef} is allowed with a non-blocking
 * "no_order_ref" warning, so the owner sees the message will not
 * name the order — omitting the reference is the owner's choice,
 * not an invention.
 *
 * This module is pure (no imports) so it can be unit-tested
 * standalone. All owner-facing control labels and all template
 * wording are PROPOSAL for owner approval.
 */

export type OrderStatusTemplateKey =
  | "confirmed:rider"
  | "confirmed:own_delivery"
  | "confirmed:unrouted"
  | "cancelled";

export type TemplateStatus = "active" | "paused";

export interface OrderStatusTemplate {
  id: string;
  businessId: string;
  key: OrderStatusTemplateKey;
  /** Owner's verbatim message text (may contain {orderRef}). */
  text: string;
  status: TemplateStatus;
  createdBy: string;
  createdByName: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  pausedAt: Date | string | null;
  pausedBy: string | null;
}

/** Hard cap on one template text (mirrors Leg G's test-message cap). */
export const MAX_TEMPLATE_CHARS = 1000;
/** Hard cap on the owner's pause/edit note, where a route accepts one. */
export const MAX_TEMPLATE_NOTE_CHARS = 500;

export const TEMPLATE_KEYS: OrderStatusTemplateKey[] = [
  "confirmed:rider",
  "confirmed:own_delivery",
  "confirmed:unrouted",
  "cancelled",
];

export function isTemplateKey(value: unknown): value is OrderStatusTemplateKey {
  return (
    typeof value === "string" &&
    (TEMPLATE_KEYS as string[]).includes(value)
  );
}

/**
 * Which template key (if any) a transition needs. linkState is Leg C's
 * recorded courier-link state ("booked" | "owner_notified" | other).
 * Returns null for every non-push transition — those send nothing.
 */
export function templateKeyForTransition(
  toStatus: string,
  linkState: string | null
): OrderStatusTemplateKey | null {
  if (toStatus === "cancelled") return "cancelled";
  if (toStatus === "confirmed") {
    if (linkState === "booked") return "confirmed:rider";
    if (linkState === "owner_notified") return "confirmed:own_delivery";
    return "confirmed:unrouted";
  }
  return null;
}

/** Pure tenant guard: a row belongs to the caller's business or not. */
export function isSameBusiness(
  rowBusinessId: string,
  authBusinessId: string | null
): boolean {
  return !!authBusinessId && rowBusinessId === authBusinessId;
}

/** Credential-shaped material has no place in customer-facing prose. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(api[_-]?key|apikey|secret|password|passwd|access[_-]?token)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9]{8,}\b/,
  /\bBearer\s+\S+/i,
];

/** Any money figure or currency mark: refused in this channel. */
const AMOUNT_PATTERN =
  /[৳$€£]|\b(USD|BDT)\s?\d|\b\d+\s?(taka|tk)\b/i;

export type TemplateValidationCode =
  | "empty_template"
  | "template_too_long"
  | "unknown_placeholder"
  | "secret_detected"
  | "amount_in_template";

export interface TemplateValidation {
  ok: boolean;
  /** Blocking failures (edit refused while any is present). */
  errors: TemplateValidationCode[];
  /** Non-blocking flags the owner must see before saving. */
  warnings: string[];
}

export function validateTemplateText(text: unknown): TemplateValidation {
  const errors: TemplateValidationCode[] = [];
  const warnings: string[] = [];
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, errors: ["empty_template"], warnings };
  }
  if (text.length > MAX_TEMPLATE_CHARS) errors.push("template_too_long");
  const placeholders = text.match(/\{[^}]*\}/g) ?? [];
  if (placeholders.some((p) => p !== "{orderRef}")) {
    errors.push("unknown_placeholder");
  }
  if (SECRET_PATTERNS.some((re) => re.test(text))) {
    errors.push("secret_detected");
  }
  if (AMOUNT_PATTERN.test(text)) {
    errors.push("amount_in_template");
  }
  if (!text.includes("{orderRef}")) warnings.push("no_order_ref");
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Render a template for one order. Returns null (fail-closed, never
 * a half-filled message) when the text needs {orderRef} but no
 * reference was supplied. A template without the placeholder renders
 * unchanged.
 */
export function renderTemplateText(
  text: string,
  orderRef: string | null
): string | null {
  if (text.includes("{orderRef}")) {
    if (!orderRef) return null;
    return text.split("{orderRef}").join(orderRef);
  }
  return text;
}

export type TemplateRefusal =
  | "business_mismatch"
  | "invalid_template"
  | "already_paused"
  | "not_paused";

/**
 * Create or edit a template. Editing preserves the row's id,
 * businessId, key, and — critically — its status: editing a paused
 * template keeps it paused. A new template starts ACTIVE (the owner
 * created it to send); pausing is a separate explicit action.
 */
export function editTemplate(args: {
  existing: OrderStatusTemplate | null;
  businessId: string;
  authBusinessId: string | null;
  key: OrderStatusTemplateKey;
  text: string;
  actorId: string;
  actorName: string;
  nowIso: string;
  newId: string;
}):
  | { ok: true; row: OrderStatusTemplate; isNew: boolean }
  | { ok: false; reason: TemplateRefusal; errors?: TemplateValidationCode[] } {
  const {
    existing,
    businessId,
    authBusinessId,
    key,
    text,
    actorId,
    actorName,
    nowIso,
    newId,
  } = args;
  if (!isSameBusiness(businessId, authBusinessId)) {
    return { ok: false, reason: "business_mismatch" };
  }
  const validation = validateTemplateText(text);
  if (!validation.ok) {
    return {
      ok: false,
      reason: "invalid_template",
      errors: validation.errors,
    };
  }
  if (existing) {
    if (!isSameBusiness(existing.businessId, authBusinessId)) {
      return { ok: false, reason: "business_mismatch" };
    }
    if (existing.key !== key) {
      return { ok: false, reason: "invalid_template" };
    }
    return {
      ok: true,
      isNew: false,
      row: {
        ...existing,
        text,
        updatedAt: nowIso,
        // status, pausedAt, pausedBy deliberately untouched:
        // an edit is not a resume.
      },
    };
  }
  return {
    ok: true,
    isNew: true,
    row: {
      id: newId,
      businessId,
      key,
      text,
      status: "active",
      createdBy: actorId,
      createdByName: actorName,
      createdAt: nowIso,
      updatedAt: nowIso,
      pausedAt: null,
      pausedBy: null,
    },
  };
}

/** Pause a template: status flip only, text never touched. */
export function pauseTemplate(args: {
  row: OrderStatusTemplate | null;
  authBusinessId: string | null;
  actorId: string;
  nowIso: string;
}):
  | { ok: true; row: OrderStatusTemplate }
  | { ok: false; reason: TemplateRefusal } {
  const { row, authBusinessId, actorId, nowIso } = args;
  if (!row) return { ok: false, reason: "not_paused" };
  if (!isSameBusiness(row.businessId, authBusinessId)) {
    return { ok: false, reason: "business_mismatch" };
  }
  if (row.status === "paused") {
    return { ok: false, reason: "already_paused" };
  }
  if (row.status !== "active") {
    return { ok: false, reason: "not_paused" };
  }
  return {
    ok: true,
    row: { ...row, status: "paused", pausedAt: nowIso, pausedBy: actorId },
  };
}

/**
 * Resume a template: status flip only. restoredText IS the row's
 * text — no copy was ever made, so byte-identical restore holds by
 * construction (harness asserts restoredText === row.text).
 */
export function resumeTemplate(args: {
  row: OrderStatusTemplate | null;
  authBusinessId: string | null;
  nowIso: string;
}):
  | { ok: true; row: OrderStatusTemplate; restoredText: string }
  | { ok: false; reason: TemplateRefusal } {
  const { row, authBusinessId } = args;
  if (!row) return { ok: false, reason: "not_paused" };
  if (!isSameBusiness(row.businessId, authBusinessId)) {
    return { ok: false, reason: "business_mismatch" };
  }
  if (row.status !== "paused") {
    return { ok: false, reason: "not_paused" };
  }
  return {
    ok: true,
    row: { ...row, status: "active", pausedAt: null, pausedBy: null },
    restoredText: row.text,
  };
}

export type SendBlockReason =
  | "not_a_push_transition"
  | "business_mismatch"
  | "template_missing"
  | "template_paused"
  | "template_disabled"
  | "invalid_template"
  | "message_build_failed";

/**
 * THE send gate (used by SNIP-2 inside queueOrderStatusUpdate).
 * Returns send:true with the owner's verbatim rendered text, or
 * send:false with a machine reason the caller logs. It NEVER falls
 * back to any other text: a fallback would be a default send.
 * The stored text is re-validated at send time, so a template that
 * passed an older guard still has to pass today's guard before it
 * can go to a customer.
 */
export function resolveTemplateForSend(args: {
  templateRow: OrderStatusTemplate | null;
  businessId: string;
  authBusinessId: string | null;
  toStatus: string;
  linkState: string | null;
  orderRef: string | null;
}):
  | { send: true; message: string; key: OrderStatusTemplateKey }
  | { send: false; reason: SendBlockReason } {
  const { templateRow, businessId, authBusinessId, toStatus, linkState, orderRef } =
    args;
  const key = templateKeyForTransition(toStatus, linkState);
  if (!key) return { send: false, reason: "not_a_push_transition" };
  if (!isSameBusiness(businessId, authBusinessId)) {
    return { send: false, reason: "business_mismatch" };
  }
  if (!templateRow) return { send: false, reason: "template_missing" };
  if (!isSameBusiness(templateRow.businessId, authBusinessId)) {
    return { send: false, reason: "business_mismatch" };
  }
  if (templateRow.key !== key) {
    return { send: false, reason: "template_missing" };
  }
  if (templateRow.status === "paused") {
    return { send: false, reason: "template_paused" };
  }
  if (templateRow.status !== "active") {
    return { send: false, reason: "template_disabled" };
  }
  if (!validateTemplateText(templateRow.text).ok) {
    return { send: false, reason: "invalid_template" };
  }
  const message = renderTemplateText(templateRow.text, orderRef);
  if (message === null) {
    return { send: false, reason: "message_build_failed" };
  }
  return { send: true, message, key };
}
