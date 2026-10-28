/**
 * client-finding.ts — the FIND-customers sub-model contract (00:58).
 *
 * OWNER RULE 2026-10-25 ~00:58 (FIRM, DEFINES checklist item 5):
 * inside the agent there is ANOTHER OPTION — a SEPARATE MODEL kept
 * inside the main model — that FINDS CLIENTS: finds prospects, SENDS
 * emails + WRITES email drafts, BUILDS a website for them, sends a
 * BEAUTIFUL PRESENTATION WITH the website that impresses the client
 * so they buy a website from us. GENERALIZED: not just websites — for
 * ANY matter, for ANY business needing client-finding, that model is
 * set inside the agent the same way.
 *
 * WHAT EXISTS IN THIS LOCAL COPY (verified by reading, not assumed):
 * - landing.ts / landing-copy.ts: builds a landing page from a
 *   business's OWN details, inventing nothing — the "build a website"
 *   machinery, but today it serves the tenant's own business, not a
 *   prospect. Reused here for the prospect preview (same honesty rule).
 * - send_internal_email tool: INTERNAL notifications only — NOT
 *   prospect outreach. No prospect email tool exists in this copy.
 * - campaigns.ts / social publisher: the business's own audience
 *   marketing, not prospect-finding.
 * - lead-engine.ts (the audit's dashboard-side scan/draft/pre-send
 *   gates, PA-15) does NOT exist in this local copy at all — it is a
 *   HEAD/Firestore file. Nothing here re-implements it silently.
 *
 * WHAT IS MISSING (gap, honestly stated):
 * - No prospect-finding mechanism, no prospect store, no sub-model
 *   mode switch, no presentation pack builder, no outreach send path.
 * - No pre-send approval gate in this copy (the HEAD lead-engine gates
 *   must be reconciled at apply time; a send path without a gate
 *   would spam prospects in the owner's name).
 *
 * TARGETING + ACCESS (owner rule 2026-10-25 ~01:02, FIRM — newer and
 * more restrictive, so it governs access): targets the BEST
 * PERFORMERS in Europe, Britain/London, Canada, America; prospects =
 * businesses with NO website or a BROKEN website; RESEARCH FIRST
 * (gather ALL information, then build + send); delivery = best-model
 * website sent by EMAIL. ACCESS IS PRIVATE, INTERNAL-ONLY: available
 * ONLY for Ride Bangla's OWN account (running on our own official
 * email) — NOT open for everyone, NOT available to any other account
 * or tenant.
 *
 * RECONCILIATION of 00:58 vs 01:02 (stated, not smoothed over): 00:58
 * generalizes the sub-model PATTERN ("for any business needing
 * client-finding, that model is set inside the agent the same way");
 * 01:02 restricts THIS deployment's ACCESS to the holder account
 * only. The staged gate therefore defaults to holder-only: the
 * pattern may one day be set inside another agent, but no tenant may
 * use this client-finding deployment until the owner says so
 * explicitly. Any future tenant availability needs a fresh owner
 * decision — it is not implied by 00:58.
 *
 * This pure module is therefore the CONTRACT for the sub-model, not
 * the sub-model itself: its mode structure, its identity rule (outreach
 * ALWAYS presents as the owner's business — the identity module
 * governs it exactly as it governs service turns), its targeting +
 * research rules, its draft + presentation-pack shape, and its send
 * gates. The harness proves the contract. Live prospecting, sending,
 * and website-building for prospects are NOT live from this module
 * and must never be claimed.
 */

import type { BusinessIdentity } from "./identity";
import { buildLandingIndex, type WebsiteIndex } from "./agent-index";

export type ClientFindingMode = "serve" | "find";

/** A prospect the sub-model found. Fixtures only in tests; production
 * prospects come from the apply-time finder, never invented here. */
export interface Prospect {
  businessName: string;
  /** What the prospect appears to need (matter, e.g. "website"). */
  need: string;
  contactEmail?: string | null;
  /** Target region (01:02): Europe / Britain / London / Canada / America. */
  region?: string | null;
  /** Website state (01:02): only "none" or "broken" are eligible. */
  websiteStatus?: "none" | "broken" | "working" | null;
  /** Research-first (01:02): true only after ALL info was gathered. */
  researched?: boolean;
  /** Details the preview website is built from — exactly these, no more. */
  details?: { businessDesc?: string | null; services?: string[] };
}

const TARGET_REGIONS = ["europe", "britain", "london", "canada", "america"];

