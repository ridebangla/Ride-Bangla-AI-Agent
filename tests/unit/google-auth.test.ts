/**
 * google-auth.test.ts — POST /api/auth/google (Google one-tap signup/sign-in).
 *
 * Done-for-you model: the customer never fills a form or sees an API key.
 * The route must:
 *   - require a valid Firebase ID token (400/401/403 on bad input),
 *   - sign in existing accounts without touching data,
 *   - create a tenant account + trial business for new emails and sign
 *     them straight in,
 *   - NEVER mint a super_admin from the SaaS path.
 *
 * firebase-admin is faked in-memory; prisma + route-auth use the global
 * test mocks (tests/setup.ts).
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

import { POST } from "@/app/api/auth/google/route";
import { prisma } from "@/lib/prisma";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<
  string,
  Record<string, MockFn>
>;

let ipCounter = 100;
function post(body: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest("http://localhost/api/auth/google", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.99.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

const TOKEN = "google-id-token";

beforeEach(() => {
  vi.clearAllMocks();
  db.admin.findMany.mockResolvedValue([]);
  db.business.findMany.mockResolvedValue([]);
  db.business.create.mockResolvedValue({ id: "b-new", name: "New Shop" });
  db.admin.create.mockResolvedValue({ id: "a-new", role: "admin" });
  db.settings.upsert.mockResolvedValue({});
  db.channel.upsert.mockResolvedValue({});
});

describe("POST /api/auth/google", () => {
  it("rejects a missing token with 400", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid token with 401", async () => {
    verifyIdToken.mockRejectedValueOnce(new Error("bad token"));
    const res = await POST(post({ idToken: TOKEN }));
    expect(res.status).toBe(401);
    expect(db.admin.create).not.toHaveBeenCalled();
  });

  it("rejects an unverified Google email with 403", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "g1",
      email: "new@example.com",
      email_verified: false,
      name: "New Shop",
    });
    const res = await POST(post({ idToken: TOKEN }));
    expect(res.status).toBe(403);
    expect(db.admin.create).not.toHaveBeenCalled();
  });

  it("signs in an existing account without creating anything", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "g1",
      email: "known@example.com",
      email_verified: true,
      name: "Known Shop",
    });
    db.admin.findMany.mockResolvedValueOnce([
      { id: "a-1", email: "known@example.com", name: "Known Shop", role: "admin" },
    ]);
    const res = await POST(post({ idToken: TOKEN }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.isNew).toBe(false);
    expect(db.business.create).not.toHaveBeenCalled();
    expect(db.admin.create).not.toHaveBeenCalled();
    // Session cookies are issued on both paths.
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("rbai-token="))).toBe(true);
  });

  it("creates a tenant account + trial business for a new email", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "g9",
      email: "fresh@example.com",
      email_verified: true,
      name: "Fresh Bakery",
    });
    const res = await POST(post({ idToken: TOKEN }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.isNew).toBe(true);

    // Business created on a trial with a site key.
    const bizData = db.business.create.mock.calls[0][0].data;
    expect(bizData.plan).toBe("trial");
    expect(bizData.subscriptionStatus).toBe("trialing");
    expect(String(bizData.siteKey)).toMatch(/^rbsite-/);

    // Tenant admin created — NEVER a super_admin.
    const adminData = db.admin.create.mock.calls[0][0].data;
    expect(adminData.role).toBe("admin");
    expect(adminData.role).not.toBe("super_admin");
    expect(adminData.businessId).toBe("b-new");
    expect(adminData.firebaseUid).toBe("g9");

    // Baseline channels seeded for the new tenant.
    expect(db.channel.upsert).toHaveBeenCalledTimes(3);

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("rbai-token="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("rbai-refresh="))).toBe(true);
  });

  it("derives a friendly business name from the email when the profile has none", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "g7",
      email: "cozy.cafe@example.com",
      email_verified: true,
    });
    await POST(post({ idToken: TOKEN }));
    const bizData = db.business.create.mock.calls[0][0].data;
    expect(bizData.name).toBe("Cozy Cafe");
  });
});
