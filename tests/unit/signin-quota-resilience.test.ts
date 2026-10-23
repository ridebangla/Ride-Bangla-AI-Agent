/**
 * signin-quota-resilience.test.ts — Q-SIGNIN (owner order 2026-10-23).
 *
 * The defect: with Firestore quota-exhausted (RESOURCE_EXHAUSTED), the
 * owner hit "Sign-in is temporarily unavailable" at ai.ridebangla.bd —
 * EVERY Firestore read on the sign-in path gated the session, and the
 * first dashboard load 500-ed on its revocation/admin/subscription
 * reads even after a session was minted.
 *
 * The fix under test (simulated quota-down drive: the data layer is
 * stubbed to throw RESOURCE_EXHAUSTED):
 *  - the admins-by-email resolution is the ONE indispensable gating
 *    read; with nothing remembered it still answers the honest 503;
 *  - with a PROVEN resolution remembered for the same (email, uid),
 *    sign-in COMPLETES in degraded mode (same id/role, degraded flag);
 *  - a different uid / never-proven account gains NOTHING from the
 *    fallback (fail-closed for privileges, fail-open only for entry);
 *  - GET /api/auth degrades to a 200 instead of throwing;
 *  - /api/auth/restore preserves the cookie pair on a quota failure
 *    (the 30-day chain survives the outage) instead of clearing it;
 *  - entry session verification falls back to signature-only ONLY when
 *    the revocation read throws, and reports degraded — a definitively
 *    revoked token still resolves to no session;
 *  - isSetupComplete is a cached existence probe, not a full scan.
 *
 * firebase-admin is faked in-memory; prisma uses the global test mocks
 * (tests/setup.ts) — the same pattern as owner-direct-entry.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const verifyIdToken = vi.fn();

vi.mock("firebase-admin", () => ({
  apps: [] as unknown[],
  initializeApp: vi.fn(() => ({})),
  credential: { cert: vi.fn(() => ({})) },
  auth: vi.fn(() => ({ verifyIdToken })),
}));

import { POST as firebasePOST } from "@/app/api/auth/firebase/route";
import { POST as googlePOST } from "@/app/api/auth/google/route";
import { GET as authGET } from "@/app/api/auth/route";
import { GET as restoreGET } from "@/app/api/auth/restore/route";
import {
  generateRefreshToken,
  generateToken,
  isDatastoreQuotaError,
  isSetupComplete,
  verifySessionTokenForEntry,
  __resetSetupCompleteCacheForTests,
} from "@/lib/auth";
import {
  __resetSignInResolutionMemoryForTests,
} from "@/lib/admin-resolution";
import { pickEqualityPrefilter } from "@/lib/firestore-query";
import { prisma } from "@/lib/prisma";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

const QUOTA = () =>
  Object.assign(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded."), {
    code: 8,
  });

const SIGNIN_503_COPY =
  "Sign-in is temporarily unavailable. Please try again later.";

let ipCounter = 300;
function post(path: string, body: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.97.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

function pageRequest(
  path: string,
  cookies: Record<string, string> = {}
): NextRequest {
  const request = new NextRequest(new URL(path, "http://localhost:3000"));
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

const ADMIN_ROW = {
  id: "a-quota",
  email: "quota@example.com",
  name: "Quota Tester",
  role: "admin",
  businessId: "biz-quota",
  createdAt: new Date("2025-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetSignInResolutionMemoryForTests();
  __resetSetupCompleteCacheForTests();
  db.admin.findMany.mockResolvedValue([]);
  db.business.findUnique.mockResolvedValue(null);
  db.business.findMany.mockResolvedValue([]);
  db.admin.create.mockResolvedValue({ id: "a-new", role: "super_admin" });
  db.revokedToken.findUnique.mockResolvedValue(null);
  db.revokedToken.upsert.mockResolvedValue({});
});

describe("quota error detection", () => {
  it("recognises the Firestore quota wall and nothing else", () => {
    expect(isDatastoreQuotaError(QUOTA())).toBe(true);
    expect(
      isDatastoreQuotaError(new Error("RESOURCE_EXHAUSTED: Quota exceeded."))
    ).toBe(true);
    expect(isDatastoreQuotaError(new Error("permission denied"))).toBe(false);
    expect(isDatastoreQuotaError(null)).toBe(false);
  });
});

describe("POST /api/auth/firebase — quota-down drive", () => {
  it("indispensable read down + nothing remembered -> honest 503, exact copy", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "u-quota",
      email: "quota@example.com",
      firebase: { sign_in_provider: "password" },
    });
    db.admin.findMany.mockRejectedValueOnce(QUOTA());
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe(SIGNIN_503_COPY);
    expect(db.admin.create).not.toHaveBeenCalled();
  });

  it("proven resolution remembered -> sign-in COMPLETES degraded on quota", async () => {
    // Prime: a healthy sign-in proves the resolution against the DB.
    verifyIdToken.mockResolvedValueOnce({
      uid: "u-quota",
      email: "quota@example.com",
      firebase: { sign_in_provider: "password" },
    });
    db.admin.findMany.mockResolvedValueOnce([ADMIN_ROW]);
    const prime = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(prime.status).toBe(200);
    expect((await prime.json()).degraded).toBeUndefined();

    // Quota wall: the same (email, uid) now signs in degraded — same
    // id and role as proven, session cookies issued, flagged honestly.
    verifyIdToken.mockResolvedValueOnce({
      uid: "u-quota",
      email: "quota@example.com",
      firebase: { sign_in_provider: "password" },
    });
    db.admin.findMany.mockRejectedValueOnce(QUOTA());
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.degraded).toBe(true);
    expect(data.user.id).toBe("a-quota");
    expect(data.user.role).toBe("admin");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("rbai-token="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("rbai-refresh="))).toBe(true);
  });

  it("a DIFFERENT uid gains nothing from another uid's remembered resolution", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "u-quota",
      email: "quota@example.com",
      firebase: { sign_in_provider: "password" },
    });
    db.admin.findMany.mockResolvedValueOnce([ADMIN_ROW]);
    const prime = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(prime.status).toBe(200);

    verifyIdToken.mockResolvedValueOnce({
      uid: "u-someone-else",
      email: "quota@example.com",
      firebase: { sign_in_provider: "password" },
    });
    db.admin.findMany.mockRejectedValueOnce(QUOTA());
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe(SIGNIN_503_COPY);
  });

  it("non-quota data failures keep the generic 500 (not the quota copy)", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "u-quota",
      email: "quota@example.com",
      firebase: { sign_in_provider: "password" },
    });
    db.admin.findMany.mockRejectedValueOnce(new Error("connection reset"));
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Sign-in failed. Please try again.");
  });
});

describe("POST /api/auth/google — quota-down drive", () => {
  it("returning-account resolution down + nothing remembered -> honest 503 sign-in copy", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "g-quota",
      email: "gquota@example.com",
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });
    db.admin.findMany.mockRejectedValueOnce(QUOTA());
    const res = await googlePOST(post("/api/auth/google", { idToken: "tok" }));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe(SIGNIN_503_COPY);
    expect(db.admin.create).not.toHaveBeenCalled();
    expect(db.business.create).not.toHaveBeenCalled();
  });

  it("proven Google resolution remembered -> returning sign-in completes degraded", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "g-quota",
      email: "gquota@example.com",
      email_verified: true,
      name: "G Quota",
      firebase: { sign_in_provider: "google.com" },
    });
    db.admin.findMany.mockResolvedValueOnce([
      { ...ADMIN_ROW, id: "a-gquota", email: "gquota@example.com" },
    ]);
    const prime = await googlePOST(post("/api/auth/google", { idToken: "tok" }));
    expect(prime.status).toBe(200);
    expect((await prime.json()).isNew).toBe(false);

    verifyIdToken.mockResolvedValueOnce({
      uid: "g-quota",
      email: "gquota@example.com",
      email_verified: true,
      name: "G Quota",
      firebase: { sign_in_provider: "google.com" },
    });
    db.admin.findMany.mockRejectedValueOnce(QUOTA());
    const res = await googlePOST(post("/api/auth/google", { idToken: "tok" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isNew).toBe(false);
    expect(data.degraded).toBe(true);
    expect(db.business.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth — quota-down drive", () => {
  it("setup probe down -> 200 degraded, never a throw, entry not blocked", async () => {
    db.admin.findFirst.mockRejectedValueOnce(QUOTA());
    const res = await authGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authenticated).toBe(false);
    expect(data.setupRequired).toBe(false);
    expect(data.degraded).toBe(true);
  });
});

describe("GET /api/auth/restore — quota failure preserves the session chain", () => {
  it("revocation read quota-down -> /login WITHOUT clearing the cookies", async () => {
    db.revokedToken.findUnique.mockRejectedValue(QUOTA());
    const refresh = generateRefreshToken("admin-1", "admin");
    const res = await restoreGET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/login");
    const cookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    // No cookie is cleared: the 30-day chain survives the outage.
    expect(
      cookies.some(
        (c) => c.startsWith("rbai-token=") && c.includes("Max-Age=0")
      )
    ).toBe(false);
    expect(
      cookies.some(
        (c) => c.startsWith("rbai-refresh=") && c.includes("Max-Age=0")
      )
    ).toBe(false);
    expect(db.revokedToken.upsert).not.toHaveBeenCalled();
  });
});

describe("verifySessionTokenForEntry — degraded only on read failure", () => {
  it("healthy revocation read -> payload, not degraded", async () => {
    const token = generateToken("admin-1", "admin");
    const out = await verifySessionTokenForEntry(token);
    expect(out.payload?.userId).toBe("admin-1");
    expect(out.degraded).toBe(false);
  });

  it("revocation read quota-down -> signature-only payload, degraded", async () => {
    db.revokedToken.findUnique.mockRejectedValueOnce(QUOTA());
    const token = generateToken("admin-1", "admin");
    const out = await verifySessionTokenForEntry(token);
    expect(out.payload?.userId).toBe("admin-1");
    expect(out.payload?.role).toBe("admin");
    expect(out.degraded).toBe(true);
  });

  it("definitively REVOKED token -> no payload, not degraded (fail-closed)", async () => {
    db.revokedToken.findUnique.mockResolvedValue({ jti: "revoked" });
    const token = generateToken("admin-1", "admin");
    const out = await verifySessionTokenForEntry(token);
    expect(out.payload).toBeNull();
    expect(out.degraded).toBe(false);
  });

  it("a refresh token never passes the entry check, even degraded", async () => {
    db.revokedToken.findUnique.mockRejectedValueOnce(QUOTA());
    const refresh = generateRefreshToken("admin-1", "admin");
    const out = await verifySessionTokenForEntry(refresh);
    expect(out.payload).toBeNull();
  });
});

describe("isSetupComplete — cached existence probe", () => {
  it("positive answer is cached for the process lifetime", async () => {
    db.admin.findFirst.mockResolvedValue({ id: "a-1" });
    expect(await isSetupComplete()).toBe(true);
    db.admin.findFirst.mockRejectedValue(QUOTA());
    // Cached positive is served even while the store is down.
    expect(await isSetupComplete()).toBe(true);
  });

  it("with no cached answer, a quota failure propagates for the caller to degrade", async () => {
    db.admin.findFirst.mockRejectedValue(QUOTA());
    await expect(isSetupComplete()).rejects.toThrow(/RESOURCE_EXHAUSTED/);
  });

  it("fresh:true bypasses the cache (the setup endpoint's takeover guard)", async () => {
    db.admin.findFirst.mockResolvedValue({ id: "a-1" });
    expect(await isSetupComplete()).toBe(true);
    db.admin.findFirst.mockResolvedValue(null);
    expect(await isSetupComplete({ fresh: true })).toBe(false);
  });
});

describe("pickEqualityPrefilter — server-side prefilter selection", () => {
  it("picks a plain scalar equality (the admins-by-email case)", () => {
    expect(pickEqualityPrefilter({ email: "a@b.co" }, ["id", "businessId"])).toEqual({
      field: "email",
      value: "a@b.co",
    });
  });

  it("picks the jti equality (the revoked-token case)", () => {
    expect(pickEqualityPrefilter({ jti: "abc" }, ["id", "businessId"])).toEqual({
      field: "jti",
      value: "abc",
    });
  });

  it("searches AND-nested clauses (tenant-scoped wheres)", () => {
    const where = { AND: [{ slug: "my-shop" }, { businessId: "b-1" }] };
    expect(pickEqualityPrefilter(where, ["id", "businessId"])).toEqual({
      field: "slug",
      value: "my-shop",
    });
  });

  it("never prefilters on null, patterns, or ranges (result-set safety)", () => {
    expect(pickEqualityPrefilter({ customerId: null }, ["id"])).toBeNull();
    expect(pickEqualityPrefilter({ name: { contains: "x" } }, ["id"])).toBeNull();
    expect(pickEqualityPrefilter({ createdAt: { gte: new Date() } }, ["id"])).toBeNull();
    expect(pickEqualityPrefilter({}, ["id"])).toBeNull();
    expect(pickEqualityPrefilter(undefined, ["id"])).toBeNull();
  });

  it("honours an { equals } operator object", () => {
    expect(
      pickEqualityPrefilter({ status: { equals: "active" } }, ["id"])
    ).toEqual({ field: "status", value: "active" });
  });
});
