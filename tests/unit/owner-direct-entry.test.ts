/**
 * owner-direct-entry.test.ts — holder-account direct entry (owner rule
 * 2026-10-21) for BOTH AI sign-in routes.
 *
 * The company's holder account (info@ridebangla.bd) exists as multiple
 * admin records sharing one email: the platform Super Admin record and
 * the tenant admin of the INTERNAL "Ride Bangla" business. The routes
 * must resolve a verified sign-in to the ONE right record —
 * deterministically (firebaseUid → internal business → earliest) — so:
 *   - password sign-in (via /api/auth/firebase) lands the owner on his
 *     business with the account's real password, no verification wall;
 *   - Google sign-in lands on the SAME business — never a duplicate
 *     business, never a fresh trial, never onboarding;
 *   - the google route's email-verification wall is short-circuited for
 *     the INTERNAL account only, and by nothing else;
 *   - every customer path behaves exactly as before.
 *
 * firebase-admin is faked in-memory; prisma uses the global test mocks
 * (tests/setup.ts) — the same pattern as google-auth.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

const verifyIdToken = vi.fn();

vi.mock("firebase-admin", () => ({
  apps: [] as unknown[],
  initializeApp: vi.fn(() => ({})),
  credential: { cert: vi.fn(() => ({})) },
  auth: vi.fn(() => ({ verifyIdToken })),
}));

import { POST as googlePOST } from "@/app/api/auth/google/route";
import { POST as firebasePOST } from "@/app/api/auth/firebase/route";
import { prisma } from "@/lib/prisma";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

const OWNER_EMAIL = "info@ridebangla.bd";
const OWNER_BIZ = "biz-ride-bangla";
const T_EARLY = new Date("2025-01-01T00:00:00Z");
const T_LATE = new Date("2025-06-01T00:00:00Z");

/** Platform Super Admin record — same email, no business. */
const superAdminRecord = {
  id: "a-super",
  email: OWNER_EMAIL,
  name: "MD Enamul Seddik",
  role: "super_admin",
  businessId: null,
  createdAt: T_EARLY,
};
/** Tenant admin of the internal Ride Bangla business — same email. */
const ownerTenantRecord = {
  id: "a-owner",
  email: OWNER_EMAIL,
  name: "Ride Bangla",
  role: "admin",
  businessId: OWNER_BIZ,
  firebaseUid: "uid-owner-original",
  createdAt: T_LATE,
};

