/**
 * business-rules.ts — LEG G (Presswayy-video round 2, STAGED ONLY).
 *
 * SUPPLEMENTARY path only. Website-first brain-building governs:
 * the agent learns the business from its websites first (and from the
 * guided details index second). This module NEVER presents
 * chat-teaching as the way the agent learns the business, and it never
 * displaces website-derived knowledge. It exists for exactly one gap:
 * when a business rule the agent needs is in NEITHER the website index
 * NOR the details index NOR any tenant-saved rule, the tenant is asked
 * the missing question in plain language, answers, and the answer is
 * saved as tenant configuration.
 *
 * What this module is NOT:
 * - Not primary onboarding. It has no wizard, no "teach the agent"
 *   framing, and no customer-chat capture path. Answers arrive only
 *   through the tenant-authenticated dashboard route
 *   (POST /api/business-rules). Customer conversations can never
 *   write a rule: there is no agent tool for it, and this module
 *   imports nothing that could be called from a customer turn.
 * - Not a fare engine. The delivery-charge answer is tenant
 *   configuration. The agent may quote ONLY the saved tenant figure
 *   (see formatBusinessRulesForPrompt). Nothing here computes,
 *   estimates, or defaults a charge, and no figure is ever extracted
 *   from website text for quoting: website coverage only ever
 *   SUPPRESSES a prompt (the website text itself already reaches the
 *   agent through the knowledge base).
 * - Not an order/coupon/lead/broadcast/takeover path. It touches no
 *   order, coupon, lead, campaign, or takeover state.
 *
 * CONFLICT RULE (implemented, see applyAnswers): a chat/supplementary
 * answer must NOT silently overwrite a website-derived fact. If a
 * website or details knowledge entry already covers a field, an
 * unconfirmed answer for that field is refused with a conflict
 * (both texts returned, nothing written). Only an explicit
 * tenant confirmation (confirmConflict) saves it, recorded with the
 * website excerpt it stands beside — and the website knowledge
 * entry itself is never edited, deactivated, or deleted by this leg.
 *
 * COVERAGE SOURCES, fail-closed: only the two PRIMARY fact sources
 * count as coverage — website entries (sourceWebsiteId present, or
 * metadata.source === "website") and details entries
 * (metadata.source === "onboarding"). Manual entries (no marker),
 * chat-layer entries, media entries, and unknown markers NEVER
 * suppress a prompt. Prompting again is the safe failure; silently
 * treating an unrelated note as the business rule is not.
 *
 * STRUCTURED vs TEXT fields: deliveryCharge and minimumOrder are
 * structured (amount + currency) because only a structured figure
 * may ever be quoted. A website entry covers a structured field
 * only when it BOTH mentions the topic AND contains a number —
 * a passing mention without a figure is not a stated value.
 * Text fields are covered by a topic mention alone.
 *
 * Currency: there is NO business-level currency field at HEAD
 * (currency is per catalog product), so no currency is ever
 * inherited. A structured answer without a 3-letter currency code
 * is rejected, never completed with a guessed currency.
 *
 * All user-facing wording in this file is PROPOSAL for owner
 * approval, never silently shipped copy.
 *
 * Zero repo imports: this module is pure and harness-testable.
 */

export type BusinessRuleFieldId =
  | "deliveryCharge"
  | "deliveryAreas"
  | "deliveryTime"
  | "returnPolicy"
  | "exchangePolicy"
  | "refundPolicy"
  | "paymentMethods"
  | "minimumOrder";

export type BusinessRuleKind = "money" | "text";

export interface MoneyValue {
  amount: number;
  currency: string;
  /** Tenant's own condition in words (e.g. when free delivery applies).
   *  Never computed from, never used in any total. */
  note?: string;
}

export type BusinessRuleValue = MoneyValue | string;

/** One tenant's saved rules. One document per business (see the
 *  firestore diff: collection `businessRules`, unique businessId).
 *  Absent/null/empty = unset = still missing (unless website-covered). */
