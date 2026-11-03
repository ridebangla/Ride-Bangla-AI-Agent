/**
 * agent-report.ts — agent-initiated problem reports (owner rule §6).
 *
 * "On a bigger problem, the agent REPORTS it to the Admin Panel; and it
 * TELLS the customer: 'the problem happening here — I am sending
 * information about it to my team'."
 *
 * RECONCILIATION with the universal report system contract
 * (~/workspace/final-verification/universal-report-system-report.md):
 * reports live in ONE pipeline — Firestore `support_tickets` with
 * kind:"report" — NOT a second queue and NOT a new collection. This
 * local repo is Prisma/Postgres, so its Ticket model is the local leg
 * of that same pipeline: the engine writes a Ticket (ID-02's failure
 * branch) and the HEAD/Firestore apply step maps it to a
 * support_tickets doc with kind:"report", category:"report",
 * status:"open", surface:"ai". ONE contract decision is flagged, not
 * hidden: form reports use createdVia:"report_form"; an
 * agent-initiated report is a different origin, so this module uses
 * createdVia:"agent" — the Admin leg's rules allowlist must admit it
 * at assembly, or the apply step must map it to the admitted value.
 * Until then, do not claim the Firestore leg is contract-clean.
 *
 * HONESTY RULE (hard): the customer-facing disclosure is returned ONLY
 * together with a real report id. disclosureForReport(lang, null)
 * returns null — the caller must then say nothing about reporting,
 * because claiming a report that was never created is a fake claim.
 *
 * WIRING STATUS (verified 2026-11-03, TEAM B audit): this module
 * currently has NO callers in the repo — no engine/provider-failure
 * path invokes buildAgentProblemReport or disclosureForReport (the
 * engine's provider-failure branch instead issues a ticket proposal
 * and waits for acceptance). Wiring it is BLOCKED on the Reports-spec
 * decision (separate team_reports collection vs staged Admin
 * kind-slice) plus the Admin leg's createdVia allowlist — see the
 * coordinator report. Until then, do not claim agent-initiated
 * reports reach the Admin Panel.
 */

export interface AgentProblemInput {
  conversationId: string;
  customerMessage: string;
  /** Business the agent serves (for the report body, never for blame). */
  businessName?: string | null;
  surface?: "ai";
}

export interface AgentProblemReport {
  /** Universal-contract fields (Firestore leg). */
  kind: "report";
  category: "report";
  status: "open";
  createdVia: "agent";
  surface: "ai";
  subject: string;
  description: string;
  message: string;
  /**
   * The visitor's FULL words, untruncated (doctrine: a report records
   * the full message + detail). `description` below keeps the
   * 500-char operational summary for the team; this field is the
   * complete record the future Admin leg must display.
   */
  customerMessage: string;
  /** Local-repo Ticket leg mapping (engine's prisma.ticket.create). */
  ticketTitle: string;
  ticketDescription: string;
  priority: "high";
  conversationId: string;
}

export function buildAgentProblemReport(
  input: AgentProblemInput
): AgentProblemReport {
  const detail =
    `The agent could not complete a turn for conversation ${input.conversationId} ` +
    `because the AI provider failed. Customer message: ${input.customerMessage.slice(0, 500)}`;
  return {
    kind: "report",
    category: "report",
    status: "open",
    createdVia: "agent",
    surface: input.surface ?? "ai",
    subject: "Report: agent provider failure",
    description: detail,
    message: detail,
    customerMessage: input.customerMessage,
    ticketTitle: "[Agent report] AI provider failure during customer chat",
    ticketDescription: detail,
    priority: "high",
    conversationId: input.conversationId,
  };
}

/**
 * Short-reference shape (SITE-XXXXXXXX, as ticketReference builds
 * it). A raw UUID must NEVER reach a customer as a "recording
 * number" — doctrine rule 5 — so disclosure refuses anything that
 * is not a short reference, instead of displaying it.
 */
const SHORT_REFERENCE_RE = /^[A-Z]{2,8}-[A-Z0-9]{8}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isShortTicketReference(value: string | null): boolean {
  if (!value) return false;
  return SHORT_REFERENCE_RE.test(value);
}

/**
 * Owner's disclosure wording, in the customer's language. Returns null
 * when there is no report id — the caller must NOT disclose then.
 *
 * TEAM B FIX: the parameter is the SHORT recording reference, not a
 * database id. A raw UUID (or any overlong / non-reference string)
 * also returns null — the caller must then say nothing about
 * reporting, because claiming a report under a raw id would show the
 * customer an unreadable identifier the doctrine forbids. Callers
 * must pass the stored `reference` field, never `ticket.id`.
 */
export function disclosureForReport(
  lang: "bn" | "en",
  reportReference: string | null
): string | null {
  if (!reportReference) return null;
  if (UUID_RE.test(reportReference)) return null;
  if (!SHORT_REFERENCE_RE.test(reportReference)) return null;
  return lang === "bn"
    ? `এখানে যে সমস্যাটা হচ্ছে — আমি সে সম্পর্কে আমার টিমকে তথ্য পাঠাচ্ছি। (রিপোর্ট: ${reportReference})`
    : `The problem happening here — I am sending information about it to my team. (Report: ${reportReference})`;
}
