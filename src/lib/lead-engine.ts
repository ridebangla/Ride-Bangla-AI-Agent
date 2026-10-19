/**
 * lead-engine.ts — Harvey Lead Engine integration layer.
 *
 * ARCHITECTURE (user decision 2026-10-19): Harvey (Python outbound sales
 * agent) is NOT merged into this codebase. It runs as a separate
 * service/sidecar; Firestore is the contract between the two:
 *
 *   Harvey sidecar (Python, own infra)            This SaaS (Next.js)
 *   ─────────────────────────────────            ─────────────────────
 *   discover (OSM/Yelp) ──writes──> leadScans, leads
 *   profile + scout ──────writes──> leads (icpScore, signals)
 *   writer ───────────────writes──> leadDrafts (status: draft)
 *                                     │ human approval gate (dashboard)
 *                                     ▼
 *   sender ──reads── leadDrafts where status == 'approved'
 *            + re-runs preSendGateCheck() before EVERY send
 *
 * The web app NEVER sends email itself — there is deliberately no send
 * endpoint. The human approval gate is structural: a draft cannot be sent
 * unless a human flipped it to 'approved' in the dashboard (or the Admin
 * Console for the platform's own account), and the sidecar re-verifies the
 * deterministic gate at send time, mirroring Harvey's gate.py.
 *
 * CREDENTIAL GATING: the dashboard shows an honest "not configured" state
 * until the tenant connects a mailbox provider + an AI backend
 * (Claude/Codex subscription). No fake leads, no fake sending.
 */

export type LeadStatus =
  | "new"
  | "contacted"
  | "replied"
  | "meeting"
  | "closed"
  | "lost";

export type LeadScanStatus =
  | "draft"
  | "requested"
  | "running"
  | "completed"
  | "failed";

export type LeadDraftStatus =
  | "draft"
  | "approved"
  | "rejected"
  | "sent"
  | "failed";

export interface LeadIcp {
  industries: string[];
  companySize: string;
  titles: string[];
  geography: string[];
}

export const DEFAULT_ICP: LeadIcp = {
  industries: [],
  companySize: "",
  titles: [],
  geography: [],
};

/** The platform's own lead-engine account (Ride Bangla's outbound). */
export const PLATFORM_LEAD_BUSINESS_ID = "ride-bangla";

// ---------------------------------------------------------------------------
// Deterministic pre-send gate — TypeScript port of Harvey's gate.py.
// Constraints in the prompt are a floor, not a guarantee: every outgoing
// email passes these non-LLM checks at send time. A failure blocks the send.
// ---------------------------------------------------------------------------

const BANNED_PHRASES = [
  "act now",
  "buy now",
  "click here",
  "click below",
  "limited time",
  "limited offer",
  "exclusive deal",
  "special offer",
  "risk-free",
  "no obligation",
  "100% free",
  "make money",
  "double your",
  "guaranteed results",
  "winner",
  "congratulations",
  "i hope this finds you well",
  "hope this email finds you well",
  "i hope this email finds you",
  "picture this",
  "what if i told you",
  "in today's fast-paced world",
  "game-changer",
  "game changer",
  "cutting-edge solution",
  "revolutionize your",
  "unlock your",
  "supercharge your",
  "as an ai",
  "i'm an ai",
  "i am an ai",
  "as a language model",
];

const MAX_SUBJECT_LEN = 90;
const MAX_BODY_WORDS = 220;
const MAX_LINKS = 1;

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MERGE_TAG_RE = /\{\{\s*\w+\s*\}\}|\{\s*\w+\s*\}(?!\})/g;
const URL_RE = /https?:\/\/\S+/gi;
const HTML_RE = /<\s*(html|body|div|table|img|a)\b/i;

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Run every deterministic check on an outreach draft. Returns ok=false with
 * reasons on any hit. The sidecar MUST call this immediately before sending;
 * the dashboard calls it when a human approves, so a bad draft can be
 * rejected with the exact reasons shown.
 */
export function preSendGateCheck(
  toEmail: string,
  subject: string,
  body: string,
  prospectEmail?: string,
  emailStatus?: string
): GateResult {
  const reasons: string[] = [];
  const to = (toEmail || "").trim().toLowerCase();
  const subj = (subject || "").trim();
  const text = (body || "").trim();

  if (!EMAIL_RE.test(to)) reasons.push(`invalid recipient address '${to}'`);
  if (prospectEmail && prospectEmail.trim().toLowerCase() !== to) {
    reasons.push("recipient does not match the prospect record");
  }
  // Only verified addresses may receive cold sequences (Harvey default:
  // send_to_risky = false). Replies are exempt — deliverability proven.
  if ((emailStatus || "guess") !== "verified") {
    reasons.push(`email_status '${emailStatus || "guess"}' is not deliverable`);
  }

  if (!subj) reasons.push("empty subject");
  if (!text) reasons.push("empty body");
  if (subj.length > MAX_SUBJECT_LEN) {
    reasons.push(`subject too long (${subj.length} > ${MAX_SUBJECT_LEN})`);
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > MAX_BODY_WORDS) {
    reasons.push(`body too long (${words} words > ${MAX_BODY_WORDS})`);
  }

  const leftover = (subj + " " + text).match(MERGE_TAG_RE);
  if (leftover) {
    reasons.push(
      `unrendered merge tags: ${[...new Set(leftover)].slice(0, 3).join(", ")}`
    );
  }

  const lowered = (subj + " " + text).toLowerCase();
  const hits = BANNED_PHRASES.filter((p) => lowered.includes(p));
  if (hits.length > 0) {
    reasons.push(`banned phrases: ${hits.slice(0, 3).join(", ")}`);
  }

  const links = text.match(URL_RE) || [];
  if (links.length > MAX_LINKS) {
    reasons.push(`too many links (${links.length} > ${MAX_LINKS})`);
  }

  if (HTML_RE.test(text)) {
    reasons.push("HTML markup in body (plain text only)");
  }

  return { ok: reasons.length === 0, reasons };
}

/** A draft may only be sent when a human approved it AND the gate passes. */
export function isDraftSendable(
  draft: { status: LeadDraftStatus; subject: string; body: string; toEmail: string; prospectEmail?: string; emailStatus?: string }
): GateResult {
  if (draft.status !== "approved") {
    return { ok: false, reasons: ["draft is not approved by a human"] };
  }
  return preSendGateCheck(
    draft.toEmail,
    draft.subject,
    draft.body,
    draft.prospectEmail,
    draft.emailStatus
  );
}

export interface LeadEngineCredentials {
  mailboxProvider: "gmail" | "microsoft" | "smtp" | "none";
  mailboxConnected: boolean;
  aiBackend: "claude" | "codex" | "none";
  aiBackendConnected: boolean;
}

/** Honest "not configured" check — both halves must be connected. */
export function isLeadEngineConfigured(
  creds: LeadEngineCredentials | null | undefined
): boolean {
  return (
    !!creds &&
    creds.mailboxConnected &&
    creds.mailboxProvider !== "none" &&
    creds.aiBackendConnected &&
    creds.aiBackend !== "none"
  );
}