export interface BusinessRulesDoc {
  businessId: string;
  deliveryCharge?: MoneyValue | null;
  deliveryAreas?: string | null;
  deliveryTime?: string | null;
  returnPolicy?: string | null;
  exchangePolicy?: string | null;
  refundPolicy?: string | null;
  paymentMethods?: string | null;
  minimumOrder?: MoneyValue | null;
  /** Per-field record of a tenant-confirmed answer that stands beside
   *  a website/details entry (see CONFLICT RULE). The website entry
   *  itself is untouched; this only records what the tenant decided. */
  overridesWebsite?: Partial<
    Record<
      BusinessRuleFieldId,
      { entryId?: string; excerpt: string; confirmedAt: string }
    >
  >;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** Minimal shape of a knowledge entry as the route hands it in.
 *  The route passes active entries only. */
export interface RuleKnowledgeEntry {
  id?: string;
  sourceWebsiteId?: string | null;
  metadata?: { source?: unknown } | null;
  title?: string;
  content?: string;
}

export type FactSource = "website" | "details" | "other";

/** Classify an entry's fact source from its markers only — the same
 *  marker semantics website ingestion and the onboarding confirm
 *  route write at HEAD. Never inferred from content. */
export function classifyEntrySource(
  entry: RuleKnowledgeEntry
): FactSource {
  if (entry.sourceWebsiteId) return "website";
  const source = entry.metadata?.source;
  if (source === "website") return "website";
  if (source === "onboarding") return "details";
  return "other";
}

/** True when the source may cover a rule (primary sources only). */
export function isCoveringSource(entry: RuleKnowledgeEntry): boolean {
  const s = classifyEntrySource(entry);
  return s === "website" || s === "details";
}

export interface BusinessRuleFieldDef {
  field: BusinessRuleFieldId;
  kind: BusinessRuleKind;
  /** Dashboard label (PROPOSAL). */
  label: string;
  /** Plain-language question, asked ONLY when the field is missing
   *  (PROPOSAL wording). */
  question: string;
  /** Short hint shown under the question (PROPOSAL). */
  hint: string;
  /** Topic phrases that count as "the website/details index states
   *  something about this rule". Matched case-insensitively; ASCII
   *  phrases match on word boundaries so "return" does not match
   *  "returning". */
  keywords: string[];
}

/**
 * The CLOSED prompt set: exactly these 8 business-rule fields, in
 * this fixed order. No other field is ever prompted for by this leg:
 * contact name/phone/address, business name/description, opening
 * hours, and the website list already have their own dashboard
 * editors at HEAD and are deliberately NOT re-asked here.
 *
 * deliveryAreas is the SHOP's own delivery statement (where the shop
 * itself delivers). It is NOT the Ride Bangla courier coverage map:
 * courier availability follows the coverage doctrine separately and
 * is never derived from this field.
 *
 * paymentMethods is accepted-methods text ONLY (e.g. which methods
 * the shop accepts). It never carries amounts, account numbers, or
 * transaction IDs — advance-payment configuration is a separate
 * staged concern and is never written or read here.
 */
export const BUSINESS_RULE_FIELDS: BusinessRuleFieldDef[] = [
  {
    field: "deliveryCharge",
    kind: "money",
    label: "Delivery charge",
    question:
      "What delivery charge should the agent quote to customers? Please give the amount and the currency.",
    hint: "This is the only delivery figure the agent will ever quote. If delivery is free, enter 0.",
    keywords: [
      "delivery charge",
      "delivery charges",
      "delivery fee",
      "delivery cost",
      "shipping charge",
      "shipping fee",
      "shipping cost",
      "ডেলিভারি চার্জ",
      "ডেলিভারি ফি",
    ],
  },
  {
    field: "deliveryAreas",
    kind: "text",
    label: "Delivery areas",
    question: "Where does your business deliver?",
    hint: "List the areas, districts, or cities you deliver to, in your own words.",
    keywords: [
      "delivery area",
      "delivery areas",
      "delivery coverage",
      "delivery zone",
      "we deliver",
      "deliver to",
      "delivery location",
      "ডেলিভারি এলাকা",
    ],
  },
  {
    field: "deliveryTime",
    kind: "text",
    label: "Delivery time",
    question: "How long does delivery usually take?",
    hint: "For example, same-day, next-day, or a range of days — in your own words.",
    keywords: [
      "delivery time",
      "delivery within",
      "delivered within",
      "delivery takes",
      "delivery duration",
      "ডেলিভারি সময়",
    ],
  },
  {
    field: "returnPolicy",
    kind: "text",
    label: "Return policy",
    question: "What is your return policy?",
    hint: "Tell customers when and how they can return a product, in your own words.",
    keywords: ["return policy", "returns", "return", "রিটার্ন", "ফেরত"],
  },
  {
    field: "exchangePolicy",
    kind: "text",
    label: "Exchange policy",
    question: "What is your exchange policy?",
    hint: "Tell customers when and how they can exchange a product, in your own words.",
    keywords: ["exchange policy", "exchange", "এক্সচেঞ্জ", "বদল"],
  },
  {
    field: "refundPolicy",
    kind: "text",
    label: "Refund policy",
    question: "What is your refund policy?",
    hint: "Tell customers when they get a refund and how it is given, in your own words.",
    keywords: ["refund policy", "refund", "রিফান্ড", "টাকা ফেরত"],
  },
  {
    field: "paymentMethods",
    kind: "text",
    label: "Payment methods",
    question: "Which payment methods do you accept?",
    hint: "List the methods only — never account numbers or transaction details.",
    keywords: [
      "payment method",
      "payment methods",
      "payment option",
      "cash on delivery",
      "cod available",
      "pay by",
      "পেমেন্ট",
      "ক্যাশ অন ডেলিভারি",
    ],
  },
  {
    field: "minimumOrder",
    kind: "money",
    label: "Minimum order amount",
    question:
      "Is there a minimum order amount? If yes, please give the amount and the currency. If no, leave it blank.",
    hint: "Leave blank when there is no minimum. The agent never invents one.",
    keywords: [
      "minimum order",
      "minimum purchase",
      "min order",
      "মিনিমাম অর্ডার",
    ],
  },
];

export const FIELD_DEF_BY_ID: Record<BusinessRuleFieldId, BusinessRuleFieldDef> =
  Object.fromEntries(
    BUSINESS_RULE_FIELDS.map((d) => [d.field, d])
  ) as Record<BusinessRuleFieldId, BusinessRuleFieldDef>;

/** Supplementary framing note returned with every detection response.
 *  It exists so no consumer can present these prompts as the way the
 *  agent learns the business: website-first, details-second, these
 *  prompts only for what neither covered. (PROPOSAL wording.) */
export const SUPPLEMENTARY_NOTE =
  "Supplementary only — your website and business details stay the source of truth. " +
  "These questions only fill gaps neither of them covered, and they never replace website-derived knowledge.";

const MAX_TEXT_LENGTH = 2000;
const MAX_NOTE_LENGTH = 500;
const EXCERPT_LENGTH = 240;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ASCII_DIGIT_RE = /[0-9]/;
const BENGALI_DIGIT_RE = /[০-৯]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `text` mention `keyword`? ASCII phrases match on word
 *  boundaries; non-ASCII phrases match by substring (word-boundary
 *  regexes do not behave for Bengali script). */
export function matchesKeyword(text: string, keyword: string): boolean {
  const hay = text.toLowerCase();
  const needle = keyword.toLowerCase();
  if (/^[a-z0-9 ]+$/.test(needle)) {
    return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(hay);
  }
  return hay.includes(needle);
}

function entryText(entry: RuleKnowledgeEntry): string {
  return `${entry.title ?? ""}\n${entry.content ?? ""}`;
}

function hasNumber(text: string): boolean {
  return ASCII_DIGIT_RE.test(text) || BENGALI_DIGIT_RE.test(text);
}

export interface CoveringEntry {
  entryId?: string;
  excerpt: string;
}

/**
 * Find the first PRIMARY-source entry covering `field`, or null.
 * Structured (money) fields additionally require a number in the
 * same entry — a mention without a figure is not a stated value.
 * Returns the excerpt only for display in conflict/prompt flows;
 * the figure itself is NEVER extracted or reused for quoting.
 */
export function findCoveringEntry(
  entries: RuleKnowledgeEntry[],
  field: BusinessRuleFieldId
): CoveringEntry | null {
  const def = FIELD_DEF_BY_ID[field];
  for (const entry of entries) {
    if (!isCoveringSource(entry)) continue;
    const text = entryText(entry);
    const mentioned = def.keywords.some((k) => matchesKeyword(text, k));
    if (!mentioned) continue;
    if (def.kind === "money" && !hasNumber(text)) continue;
    const flat = text.replace(/\s+/g, " ").trim();
    return {
      entryId: entry.id,
      excerpt: flat.slice(0, EXCERPT_LENGTH),
    };
  }
  return null;
}

export type RuleStatus = "set" | "website" | "missing";

export interface RuleFieldState {
  field: BusinessRuleFieldId;
  kind: BusinessRuleKind;
  status: RuleStatus;
  /** Saved tenant value, when status is "set". */
  value?: BusinessRuleValue;
  /** Website/details entry covering this field, when present. */
  covering?: CoveringEntry;
  /** True when a tenant value exists AND a primary-source entry also
   *  covers the field. Informational only: the tenant value stands
   *  (it is tenant configuration), but the dashboard should show
   *  the divergence so the tenant can reconcile the sources. */
  divergesFromWebsite?: boolean;
}

export interface RuleDetection {
  fields: RuleFieldState[];
  missingFields: BusinessRuleFieldId[];
  prompts: Array<{
    field: BusinessRuleFieldId;
    kind: BusinessRuleKind;
    label: string;
    question: string;
    hint: string;
  }>;
}

function isSetValue(
  field: BusinessRuleFieldId,
  rules: BusinessRulesDoc | null | undefined
): BusinessRuleValue | undefined {
  if (!rules) return undefined;
  const raw = (rules as unknown as Record<string, unknown>)[field];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") {
    const v = raw.trim();
    return v ? v : undefined;
  }
  if (typeof raw === "object") {
    const m = raw as { amount?: unknown; currency?: unknown };
    if (
      typeof m.amount === "number" &&
      Number.isFinite(m.amount) &&
      typeof m.currency === "string" &&
      m.currency
    ) {
      return raw as MoneyValue;
    }
  }
  return undefined;
}