/** 01:02 targeting: best performers in the target regions whose website
 * is missing or broken. Anything else is not a prospect for this
 * deployment, however good the business looks. */
export function isEligibleProspect(prospect: Prospect): {
  eligible: boolean;
  reason: string;
} {
  const region = (prospect.region ?? "").trim().toLowerCase();
  if (!TARGET_REGIONS.includes(region)) {
    return { eligible: false, reason: "region outside Europe/Britain/Canada/America" };
  }
  if (prospect.websiteStatus !== "none" && prospect.websiteStatus !== "broken") {
    return { eligible: false, reason: "website is neither missing nor broken" };
  }
  return { eligible: true, reason: "ok" };
}

export interface OutreachDraft {
  fromBusiness: string;
  toProspect: string;
  matter: string;
  subject: string;
  body: string;
}

export interface PresentationPack {
  prospect: Prospect;
  /** Preview website built ONLY from the prospect's details. */
  previewWebsite: WebsiteIndex;
  draft: OutreachDraft;
}

/**
 * Write the outreach draft. The sender is ALWAYS the owner's business
 * (identity.displayName). Refused (null) when: the identity is
 * unconfigured (no name to send as — the sub-model never borrows
 * another business's name), the caller is NOT the holder account
 * (01:02: internal-only access), or the prospect is ineligible
 * (01:02 targeting). Delivery is by email (01:02); the draft is the
 * email — there is no other delivery channel in this contract.
 */
export function writeOutreachDraft(
  identity: BusinessIdentity,
  prospect: Prospect,
  opts: { isHolderAccount?: boolean } = {}
): OutreachDraft | null {
  if (identity.mode === "unconfigured" || !identity.displayName) return null;
  if (!opts.isHolderAccount) return null;
  if (!isEligibleProspect(prospect).eligible) return null;
  const matter = prospect.need || "website";
  return {
    fromBusiness: identity.displayName,
    toProspect: prospect.businessName,
    matter,
    subject: `${identity.displayName} — a ${matter} for ${prospect.businessName}`,
    body:
      `Hello ${prospect.businessName} team,\n` +
      `We are ${identity.displayName}. We prepared a ${matter} preview for your business ` +
      `and would love to show it to you.\n` +
      `Please let us know a good time to walk through it.`,
  };
}

/** Build the presentation pack: preview website + draft, same identity.
 * Research-first (01:02): an unresearched prospect gets no pack — the
 * website is built only AFTER all information is gathered. */
export function buildPresentationPack(
  identity: BusinessIdentity,
  prospect: Prospect,
  opts: { isHolderAccount?: boolean } = {}
): PresentationPack | null {
  if (!prospect.researched) return null;
  const draft = writeOutreachDraft(identity, prospect, opts);
  if (!draft) return null;
  return {
    prospect,
    previewWebsite: buildLandingIndex({
      businessName: prospect.businessName,
      businessDesc: prospect.details?.businessDesc ?? null,
      services: prospect.details?.services ?? [],
    }),
    draft,
  };
}

export interface SendGateInput {
  identity: BusinessIdentity;
  draft: OutreachDraft | null;
  /** Owner/team approval for THIS outreach (pre-send gate). */
  approved: boolean;
  /** Prospect contact actually on file (not guessed). */
  contactOnFile: boolean;
  /** 01:02: holder account only (Ride Bangla's own account). */
  isHolderAccount?: boolean;
}

/**
 * The send gate: outreach sends ONLY when every condition holds —
 * holder account (01:02 internal-only), a named owner identity, a
 * draft, owner approval, and a real contact. Anything else => blocked,
 * with the reason, and nothing is sent. This is the local shape of
 * the HEAD lead-engine pre-send gates; the apply step must reconcile
 * the two gate implementations into one, never ship two.
 */
export function canSendOutreach(
  input: SendGateInput
): { allowed: boolean; reason: string } {
  if (!input.isHolderAccount) {
    return { allowed: false, reason: "client-finding is internal-only (holder account only)" };
  }
  if (input.identity.mode === "unconfigured" || !input.identity.displayName) {
    return { allowed: false, reason: "owner business is not configured" };
  }
  if (!input.draft) {
    return { allowed: false, reason: "no draft" };
  }
  if (!input.approved) {
    return { allowed: false, reason: "awaiting owner approval" };
  }
  if (!input.contactOnFile) {
    return { allowed: false, reason: "no prospect contact on file" };
  }
  return { allowed: true, reason: "ok" };
}
