/**
 * ai-portal.test.ts — portal-surface regression traces (AI-site
 * own-agent fix, 2026-10-30).
 *
 * HARNESS NOTE (for the verifier — stated, not assumed): the repo's
 * existing harness was not among the files supplied for this build
 * (only the engine/route sources were), so this file uses bare
 * describe/it/expect globals with NO framework import, which runs
 * under either Jest or Vitest globals. If the repo's harness
 * requires an explicit import (e.g. `from "vitest"`), add that one
 * import line at apply time — no test body changes. The imports
 * below are relative paths to the real modules, never mocks.
 *
 * WHAT RUNS HERE (pure functions, no live data, no Firestore):
 * the portal rule itself (resolvePortalSurface), its header parsing,
 * the company-identity shape guard, the portal identity templates,
 * and the portal turn-scope constant the engine spreads. The widget
 * chat route and the identity route call the SAME resolve function
 * with server-resolved inputs, so these traces cover their rule —
 * but route-level HTTP behaviour (headers → response) is NOT
 * executed here: it needs Next.js + Firestore and is a head
 * live-drive item, never a faked result.
 *
 * NOT covered here, deliberately: engine.ts's chat() (imports
 * Prisma/providers — not importable in a pure harness without
 * mocks, and this build invents no mock layer) and the greeting
 * builder (same file). Their portal branches are code-level traces
 * in BUILD.md: greeting passes "" (nameless generic greeting),
 * identity fast path passes the portal displayName + empty desc,
 * main prompt spreads PORTAL_TURN_SCOPE + portal identity line.
 */

import {
  PORTAL_ORIGIN_HOST,
  PORTAL_PLAN_NAMES,
  PORTAL_TURN_SCOPE,
  companyAiBusinessIds,
  originHostFromHeaderValue,
  resolvePortalSurface,
} from "../../src/lib/portal-surface";
import {
  answerIdentityQuestion,
  resolveBusinessIdentity,
} from "../../src/lib/ai/identity";

const AI_HOST = "ai.ridebangla.bd";
const MAIN_HOST = "ridebangla.bd";
const COMPANY_ID = "company-business-id";
const TENANT_ID = "tenant-business-id";

describe("portal resolution (server-side rule)", () => {
  it("resolves portal only for internal business + AI origin", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: true,
        businessId: COMPANY_ID,
        aiBusinessIds: [],
        originHost: AI_HOST,
      })
    ).toBe(true);
  });

  it("resolves portal via aiBusinessIds membership + AI origin", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: false,
        businessId: COMPANY_ID,
        aiBusinessIds: [COMPANY_ID],
        originHost: AI_HOST,
      })
    ).toBe(true);
  });

  it("Main origin + internal business stays tenant (the one correct site)", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: true,
        businessId: COMPANY_ID,
        aiBusinessIds: [COMPANY_ID],
        originHost: MAIN_HOST,
      })
    ).toBe(false);
  });

  it("tenant origin + tenant business stays tenant", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: false,
        businessId: TENANT_ID,
        aiBusinessIds: [],
        originHost: "tenant.example.com",
      })
    ).toBe(false);
  });

  it("AI origin + tenant business stays tenant", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: false,
        businessId: TENANT_ID,
        aiBusinessIds: [],
        originHost: AI_HOST,
      })
    ).toBe(false);
  });

  it("aiBusinessIds membership on a non-AI origin stays tenant", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: false,
        businessId: COMPANY_ID,
        aiBusinessIds: [COMPANY_ID],
        originHost: MAIN_HOST,
      })
    ).toBe(false);
  });

  it("missing host never resolves portal, even for the company business", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: true,
        businessId: COMPANY_ID,
        aiBusinessIds: [COMPANY_ID],
        originHost: "",
      })
    ).toBe(false);
  });

  it("AI origin + company business with neither company signal stays tenant (live-flag dependency)", () => {
    expect(
      resolvePortalSurface({
        isInternalAccount: false,
        businessId: COMPANY_ID,
        aiBusinessIds: [],
        originHost: AI_HOST,
      })
    ).toBe(false);
  });
});