/**
 * Missing-field detection. A field is missing ONLY when it has no
 * saved tenant value AND no primary-source entry covers it.
 * Prompt generation (buildPrompts, inlined here) emits questions
 * for exactly the missing fields, in FIELD_DEFS order — never for
 * set fields, never for website/details-covered fields, never for
 * anything outside the closed 8-field set.
 */
export function detectRules(
  rules: BusinessRulesDoc | null | undefined,
  entries: RuleKnowledgeEntry[]
): RuleDetection {
  const fields: RuleFieldState[] = BUSINESS_RULE_FIELDS.map((def) => {
    const value = isSetValue(def.field, rules);
    const covering = findCoveringEntry(entries, def.field);
    if (value !== undefined) {
      return {
        field: def.field,
        kind: def.kind,
        status: "set" as const,
        value,
        ...(covering ? { covering, divergesFromWebsite: true } : {}),
      };
    }
    if (covering) {
      return {
        field: def.field,
        kind: def.kind,
        status: "website" as const,
        covering,
      };
    }
    return { field: def.field, kind: def.kind, status: "missing" as const };
  });
  const missingFields = fields
    .filter((f) => f.status === "missing")
    .map((f) => f.field);
  const prompts = fields
    .filter((f) => f.status === "missing")
    .map((f) => {
      const def = FIELD_DEF_BY_ID[f.field];
      return {
        field: f.field,
        kind: f.kind,
        label: def.label,
        question: def.question,
        hint: def.hint,
      };
    });
  return { fields, missingFields, prompts };
}

