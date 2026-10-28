/**
 * agent-index.ts — per-website indexes for ONE account's agent.
 *
 * OWNER RULE 2026-10-25 ~00:54 §2 + §8:
 * - Each account submits its OWN website; if no website exists, the
 *   account submits business DETAILS and a LANDING PAGE is created from
 *   those details — exactly per those details.
 * - The created agent SETS ITS INDEX from that source and converses
 *   PER THAT INDEX.
 * - Many websites can be added per account; even if ONE agent is shown,
 *   its indexes are arranged PER WEBSITE so it answers COMPLETELY about
 *   each website, however anyone asks.
 *
 * PURE MODULE (no imports, no DB). Rules that matter:
 * 1. An index contains ONLY its own website's entries. Entries are never
 *    blended across websites in one answer, and never borrowed from
 *    another website (or from Ride Bangla) to fill a gap.
 * 2. A landing-page index is built ONLY from the submitted details
 *    (name, description, services). Missing details => empty index, not
 *    invented copy. (Same honesty rule as landing-copy.ts.)
 * 3. Resolution: an explicit website mention in the question wins; else
 *    the website the visitor is currently on (activeWebsiteId) wins;
 *    else a single index wins; else the question is AMBIGUOUS and the
 *    agent must ask which website — never guess or merge.
 *
 * ENGINE WIRING (apply-time, NOT in this staged diff): the local engine
 * loads ALL of a business's knowledge entries with no website column
 * (KnowledgeEntry has only metadata Json; no websiteId field exists in
 * this copy's schema). Before the prompt is built, the apply step must
 * filter that list to the resolved index's entries (convention:
 * metadata.sourceWebsiteId, or a websiteId column added by migration).
 * Until that wiring lands, this module + its harness are the contract
 * the engine must satisfy; do not claim multi-website scoping is live
 * from this module alone.
 */

export interface WebsiteInput {
  id: string;
  label: string;
  url?: string | null;
  /** "website" = submitted site; "landing" = page built from details. */
  source: "website" | "landing";
}

export interface IndexEntry {
  title: string;
  content: string;
  /** Website this entry belongs to; null = business-level, unattributed. */
  websiteId: string | null;
}

export interface WebsiteIndex {
  websiteId: string;
  label: string;
  url: string | null;
  source: "website" | "landing";
  entries: IndexEntry[];
}

/**
 * Build the landing-page index from submitted business details ONLY.
 * No website, no invented services: an empty details object yields an
 * index with zero entries, and answers from it must say so honestly.
 */
export function buildLandingIndex(details: {
  businessName: string;
  businessDesc?: string | null;
  services?: string[];
}): WebsiteIndex {
  const entries: IndexEntry[] = [];
  const desc = (details.businessDesc ?? "").trim();
  if (desc) {
    entries.push({
      title: `About ${details.businessName}`,
      content: desc,
      websiteId: "landing",
    });
  }
  for (const s of details.services ?? []) {
    const service = s.trim();
    if (service) {
      entries.push({ title: service, content: service, websiteId: "landing" });
    }
  }
  return {
    websiteId: "landing",
    label: `${details.businessName} (landing page)`,
    url: null,
    source: "landing",
    entries,
  };
}

/** Partition entries into one index per website. Unattributed entries
 * (websiteId null or unknown) belong to NO website index: they are
 * never silently served as if they were a website's content. */
export function buildAccountIndexes(
  websites: WebsiteInput[],
  entries: IndexEntry[]
): WebsiteIndex[] {
  return websites.map((w) => ({
    websiteId: w.id,
    label: w.label,
    url: w.url ?? null,
    source: w.source,
    entries: entries.filter((e) => e.websiteId === w.id),
  }));
}

/** Entries of one index, complete and untruncated (rule §8: "completely"). */
export function scopeEntriesToIndex(
  index: WebsiteIndex,
  entries: IndexEntry[]
): IndexEntry[] {
  return entries.filter((e) => e.websiteId === index.websiteId);
}

function hostnameOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Does the question mention this website (by label or by hostname)? */
export function mentionsWebsite(question: string, index: WebsiteIndex): boolean {
  const q = question.toLowerCase();
  if (index.label && q.includes(index.label.toLowerCase())) return true;
  const host = hostnameOf(index.url);
  if (host && q.includes(host)) return true;
  return false;
}

export type IndexResolution =
  | { kind: "resolved"; index: WebsiteIndex }
  | { kind: "ambiguous"; candidates: WebsiteIndex[] }
  | { kind: "none" };

/**
 * Resolve which website's index a turn draws from. Mention > active
 * site > single index > ambiguous (ask, don't merge, don't guess).
 */
export function resolveIndexForQuestion(
  question: string,
  indexes: WebsiteIndex[],
  activeWebsiteId?: string | null
): IndexResolution {
  if (indexes.length === 0) return { kind: "none" };
  const mentioned = indexes.filter((ix) => mentionsWebsite(question, ix));
  if (mentioned.length === 1) return { kind: "resolved", index: mentioned[0] };
  if (mentioned.length > 1) return { kind: "ambiguous", candidates: mentioned };
  if (activeWebsiteId) {
    const active = indexes.find((ix) => ix.websiteId === activeWebsiteId);
    if (active) return { kind: "resolved", index: active };
  }
  if (indexes.length === 1) return { kind: "resolved", index: indexes[0] };
  return { kind: "ambiguous", candidates: indexes };
}

/** Attribute an answer to exactly one website, so a multi-website
 * answer never reads as if it came from another website. */
export function attributeAnswerToIndex(
  index: WebsiteIndex,
  answer: string
): string {
  return `${answer}\n(Source: ${index.label})`;
}

/** The ask-which-website reply for an ambiguous turn (BN/EN). */
export function ambiguousWebsitesReply(
  candidates: WebsiteIndex[],
  lang: "bn" | "en"
): string {
  const names = candidates.map((c) => c.label).join(", ");
  return lang === "bn"
    ? `আপনি কোন ওয়েবসাইটের কথা বলছেন — ${names}?`
    : `Which website do you mean — ${names}?`;
}
