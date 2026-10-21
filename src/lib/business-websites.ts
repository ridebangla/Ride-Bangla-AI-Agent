/**
 * business-websites.ts — the business website list + knowledge ingestion
 * (owner directive 2026-10-21).
 *
 * The owner reported that in the AI account "আমাদের ওয়েবসাইট অ্যাড করা
 * যায় না" — a website could not be added. The map behind that: the only
 * website value on a business was the legacy single `websiteUrl`, set at
 * signup or inside the landing-page editor, and NOTHING ever read it for
 * the agent. The only fetch-and-learn path was onboarding's one-URL
 * wizard step. This module is the missing piece:
 *
 *  - the business keeps a LIST of websites (`Business.websites`) — no
 *    one-site limit, no plan-based cap of any kind (so the internal
 *    owner account is trivially unlimited too; customer caps were never
 *    part of the plan design and none are invented here);
 *  - every listed website is fetched + structured by the EXISTING
 *    scraper (`src/lib/scrape.ts`, the same one onboarding uses) and the
 *    resulting Q&A pairs are saved as knowledge entries, so the engine's
 *    existing KB consult (`getKnowledgeBase` in src/lib/ai/engine.ts,
 *    which loads every active entry for the business) covers all sites;
 *  - each entry carries the website's id (`sourceWebsiteId`) so
 *    re-indexing or removing one website replaces exactly its own
 *    entries and never touches entries from other sites or onboarding;
 *  - status is honest: "indexed" is written only after a real run saved
 *    entries, with the fetched page count; a failed fetch writes
 *    "failed" + the scraper's own reason. Nothing here ever claims a
 *    site was learned when it was not.
 *
 * Tenancy: the business doc is read/written via the unscoped client with
 * the caller's OWN business id (taken from auth, never from a request
 * body); all knowledge writes run inside runWithBusiness(businessId).
 */
import { randomUUID } from "crypto";
import { getUnscopedPrisma, runWithBusiness, prisma } from "./prisma";
import { scrapeBusinessWebsite } from "./scrape";
import {
  hasDuplicateWebsite,
  mergeWebsitesWithLegacy,
  normalizeWebsiteUrl,
  websiteKeyOf,
} from "./website-url";
import { logger } from "./logger";
import type { Business, BusinessWebsite } from "./models";

/** Per-site knowledge cap — mirrors the onboarding confirm cap. */
export const MAX_ENTRIES_PER_WEBSITE = 200;
/** KB category that holds everything learned from the business's sites. */
export const WEBSITE_CATEGORY_NAME = "Website";

function nowIso(): string {
  return new Date().toISOString();
}

/** The business's website list, legacy single-URL businesses included. */
export function listBusinessWebsites(
  business: Pick<Business, "websites" | "websiteUrl">
): BusinessWebsite[] {
  return mergeWebsitesWithLegacy(business.websites, business.websiteUrl, (url, host) => ({
    id: "legacy",
    url,
    host,
    status: "pending",
    addedAt: nowIso(),
    lastIndexedAt: null,
  }));
}

export async function loadBusiness(
  businessId: string
): Promise<Business | null> {
  const db = getUnscopedPrisma();
  const biz = (await db.business.findUnique({
    where: { id: businessId },
  })) as unknown as Business | null;
  return biz ?? null;
}

/**
 * Persist the list on the business doc. The legacy `websiteUrl` is kept
 * in sync with the FIRST entry (the public landing page links to it);
 * an empty list clears it.
 */
export async function saveBusinessWebsites(
  businessId: string,
  websites: BusinessWebsite[]
): Promise<void> {
  const db = getUnscopedPrisma();
  await db.business.update({
    where: { id: businessId },
    data: {
      websites,
      websiteUrl: websites.length > 0 ? websites[0].url : null,
    } as Record<string, unknown>,
  });
}

export interface IngestResult {
  status: "indexed" | "failed";
  pageCount: number;
  entryCount: number;
  reason?: string;
}

/**
 * Fetch one website and (re)build its knowledge entries. Runs the
 * scrape OUTSIDE the tenant scope (pure outbound fetch, SSRF-guarded by
 * the scraper itself), then swaps the entries inside it. Never throws:
 * the outcome is reported as data so the caller can persist the honest
 * per-site status either way.
 */
export async function ingestBusinessWebsite(
  businessId: string,
  website: BusinessWebsite
): Promise<IngestResult> {
  let structured;
  try {
    structured = await scrapeBusinessWebsite(website.url);
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Couldn't fetch that website.";
    logger.warn(
      `[websites] ingest failed business=${businessId} url=${website.url}: ${reason}`
    );
    return { status: "failed", pageCount: 0, entryCount: 0, reason };
  }

  const qa = structured.qa.slice(0, MAX_ENTRIES_PER_WEBSITE);

  const entryCount = await runWithBusiness(businessId, async () => {
    let category = await prisma.category.findFirst({
      where: { name: WEBSITE_CATEGORY_NAME },
    });
    if (!category) {
      category = await prisma.category.create({
        data: {
          name: WEBSITE_CATEGORY_NAME,
          description: "Learned from your websites",
        },
      });
    }

    // Replace exactly this website's previous entries — other sites and
    // other sources (onboarding, manual entries) are untouched.
    await prisma.knowledgeEntry.deleteMany({
      where: { sourceWebsiteId: website.id },
    });

    let created = 0;
    for (const pair of qa) {
      await prisma.knowledgeEntry.create({
        data: {
          categoryId: category.id,
          title: pair.question,
          content: pair.answer,
          sourceWebsiteId: website.id,
          metadata: {
            source: "website",
            sourceUrl: website.url,
            websiteId: website.id,
          },
        },
      });
      created++;
    }
    return created;
  });

  logger.warn(
    `[websites] indexed business=${businessId} url=${website.url} ` +
      `pages=${structured.pagesScraped.length} entries=${entryCount}`
  );
  return {
    status: "indexed",
    pageCount: structured.pagesScraped.length,
    entryCount,
  };
}