export interface ValidatedAnswers {
  /** Field -> clean value, or null to CLEAR a saved value. */
  clean: Partial<Record<BusinessRuleFieldId, BusinessRuleValue | null>>;
  errors: Array<{ field: string; reason: string }>;
}

/**
 * Validate a tenant answer payload. Unknown fields are errors (never
 * silently stored); undefined skips a field; explicit null clears it.
 * Money: amount must be a finite number — deliveryCharge may be 0
 * (free delivery), minimumOrder must be > 0 — plus a 3-letter
 * currency code (never defaulted) and an optional short note.
 * Text: 1..2000 chars after trimming. No value is ever invented:
 * bad values are reported per-field and nothing is written.
 */
export function validateAnswers(answers: unknown): ValidatedAnswers {
  const clean: Partial<Record<BusinessRuleFieldId, BusinessRuleValue | null>> =
    {};
  const errors: Array<{ field: string; reason: string }> = [];
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    return { clean, errors: [{ field: "", reason: "answers_must_be_object" }] };
  }
  for (const [key, raw] of Object.entries(
    answers as Record<string, unknown>
  )) {
    const def = (FIELD_DEF_BY_ID as Record<string, BusinessRuleFieldDef>)[
      key
    ];
    if (!def) {
      errors.push({ field: key, reason: "unknown_field" });
      continue;
    }
    if (raw === undefined) continue;
    if (raw === null) {
      clean[def.field] = null;
      continue;
    }
    if (def.kind === "text") {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        errors.push({ field: key, reason: "empty_text" });
        continue;
      }
      if (raw.trim().length > MAX_TEXT_LENGTH) {
        errors.push({ field: key, reason: "text_too_long" });
        continue;
      }
      clean[def.field] = raw.trim();
      continue;
    }
    // money
    if (typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ field: key, reason: "money_must_be_object" });
      continue;
    }
    const m = raw as { amount?: unknown; currency?: unknown; note?: unknown };
    if (
      typeof m.amount !== "number" ||
      !Number.isFinite(m.amount) ||
      m.amount < 0
    ) {
      errors.push({ field: key, reason: "invalid_amount" });
      continue;
    }
    if (def.field === "minimumOrder" && m.amount <= 0) {
      errors.push({ field: key, reason: "minimum_must_be_positive" });
      continue;
    }
    if (typeof m.currency !== "string" || !CURRENCY_RE.test(m.currency)) {
      errors.push({ field: key, reason: "invalid_currency" });
      continue;
    }
    if (
      m.note !== undefined &&
      (typeof m.note !== "string" || m.note.trim().length > MAX_NOTE_LENGTH)
    ) {
      errors.push({ field: key, reason: "invalid_note" });
      continue;
    }
    const value: MoneyValue = { amount: m.amount, currency: m.currency };
    if (typeof m.note === "string" && m.note.trim()) {
      value.note = m.note.trim();
    }
    clean[def.field] = value;
  }
  return { clean, errors };
}

