/**
 * b9-company-identity.test.ts — B9 (AI read leg): estate-scoped
 * company identity.
 *
 * The shared record is Firestore `company_identity/current`
 * { aiBusinessIds, studioUids, version: 1, updatedAt, updatedBy }.
 * A business is COMPANY ⇔ listed in aiBusinessIds OR its doc carries
 * isInternalAccount === true (projection fallback). Pins:
 *  - a listed business resolves company even with the flag absent
 *    (subscription resolution reports it internal + active);
 *  - unlisted + flag true resolves company;
 *  - unlisted + flag false/absent does not;
 *  - a resolver read error degrades to flag-only behaviour (never
 *    "company", never a throw into a gate);
 *  - the metering skip and the message cap honour list membership;
 *  - the shared doc is read once per TTL window, not per gate call.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal fake Admin-SDK Firestore (hoisted): only company_identity reads.
// ---------------------------------------------------------------------------
const { fakeAdmin } = vi.hoisted(() => {
  const state = {
    doc: undefined as Record<string, unknown> | undefined,
    fail: false,
    gets: 0,
  };
  const db = {
    collection(_name: string) {
      return {
        doc(_id: string) {
          return {
            async get() {
              state.gets++;
              if (state.fail) throw new Error("firestore down");
              return {
                exists: state.doc !== undefined,
                data: () => state.doc,
              };
            },
          };
        },
      };
    },
  };
  return { fakeAdmin: { state, db } };
});

vi.mock("@/lib/admin-db", () => ({
  getAdminDb: () => fakeAdmin.db,
  __resetAdminDbForTests: () => {},
}));

import { prisma } from "@/lib/prisma";
import {
  getCompanyIdentity,
  isCompanyBusiness,
  __resetCompanyIdentityCacheForTests,
} from "@/lib/company-identity";
import { getSubscription } from "@/lib/subscription";
import { recordAiMessage, checkMessageLimitExceeded } from "@/lib/billing-usage";

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

const RECENT = new Date(Date.now() - 60 * 60 * 1000);

function biz(partial: Record<string, unknown>) {
  return {
    id: "biz-co",
    name: "Ride Bangla",
    slug: "ride-bangla",
    isActive: true,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeAdmin.state.doc = undefined;
  fakeAdmin.state.fail = false;
  fakeAdmin.state.gets = 0;
  __resetCompanyIdentityCacheForTests();
});

// ---------------------------------------------------------------------------
describe("B9 — the resolver", () => {
  it("a listed business resolves company even with the flag absent", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["biz-co"], studioUids: [], version: 1 };
    expect(await isCompanyBusiness({ id: "biz-co" })).toBe(true);
    expect(await isCompanyBusiness("biz-co")).toBe(true);
  });

  it("unlisted + flag true resolves company (projection fallback)", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["someone-else"], studioUids: [], version: 1 };
    expect(
      await isCompanyBusiness({ id: "biz-co", isInternalAccount: true })
    ).toBe(true);
  });

  it("unlisted + flag false/absent does NOT resolve company", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["someone-else"], studioUids: [], version: 1 };
    expect(await isCompanyBusiness({ id: "biz-co" })).toBe(false);
    expect(
      await isCompanyBusiness({ id: "biz-co", isInternalAccount: false })
    ).toBe(false);
    // Spoof discipline: a string "true" is not the flag.
    expect(
      await isCompanyBusiness({ id: "biz-co", isInternalAccount: "true" })
    ).toBe(false);
  });

  it("an absent shared doc is the pre-migration state: flag-only", async () => {
    fakeAdmin.state.doc = undefined;
    expect(await isCompanyBusiness({ id: "biz-co" })).toBe(false);
    expect(
      await isCompanyBusiness({ id: "biz-co", isInternalAccount: true })
    ).toBe(true);
  });

  it("a resolver read error degrades to flag-only — never company, never a throw", async () => {
    fakeAdmin.state.fail = true;
    fakeAdmin.state.doc = { aiBusinessIds: ["biz-co"], studioUids: [], version: 1 };
    expect(await isCompanyBusiness({ id: "biz-co" })).toBe(false);
    expect(
      await isCompanyBusiness({ id: "biz-co", isInternalAccount: true })
    ).toBe(true);
    const identity = await getCompanyIdentity();
    expect(identity.aiBusinessIds).toEqual([]);
  });

  it("the shared doc is read once per TTL window, not per call", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["biz-co"], studioUids: [], version: 1 };
    await getCompanyIdentity();
    await getCompanyIdentity();
    await isCompanyBusiness({ id: "biz-co" });
    expect(fakeAdmin.state.gets).toBe(1);
  });

  it("the string form also honours the doc's projection flag", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: [], studioUids: [], version: 1 };
    mockPrisma.business.findUnique.mockResolvedValue({
      isInternalAccount: true,
    });
    expect(await isCompanyBusiness("biz-flagged")).toBe(true);
    mockPrisma.business.findUnique.mockResolvedValue({
      isInternalAccount: false,
    });
    expect(await isCompanyBusiness("biz-plain")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("B9 — gates wired through the company check", () => {
  it("getSubscription: a listed-but-unflagged business resolves internal + active", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["biz-co"], studioUids: [], version: 1 };
    mockPrisma.business.findUnique.mockResolvedValue(
      biz({ plan: "starter", subscriptionStatus: "canceled" })
    );
    const sub = await getSubscription("biz-co");
    expect(sub.isInternal).toBe(true);
    expect(sub.plan).toBe("internal");
    expect(sub.isActive).toBe(true);
  });

  it("getSubscription: unlisted + unflagged stays a normal (inactive) tenant", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["someone-else"], studioUids: [], version: 1 };
    mockPrisma.business.findUnique.mockResolvedValue(
      biz({ plan: "starter", subscriptionStatus: "canceled" })
    );
    const sub = await getSubscription("biz-co");
    expect(sub.isInternal).toBe(false);
    expect(sub.isActive).toBe(false);
  });

  it("getSubscription: the isActive kill-switch still stops a listed business", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["biz-co"], studioUids: [], version: 1 };
    mockPrisma.business.findUnique.mockResolvedValue(
      biz({ isActive: false, plan: "starter", subscriptionStatus: "active" })
    );
    const sub = await getSubscription("biz-co");
    expect(sub.isInternal).toBe(true);
    expect(sub.isActive).toBe(false);
  });

  it("recordAiMessage: a listed-but-unflagged business is not metered", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["biz-co"], studioUids: [], version: 1 };
    mockPrisma.business.findUnique.mockResolvedValue({
      id: "biz-co",
      aiMessagesUsed: 42,
      usagePeriodStart: RECENT,
    });
    await recordAiMessage("biz-co");
    expect(mockPrisma.business.update).not.toHaveBeenCalled();
  });

  it("checkMessageLimitExceeded: a listed business at its plan cap is not limited", async () => {
    fakeAdmin.state.doc = { aiBusinessIds: ["biz-co"], studioUids: [], version: 1 };
    mockPrisma.business.findUnique.mockResolvedValue({
      id: "biz-co",
      plan: "starter",
      subscriptionStatus: "active",
      aiMessagesUsed: 999999,
      usagePeriodStart: RECENT,
    });
    expect(await checkMessageLimitExceeded("biz-co")).toBe(false);
  });
});
