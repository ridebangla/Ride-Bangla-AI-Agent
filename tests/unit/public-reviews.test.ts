/**
 * public-reviews.test.ts — GET/POST /api/public/reviews +
 * GET /api/public/firebase-config.
 *
 * Public reviews over the same siteKey auth model as /api/public/ai/generate:
 *   - siteKey must resolve to a real business (401 otherwise),
 *   - GET returns published-only aggregates (average 1-decimal, count, max 20),
 *   - POST verifies the Firebase ID token (Admin SDK), validates input,
 *     enforces 1 review / uid / site / 24h, and stores in `site_reviews`.
 *   - firebase-config serves the backend's own public NEXT_PUBLIC_FIREBASE_*
 *     values ONLY to requests carrying a valid siteKey.
 *
 * firebase-admin is faked in-memory; prisma uses the global test mocks.
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

import { GET as reviewsGET, POST as reviewsPOST } from "@/app/api/public/reviews/route";
import { GET as configGET } from "@/app/api/public/firebase-config/route";
import { prisma } from "@/lib/prisma";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

const KEY = "rbsite-test-key";

let ipCounter = 200;
function nextIp() {
  ipCounter += 1;
  return `192.0.2.${ipCounter % 250}`;
}

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "GET",
    headers: { "x-forwarded-for": nextIp() },
  });
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/public/reviews", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": nextIp(),
    },
    body: JSON.stringify(body),
  });
}

const REVIEW_1 = {
  id: "r1",
  site: "ai",
  uid: "u2",
  name: "Karim",
  photoURL: "",
  rating: 5,
  text: "Instant replies, day and night.",
  status: "published",
  createdAt: new Date("2026-10-19T10:00:00Z"),
};
const REVIEW_2 = {
  ...REVIEW_1,
  id: "r2",
  uid: "u3",
  name: "Sadia",
  rating: 4,
  text: "Very helpful for our page customers.",
  createdAt: new Date("2026-10-18T10:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "AIza" + "TestKey000";
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "test-project.firebaseapp.com";
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "test-project";
  db.business.findUnique.mockImplementation(async (args: { where?: { siteKey?: string } }) =>
    args?.where?.siteKey === KEY
      ? { id: "test-business", name: "Ride Bangla" }
      : null
  );
  db.siteReview.findMany.mockResolvedValue([]);
  db.siteReview.findFirst.mockResolvedValue(null);
  db.siteReview.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "r-new",
    ...args.data,
  }));
  verifyIdToken.mockResolvedValue({
    uid: "user-1",
    email: "user@example.com",
    name: "Real User",
    picture: "https://example.com/p.png",
  });
});

describe("GET /api/public/reviews", () => {
  it("rejects an unknown site with 400", async () => {
    const res = await reviewsGET(get(`/api/public/reviews?site=blog&siteKey=${KEY}`));
    expect(res.status).toBe(400);
  });

  it("rejects a bad site key with 401", async () => {
    const res = await reviewsGET(get(`/api/public/reviews?site=ai&siteKey=wrong`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("returns an honest empty state when there are no reviews", async () => {
    const res = await reviewsGET(get(`/api/public/reviews?site=ai&siteKey=${KEY}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, average: 0, count: 0, reviews: [] });
  });

  it("computes the average (1 decimal) and count over published reviews", async () => {
    db.siteReview.findMany.mockResolvedValue([REVIEW_1, REVIEW_2]);
    const res = await reviewsGET(get(`/api/public/reviews?site=ai&siteKey=${KEY}`));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.average).toBe(4.5);
    expect(body.count).toBe(2);
    expect(body.reviews).toHaveLength(2);
    expect(body.reviews[0]).toMatchObject({ name: "Karim", rating: 5 });
    // The query itself must filter to published only.
    const where = db.siteReview.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ site: "ai", status: "published" });
  });
});

describe("POST /api/public/reviews", () => {
  const base = { siteKey: KEY, site: "ai", idToken: "tok", rating: 5, text: "Great support!" };

  it("rejects a bad site key with 401", async () => {
    const res = await reviewsPOST(post({ ...base, siteKey: "nope" }));
    expect(res.status).toBe(401);
    expect(db.siteReview.create).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable sign-in token with 401", async () => {
    verifyIdToken.mockRejectedValueOnce(new Error("bad token"));
    const res = await reviewsPOST(post(base));
    expect(res.status).toBe(401);
    expect(db.siteReview.create).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range rating with 400", async () => {
    const res = await reviewsPOST(post({ ...base, rating: 9 }));
    expect(res.status).toBe(400);
    expect(db.siteReview.create).not.toHaveBeenCalled();
  });

  it("rejects empty review text with 400", async () => {
    const res = await reviewsPOST(post({ ...base, text: "   " }));
    expect(res.status).toBe(400);
    expect(db.siteReview.create).not.toHaveBeenCalled();
  });

  it("stores a published review for a verified user", async () => {
    const res = await reviewsPOST(post(base));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(db.siteReview.create).toHaveBeenCalledTimes(1);
    const data = db.siteReview.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      site: "ai",
      uid: "user-1",
      name: "Real User",
      rating: 5,
      text: "Great support!",
      status: "published",
    });
  });

  it("honours an editable display name", async () => {
    const res = await reviewsPOST(post({ ...base, name: "My Shop BD" }));
    expect(res.status).toBe(200);
    const data = db.siteReview.create.mock.calls[0][0].data;
    expect(data.name).toBe("My Shop BD");
  });

  it("blocks a second review from the same uid within 24h (429)", async () => {
    db.siteReview.findFirst.mockResolvedValue({
      ...REVIEW_1,
      uid: "user-1",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const res = await reviewsPOST(post(base));
    expect(res.status).toBe(429);
    expect(db.siteReview.create).not.toHaveBeenCalled();
  });

  it("allows a review once 24h have passed", async () => {
    db.siteReview.findFirst.mockResolvedValue({
      ...REVIEW_1,
      uid: "user-1",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const res = await reviewsPOST(post(base));
    expect(res.status).toBe(200);
    expect(db.siteReview.create).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/public/firebase-config", () => {
  it("refuses requests without a valid site key", async () => {
    const res = await configGET(get(`/api/public/firebase-config?siteKey=wrong`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.apiKey).toBeUndefined();
  });

  it("serves the backend's public Firebase identifiers to a valid site key", async () => {
    const res = await configGET(get(`/api/public/firebase-config?siteKey=${KEY}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      apiKey: "AIza" + "TestKey000",
      authDomain: "test-project.firebaseapp.com",
      projectId: "test-project",
    });
  });
});

describe("photo + Google-verification contract", () => {
  it("GET surfaces photoURL and verifiedGoogle only from stored proof", async () => {
    const googleReview = {
      ...REVIEW_1,
      photoURL: "https://example.com/karim.png",
      verifiedGoogle: true,
    };
    // Legacy record: neither field was ever captured — the API must
    // report verifiedGoogle: false and photoURL: "" (never fabricated).
    const legacyReview = { ...REVIEW_2 } as Record<string, unknown>;
    delete legacyReview.photoURL;
    delete legacyReview.verifiedGoogle;
    db.siteReview.findMany.mockResolvedValue([googleReview, legacyReview]);
    const res = await reviewsGET(get(`/api/public/reviews?site=ai&siteKey=${KEY}`));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reviews[0]).toMatchObject({
      name: "Karim",
      photoURL: "https://example.com/karim.png",
      verifiedGoogle: true,
    });
    expect(body.reviews[1]).toMatchObject({ photoURL: "", verifiedGoogle: false });
  });

  it("POST stores verifiedGoogle=true + photo for a Google-claim token", async () => {
    verifyIdToken.mockResolvedValue({
      uid: "google-user",
      email: "g@example.com",
      name: "Google User",
      picture: "https://example.com/g.png",
      firebase: { sign_in_provider: "google.com" },
    });
    const res = await reviewsPOST(
      post({ siteKey: KEY, site: "ai", idToken: "tok", rating: 5, text: "Loved it!" })
    );
    expect(res.status).toBe(200);
    const data = db.siteReview.create.mock.calls[0][0].data;
    expect(data.verifiedGoogle).toBe(true);
    expect(data.photoURL).toBe("https://example.com/g.png");
  });

  it("POST stores verifiedGoogle=false when the token has no Google claim", async () => {
    const res = await reviewsPOST(
      post({ siteKey: KEY, site: "ai", idToken: "tok", rating: 4, text: "Good." })
    );
    expect(res.status).toBe(200);
    const data = db.siteReview.create.mock.calls[0][0].data;
    expect(data.verifiedGoogle).toBe(false);
  });
});