export interface WebsiteConflict {
  field: BusinessRuleFieldId;
  /** The tenant's proposed answer (never written while conflicting). */
  proposed: BusinessRuleValue;
  /** The primary-source entry it stands beside. */
  websiteEntryId?: string;
  websiteExcerpt: string;
  /** What the tenant must do: confirm explicitly, or correct the
   *  website/details source and re-index. (PROPOSAL wording.) */
  message: string;
}

export interface ApplyResult {
  /** Next rules document (current + applied writes). */
  next: BusinessRulesDoc;
  applied: BusinessRuleFieldId[];
  cleared: BusinessRuleFieldId[];
  conflicts: WebsiteConflict[];
}

/**
 * Apply validated answers under the CONFLICT RULE.
 *
 * - A field with a primary-source covering entry and an unconfirmed
 *   new (non-null) answer -> conflict: NOT written, reported with
 *   both texts. Nothing else in the batch is written either when
 *   the route uses this result atomically (see the route: any
 *   conflict without confirmConflict => 409, zero writes).
 * - The same answer WITH confirmConflict -> written, and the
 *   covering entry is recorded under overridesWebsite (entry
 *   itself untouched). The tenant's explicit decision is what
 *   makes this different from a silent overwrite.
 * - Clearing (null) while website-covered is allowed without
 *   confirmation: it removes tenant configuration, it does not
 *   overwrite the website fact, and the field returns to
 *   "website" status on the next detection.
 * - A field with no covering entry overwrites freely: it is the
 *   tenant's own configuration.
 *
 * `nowIso` is injected (route passes the current time; tests pass a
 * fixed time) so override records are deterministic in tests.
 */
