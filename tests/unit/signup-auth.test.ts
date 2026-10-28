/**
 * signup-auth.test.ts — POST /api/auth/signup (email signup, re-audit #3
 * R3-ai-1: failure honesty).
 *
 * The route must:
 *   - validate input (400) and reject an already-used email (400),
 *   - create a Firebase user + trial business + tenant admin on success,
 *   - roll back the Firebase user on any failure after step 1,
 *   - answer a CAPACITY-class failure (Firestore RESOURCE_EXHAUSTED /
 *     UNAVAILABLE, gRPC codes 8/14, in any error shape the path throws)
 *     with an honest 503 "temporarily unavailable" — never the generic
 *     500 that retrying could never fix while the cause lasts,
 *   - keep truly unexpected failures on the generic 500.
 *
 * firebase-admin is faked in-memory; prisma uses the global test mocks
 * (tests/setup.ts), mirroring tests/unit/google-auth.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const createUser = vi.fn();
const deleteUser = vi.fn();

vi.mock("firebase-admin", () => ({
  apps: [] as unknown[],
  initializeApp: vi.fn(() => ({})),
  credential: { cert: vi.fn(() => ({})) },
  auth: vi.fn(() => ({ createUser, deleteUser })),
}));

import { POST } from "@/app/api/auth/signup/route";
import { isSignupCapacityError } from "@/lib/signup-capacity";
import { prisma } from "@/lib/prisma";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

let ipCounter = 200;
function post(body: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.99.1.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

const BODY = {
  email: "fresh@example.com",
  password: "s3cret-password",
  businessName: "Fresh Bakery",
};

beforeEach(() => {
  vi.clearAllMocks();
  createUser.mockResolvedValue({ uid: "fb-1" });
  db.admin.findMany.mockResolvedValue([]);
  db.business.findMany.mockResolvedValue([]);
  db.business.create.mockResolvedValue({ id: "b-new", name: "Fresh Bakery" });
  db.admin.create.mockResolvedValue({ id: "a-new", role: "admin" });
  db.settings.upsert.mockResolvedValue({});
  db.channel.upsert.mockResolvedValue({});
});

describe("POST /api/auth/signup", () => {
  it("creates a trial business + tenant admin on success", async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.businessId).toBe("b-new");
    const bizData = db.business.create.mock.calls[0][0].data;
    expect(bizData.plan).toBe("trial");
    expect(bizData.subscriptionStatus).toBe("trialing");
    expect(String(bizData.siteKey)).toMatch(/^rbsite-/);
    const adminData = db.admin.create.mock.calls[0][0].data;
    expect(adminData.role).toBe("admin");
    expect(adminData.role).not.toBe("super_admin");
    expect(adminData.firebaseUid).toBe("fb-1");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("rbai-token="))).toBe(true);
  });

  it("keeps validation errors on their correct codes", async () => {
    const badEmail = await POST(post({ ...BODY, email: "not-an-email" }));
    expect(badEmail.status).toBe(400);
    const shortPass = await POST(post({ ...BODY, password: "short" }));
    expect(shortPass.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("keeps an already-used email on 400, not 503/500", async () => {
    db.admin.findMany.mockResolvedValueOnce([{ id: "a-0", email: BODY.email }]);
    const res = await POST(post(BODY));
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("maps a Firebase email-already-exists error to 400", async () => {
    const err = new Error("already exists") as Error & { code: string };
    err.code = "auth/email-already-exists";
    createUser.mockRejectedValueOnce(err);
    const res = await POST(post(BODY));
    expect(res.status).toBe(400);
  });

  it("capacity error (gRPC code 8, numeric) → honest 503 + rollback", async () => {
    const err = new Error("RESOURCE_EXHAUSTED: quota exceeded") as Error & {
      code: number;
    };
    err.code = 8;
    db.business.create.mockRejectedValueOnce(err);
    const res = await POST(post(BODY));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(String(data.error)).toMatch(/temporarily unavailable/i);
    // Rollback behaviour preserved: the Firebase user is deleted.
    expect(deleteUser).toHaveBeenCalledWith("fb-1");
  });

  it("capacity error (gRPC code 14, UNAVAILABLE) → honest 503", async () => {
    const err = new Error("UNAVAILABLE: datastore unavailable") as Error & {
      code: number;
    };
    err.code = 14;
    db.admin.findMany.mockRejectedValueOnce(err);
    const res = await POST(post(BODY));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(String(data.error)).toMatch(/temporarily unavailable/i);
    // Nothing was created, so nothing to roll back.
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("capacity error (string code + quota message) → honest 503", async () => {
    const err = new Error("quota exceeded for project") as Error & {
      code: string;
    };
    err.code = "resource-exhausted";
    db.business.create.mockRejectedValueOnce(err);
    const res = await POST(post(BODY));
    expect(res.status).toBe(503);
  });

  it("truly unexpected errors stay on the generic 500", async () => {
    db.business.create.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(post(BODY));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Signup failed. Please try again.");
    expect(deleteUser).toHaveBeenCalledWith("fb-1");
  });
});

describe("isSignupCapacityError", () => {
  it("recognises every capacity shape and rejects the rest", () => {
    const withCode = (code: unknown, message = "x") => {
      const e = new Error(message) as Error & { code: unknown };
      e.code = code;
      return e;
    };
    expect(isSignupCapacityError(withCode(8, "RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isSignupCapacityError(withCode("8"))).toBe(true);
    expect(isSignupCapacityError(withCode(14, "UNAVAILABLE"))).toBe(true);
    expect(isSignupCapacityError(withCode("14"))).toBe(true);
    expect(isSignupCapacityError(withCode("unavailable"))).toBe(true);
    expect(isSignupCapacityError(withCode("resource-exhausted"))).toBe(true);
    expect(isSignupCapacityError(new Error("quota exceeded"))).toBe(true);
    expect(isSignupCapacityError(new Error("UNAVAILABLE: store down"))).toBe(true);
    expect(isSignupCapacityError(new Error("boom"))).toBe(false);
    expect(isSignupCapacityError(withCode("auth/internal-error"))).toBe(false);
    expect(isSignupCapacityError(null)).toBe(false);
  });
});