let ipCounter = 200;
function post(path: string, body: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.98.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

function sessionUserId(res: Response): string | null {
  const cookies = res.headers.getSetCookie();
  const raw = cookies.find((c) => c.startsWith("rbai-token="));
  if (!raw) return null;
  const token = raw.split(";")[0].slice("rbai-token=".length);
  const payload = jwt.decode(token) as { userId?: string } | null;
  return payload?.userId ?? null;
}

function seedOwnerWorld(internalFlag: unknown = true) {
  db.admin.findMany.mockImplementation(
    async (args: { where?: { email?: string } }) => {
      const email = args?.where?.email;
      if (email === OWNER_EMAIL) return [superAdminRecord, ownerTenantRecord];
      if (!email) return [superAdminRecord, ownerTenantRecord];
      return [];
    }
  );
  db.business.findUnique.mockImplementation(
    async (args: { where?: { id?: string } }) =>
      args?.where?.id === OWNER_BIZ
        ? { id: OWNER_BIZ, name: "Ride Bangla", isInternalAccount: internalFlag }
        : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.admin.findMany.mockResolvedValue([]);
  db.business.findMany.mockResolvedValue([]);
  db.business.create.mockResolvedValue({ id: "b-new", name: "New Shop" });
  db.admin.create.mockResolvedValue({ id: "a-new", role: "admin" });
  db.settings.upsert.mockResolvedValue({});
  db.channel.upsert.mockResolvedValue({});
});

describe("POST /api/auth/google — owner resolution", () => {
  it("verified Google, uid matches the tenant record → lands on the owner business admin", async () => {
    seedOwnerWorld();
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-owner-original",
      email: OWNER_EMAIL,
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await googlePOST(
      post("/api/auth/google", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isNew).toBe(false);
    expect(sessionUserId(res)).toBe("a-owner");
    expect(db.business.create).not.toHaveBeenCalled();
    expect(db.admin.create).not.toHaveBeenCalled();
  });

  it("verified Google with a DIFFERENT uid still lands on the SAME business — no duplicate, no trial", async () => {
    seedOwnerWorld();
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-google-brand-new",
      email: OWNER_EMAIL,
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await googlePOST(
      post("/api/auth/google", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isNew).toBe(false);
    expect(sessionUserId(res)).toBe("a-owner");
    expect(db.business.create).not.toHaveBeenCalled();
    expect(db.admin.create).not.toHaveBeenCalled();
  });

  it("UNVERIFIED Google token for the holder email → direct entry via the internal exception", async () => {
    seedOwnerWorld();
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-google-brand-new",
      email: OWNER_EMAIL,
      email_verified: false,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await googlePOST(
      post("/api/auth/google", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    expect(sessionUserId(res)).toBe("a-owner");
    expect(db.business.create).not.toHaveBeenCalled();
  });

  it("SPOOF: internal flag as the STRING 'true' does not trigger the exception — unverified stays walled", async () => {
    seedOwnerWorld("true");
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-google-brand-new",
      email: OWNER_EMAIL,
      email_verified: false,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await googlePOST(
      post("/api/auth/google", { idToken: "tok" })
    );
    expect(res.status).toBe(403);
    expect(sessionUserId(res)).toBeNull();
    expect(db.business.create).not.toHaveBeenCalled();
    expect(db.admin.create).not.toHaveBeenCalled();
  });

  it("SPOOF: unverified token WITHOUT the google.com provider gets no exception", async () => {
    seedOwnerWorld();
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-claimant",
      email: OWNER_EMAIL,
      email_verified: false,
      firebase: { sign_in_provider: "password" },
    });
    const res = await googlePOST(
      post("/api/auth/google", { idToken: "tok" })
    );
    expect(res.status).toBe(403);
    expect(sessionUserId(res)).toBeNull();
  });
});

describe("POST /api/auth/google — customers unchanged", () => {
  it("unverified Google email for a normal CUSTOMER account is still rejected 403", async () => {
    db.admin.findMany.mockResolvedValue([
      {
        id: "a-cust",
        email: "customer@example.com",
        name: "Customer",
        role: "admin",
        businessId: "biz-cust",
        createdAt: T_EARLY,
      },
    ]);
    db.business.findUnique.mockResolvedValue({
      id: "biz-cust",
      isInternalAccount: false,
    });
    verifyIdToken.mockResolvedValueOnce({
      uid: "g-cust",
      email: "customer@example.com",
      email_verified: false,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await googlePOST(
      post("/api/auth/google", { idToken: "tok" })
    );
    expect(res.status).toBe(403);
    expect(sessionUserId(res)).toBeNull();
    expect(db.business.create).not.toHaveBeenCalled();
  });

  it("verified Google for a normal customer signs into their single account as before", async () => {
    db.admin.findMany.mockResolvedValue([
      {
        id: "a-cust",
        email: "customer@example.com",
        name: "Customer",
        role: "admin",
        businessId: "biz-cust",
        createdAt: T_EARLY,
      },
    ]);
    verifyIdToken.mockResolvedValueOnce({
      uid: "g-cust",
      email: "customer@example.com",
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await googlePOST(
      post("/api/auth/google", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    expect(sessionUserId(res)).toBe("a-cust");
    expect(db.business.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/firebase — password + login-page Google", () => {
  it("password sign-in (uid bound to the tenant record) lands the owner on his business — no verification wall", async () => {
    seedOwnerWorld();
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-owner-original",
      email: OWNER_EMAIL,
      email_verified: false,
      firebase: { sign_in_provider: "password" },
    });
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.id).toBe("a-owner");
    expect(data.user.role).toBe("admin");
  });

  it("Google via the login page (different uid) resolves to the same owner business record", async () => {
    seedOwnerWorld();
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-google-other",
      email: OWNER_EMAIL,
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.id).toBe("a-owner");
  });

  it("unknown email stays fail-closed 403 when other admins exist", async () => {
    seedOwnerWorld();
    db.admin.findMany.mockImplementation(
      async (args: { where?: { email?: string } }) =>
        args?.where?.email === "stranger@example.com"
          ? []
          : [superAdminRecord, ownerTenantRecord]
    );
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-stranger",
      email: "stranger@example.com",
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(403);
    expect(db.admin.create).not.toHaveBeenCalled();
  });

  it("a normal single-record customer lands on their own record", async () => {
    db.admin.findMany.mockResolvedValue([
      {
        id: "a-cust",
        email: "customer@example.com",
        name: "Customer",
        role: "admin",
        businessId: "biz-cust",
        createdAt: T_EARLY,
      },
    ]);
    verifyIdToken.mockResolvedValueOnce({
      uid: "uid-cust",
      email: "customer@example.com",
      email_verified: false,
      firebase: { sign_in_provider: "password" },
    });
    const res = await firebasePOST(
      post("/api/auth/firebase", { idToken: "tok" })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.id).toBe("a-cust");
  });
});