export function applyAnswers(
  current: BusinessRulesDoc,
  validated: Partial<Record<BusinessRuleFieldId, BusinessRuleValue | null>>,
  detection: RuleDetection,
  opts: { confirmConflict: boolean; nowIso: string }
): ApplyResult {
  const next: BusinessRulesDoc = {
    ...current,
    overridesWebsite: { ...(current.overridesWebsite ?? {}) },
  };
  const applied: BusinessRuleFieldId[] = [];
  const cleared: BusinessRuleFieldId[] = [];
  const conflicts: WebsiteConflict[] = [];
  const stateByField = new Map(
    detection.fields.map((f) => [f.field, f])
  );
  for (const [field, value] of Object.entries(validated)) {
    const f = field as BusinessRuleFieldId;
    const state = stateByField.get(f);
    if (value === null) {
      // Clear: drop the tenant value (and any stale override note
      // for that field — the website fact, if any, speaks again).
      delete (next as unknown as Record<string, unknown>)[f];
      if (next.overridesWebsite) delete next.overridesWebsite[f];
      cleared.push(f);
      continue;
    }
    if (state?.covering && !opts.confirmConflict) {
      conflicts.push({
        field: f,
        proposed: value,
        websiteEntryId: state.covering.entryId,
        websiteExcerpt: state.covering.excerpt,
        message:
          "Your website or business details already state something about this. " +
          "Confirm explicitly to save your answer beside it, or correct it at the source instead.",
      });
      continue;
    }
    (next as unknown as Record<string, unknown>)[f] = value;
    if (state?.covering && opts.confirmConflict) {
      if (!next.overridesWebsite) next.overridesWebsite = {};
      next.overridesWebsite[f] = {
        entryId: state.covering.entryId,
        excerpt: state.covering.excerpt,
        confirmedAt: opts.nowIso,
      };
    } else if (!state?.covering && next.overridesWebsite) {
      // Coverage went away: the override note is stale, drop it.
      delete next.overridesWebsite[f];
    }
    applied.push(f);
  }
  return { next, applied, cleared, conflicts };
}

/**
 * Format saved rules as the agent-prompt section. Returns "" when
 * nothing is set — the engine then emits NO rules section at all,
 * and the agent falls back to its standing honesty rule (say it
 * does not have the detail yet). Only saved tenant figures appear:
 * website figures are never copied in here (they already reach the
 * agent through the knowledge base), and a missing figure is never
 * filled with a guess, a catalog price, or a default.
 */
export function formatBusinessRulesForPrompt(
  rules: BusinessRulesDoc | null | undefined
): string {
  if (!rules) return "";
  const lines: string[] = [];
  const money = (v: MoneyValue): string =>
    `${v.amount} ${v.currency}${v.note ? ` (${v.note})` : ""}`;
  const setMoney = (field: BusinessRuleFieldId): MoneyValue | undefined =>
    isSetValue(field, rules) as MoneyValue | undefined;
  const setText = (field: BusinessRuleFieldId): string | undefined =>
    isSetValue(field, rules) as string | undefined;
  const dc = setMoney("deliveryCharge");
  if (dc) lines.push(`- Delivery charge: ${money(dc)}`);
  const mo = setMoney("minimumOrder");
  if (mo) lines.push(`- Minimum order amount: ${money(mo)}`);
  const textFields: Array<[BusinessRuleFieldId, string]> = [
    ["deliveryAreas", "Delivery areas"],
    ["deliveryTime", "Delivery time"],
    ["returnPolicy", "Return policy"],
    ["exchangePolicy", "Exchange policy"],
    ["refundPolicy", "Refund policy"],
    ["paymentMethods", "Accepted payment methods"],
  ];
  for (const [field, label] of textFields) {
    const v = setText(field);
    if (v) lines.push(`- ${label}: ${v}`);
  }
  if (lines.length === 0) return "";
  return (
    "## Business Rules (set by the business owner)\n" +
    "Use ONLY the figures and policies listed here for these topics. " +
    "If a customer asks about one of these topics and it is NOT listed here, " +
    "say plainly that you do not have that detail yet — never guess a figure, charge, or policy.\n\n" +
    lines.join("\n")
  );
}
