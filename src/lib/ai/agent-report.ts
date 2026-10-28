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
    ticketTitle: "[Agent report] AI provider failure during customer chat",
    ticketDescription: detail,
    priority: "high",
    conversationId: input.conversationId,
  };
}

/**
 * Owner's disclosure wording, in the customer's language. Returns null
 * when there is no report id — the caller must NOT disclose then.
 */
export function disclosureForReport(
  lang: "bn" | "en",
  reportId: string | null
): string | null {
  if (!reportId) return null;
  return lang === "bn"
    ? `এখানে যে সমস্যাটা হচ্ছে — আমি সে সম্পর্কে আমার টিমকে তথ্য পাঠাচ্ছি। (রিপোর্ট: ${reportId})`
    : `The problem happening here — I am sending information about it to my team. (Report: ${reportId})`;
}