describe("origin host parsing (host only, never path/query)", () => {
  it("strips path and query from Origin/Referer values", () => {
    expect(
      originHostFromHeaderValue("https://ai.ridebangla.bd/some/page?x=1")
    ).toBe(AI_HOST);
  });

  it("returns empty for unparseable input, never a guess", () => {
    expect(originHostFromHeaderValue("not-a-url")).toBe("");
    expect(originHostFromHeaderValue(null)).toBe("");
    expect(originHostFromHeaderValue(undefined)).toBe("");
  });

  it("the portal host constant is exactly the AI site host", () => {
    expect(PORTAL_ORIGIN_HOST).toBe("ai.ridebangla.bd");
  });
});

describe("company-identity shape guard", () => {
  it("extracts string ids and drops non-strings", () => {
    expect(companyAiBusinessIds({ aiBusinessIds: [COMPANY_ID, 42, null] })).toEqual([
      COMPANY_ID,
    ]);
  });

  it("missing doc, missing field, or non-array field all yield []", () => {
    expect(companyAiBusinessIds(null)).toEqual([]);
    expect(companyAiBusinessIds(undefined)).toEqual([]);
    expect(companyAiBusinessIds({})).toEqual([]);
    expect(companyAiBusinessIds({ aiBusinessIds: "not-an-array" })).toEqual([]);
  });
});

describe("portal identity templates (no Main-business answers)", () => {
  it("portal identity displays the product name, not the business name", () => {
    const identity = resolveBusinessIdentity({
      businessName: "Ride Bangla",
      settingsName: "Ride Bangla",
      settingsExisted: true,
      businessDesc: "ride, food, courier, marketplace",
      knowledgeCount: 9,
      catalogCount: 3,
      portal: true,
    });
    expect(identity.mode).toBe("portal");
    expect(identity.displayName).toBe("Ride Bangla AI Agent");
  });

  it("portal 'who' answer is the product template, never the tenant template", () => {
    const identity = resolveBusinessIdentity({
      businessName: "Ride Bangla",
      settingsName: "Ride Bangla",
      settingsExisted: true,
      businessDesc: "ride, food, courier, marketplace",
      knowledgeCount: 9,
      catalogCount: 3,
      portal: true,
    });
    expect(answerIdentityQuestion("who", identity, "bn")).toBe(
      "আমি Ride Bangla AI Agent প্রোডাক্টের সহকারী।"
    );
  });

  it("tenant 'who' answer for the same business name is unchanged (the old screenshot answer shape)", () => {
    const identity = resolveBusinessIdentity({
      businessName: "Ride Bangla",
      settingsName: "Ride Bangla",
      settingsExisted: true,
      businessDesc: "ride, food, courier, marketplace",
      knowledgeCount: 9,
      catalogCount: 3,
      portal: false,
    });
    expect(identity.mode).toBe("tenant");
    expect(answerIdentityQuestion("who", identity, "bn")).toBe(
      "আমি Ride Bangla-এর সহকারী।"
    );
  });
});

describe("portal turn scope (what a portal turn may carry)", () => {
  it("carries no Main description, behaviour, rules, knowledge, or catalog", () => {
    expect(PORTAL_TURN_SCOPE.businessDesc).toBe("");
    expect(PORTAL_TURN_SCOPE.agentBehavior).toBe("");
    expect(PORTAL_TURN_SCOPE.businessRulesSection).toBe("");
    expect(PORTAL_TURN_SCOPE.knowledgeBase).toEqual([]);
    expect(PORTAL_TURN_SCOPE.catalogBrief).toBe("");
  });

  it("names exactly the public catalogue plans — nothing more", () => {
    expect([...PORTAL_PLAN_NAMES]).toEqual(["Starter", "Growth", "Pro"]);
  });
});