/**
 * Add a website to the business's list and index it immediately.
 * Returns the stored entry (with its final, honest status), or a
 * user-facing error string for invalid/duplicate input.
 */
export async function addBusinessWebsite(
  businessId: string,
  rawUrl: unknown
): Promise<{ website: BusinessWebsite } | { error: string }> {
  const normalized = normalizeWebsiteUrl(rawUrl);
  if (!normalized.ok) return { error: normalized.error };

  const business = await loadBusiness(businessId);
  if (!business) return { error: "Business not found." };

  const websites = listBusinessWebsites(business);
  if (hasDuplicateWebsite(websites, normalized.value.key)) {
    return {
      error:
        "That website is already in your list — you don't need to add it twice.",
    };
  }

  const website: BusinessWebsite = {
    id: randomUUID(),
    url: normalized.value.url,
    host: normalized.value.host,
    status: "pending",
    addedAt: nowIso(),
    lastIndexedAt: null,
  };
  const next = [...websites, website];
  // Persist BEFORE ingesting so a slow/failed fetch never loses the
  // owner's entry — it stays in the list with its honest status.
  await saveBusinessWebsites(businessId, next);

  const result = await ingestBusinessWebsite(businessId, website);
  const updated: BusinessWebsite = {
    ...website,
    status: result.status,
    statusReason: result.status === "failed" ? result.reason : undefined,
    pageCount: result.pageCount,
    entryCount: result.entryCount,
    lastIndexedAt: nowIso(),
  };
  const finalList = next.map((w) => (w.id === website.id ? updated : w));
  await saveBusinessWebsites(businessId, finalList);
  return { website: updated };
}

/** Re-run ingestion for one already-listed website. */
export async function reindexBusinessWebsite(
  businessId: string,
  websiteId: string
): Promise<{ website: BusinessWebsite } | { error: string }> {
  const business = await loadBusiness(businessId);
  if (!business) return { error: "Business not found." };
  const websites = listBusinessWebsites(business);
  const website = websites.find((w) => w.id === websiteId);
  if (!website) return { error: "That website is no longer in your list." };

  const result = await ingestBusinessWebsite(businessId, website);
  const updated: BusinessWebsite = {
    ...website,
    status: result.status,
    statusReason: result.status === "failed" ? result.reason : undefined,
    pageCount: result.pageCount,
    entryCount: result.entryCount,
    lastIndexedAt: nowIso(),
  };
  await saveBusinessWebsites(
    businessId,
    websites.map((w) => (w.id === websiteId ? updated : w))
  );
  return { website: updated };
}

/** Remove one website AND the knowledge entries learned from it. */
export async function removeBusinessWebsite(
  businessId: string,
  websiteId: string
): Promise<{ removed: boolean }> {
  const business = await loadBusiness(businessId);
  if (!business) return { removed: false };
  const websites = listBusinessWebsites(business);
  if (!websites.some((w) => w.id === websiteId)) return { removed: false };

  await runWithBusiness(businessId, async () => {
    await prisma.knowledgeEntry.deleteMany({
      where: { sourceWebsiteId: websiteId },
    });
  });
  await saveBusinessWebsites(
    businessId,
    websites.filter((w) => w.id !== websiteId)
  );
  return { removed: true };
}

/**
 * Record websites that onboarding just ingested through its own review
 * flow (analyze → confirm), so the Settings list tells the truth about
 * them too: status "indexed" with the page/entry counts the wizard
 * actually produced. Existing entries keep their id + addedAt.
 */
export async function recordOnboardingWebsites(
  businessId: string,
  sites: Array<{ url: string; pageCount?: number; entryCount?: number }>
): Promise<void> {
  const business = await loadBusiness(businessId);
  if (!business) return;
  const websites = listBusinessWebsites(business);
  const keyOf = (w: BusinessWebsite) => websiteKeyOf(w.url);

  let changed = false;
  for (const site of sites.slice(0, 25)) {
    const normalized = normalizeWebsiteUrl(site?.url);
    if (!normalized.ok) continue;
    const key = normalized.value.key;
    const existingIdx = websites.findIndex((w) => keyOf(w) === key);
    const stamp = nowIso();
    if (existingIdx >= 0) {
      websites[existingIdx] = {
        ...websites[existingIdx],
        status: "indexed",
        statusReason: undefined,
        pageCount:
          typeof site.pageCount === "number"
            ? site.pageCount
            : websites[existingIdx].pageCount,
        entryCount:
          typeof site.entryCount === "number"
            ? site.entryCount
            : websites[existingIdx].entryCount,
        lastIndexedAt: stamp,
      };
    } else {
      websites.push({
        id: randomUUID(),
        url: normalized.value.url,
        host: normalized.value.host,
        status: "indexed",
        pageCount: typeof site.pageCount === "number" ? site.pageCount : undefined,
        entryCount: typeof site.entryCount === "number" ? site.entryCount : undefined,
        addedAt: stamp,
        lastIndexedAt: stamp,
      });
    }
    changed = true;
  }
  if (changed) await saveBusinessWebsites(businessId, websites);
}
