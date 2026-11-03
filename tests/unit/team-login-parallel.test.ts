/**
 * team-login-parallel.test.ts — TEAM LOGIN task B (AI completion).
 *
 * The sign-in critical path had two provably sequential DB windows that
 * are now parallel, with outcomes preserved:
 *
 *  1. Dashboard layout (src/app/(dashboard)/layout.tsx): getSubscription,
 *     getBillingCountdown and getLimitExhaustedState all key off
 *     businessId only, so they now run in ONE Promise.allSettled window
 *     instead of (subscription) then (countdown, limit). The
 *     subscription GATE is untouched: only a definitive inactive answer
 *     redirects to /billing, and a throwing subscription still degrades
 *     (discarding the other two results) instead of redirecting.
 *  2. Restore route (src/app/api/auth/restore/route.ts): the revocation
 *     check and the admin lookup now run in one window (the admin id
 *     comes from the token's own signature, decoded locally). A revoked
 *     token still lands on /login, a quota failure still preserves the
 *     cookie pair, and rotation/revocation/expiry checks are untouched.
 *
 * What is deliberately NOT changed (and therefore not tested here):
 * token lifetimes, refresh rotation, revocation enforcement, and the
 * error shapes (quota 503 on sign-in, 400 on bad credentials) — those
 * behaviours are covered by the existing signin-quota-resilience tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const billingMocks = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  getBillingCountdown: vi.fn(),
  getLimitExhaustedState: vi.fn(),
  getCatalogView: vi.fn(),
}));

vi.mock("@/lib/subscription", () => ({
  getSubscription: billingMocks.getSubscription,
}));
vi.mock("@/lib/billing-usage", () => ({
  getBillingCountdown: billingMocks.getBillingCountdown,
  getLimitExhaustedState: billingMocks.getLimitExhaustedState,
}));
vi.mock("@/lib/plan-catalog", () => ({
  getCatalogView: billingMocks.getCatalogView,
}));
vi.mock("@/components/layout/sidebar", () => ({
  Sidebar: () => null,
}));
vi.mock("@/components/auth/session-keeper", () => ({
  SessionKeeper: () => null,
}));
vi.mock("@/components/billing/limit-ux-context", () => ({
  LimitUxProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/billing/limit-exhausted-bar", () => ({
  LimitExhaustedBar: () => null,
}));
vi.mock("@/components/billing/limit-exhausted-popup", () => ({
  LimitExhaustedPopup: () => null,
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`) as Error & {
      digest: string;
    };
    err.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw err;
  },
}));

import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import {
  generateRefreshToken,
  generateToken,
} from "@/lib/auth";
import { GET as restoreGET } from "@/app/api/auth/restore/route";
import DashboardLayout from "@/app/(dashboard)/layout";

type MockFn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as Record<string, Record<string, MockFn>>;

const QUOTA = () =>
  Object.assign(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded."), {
    code: 8,
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function pageRequest(
  path: string,
  cookiesMap: Record<string, string> = {}
): NextRequest {
  const request = new NextRequest(new URL(path, "http://localhost:3000"));
  for (const [name, value] of Object.entries(cookiesMap)) {
    request.cookies.set(name, value);
  }
  return request;
}

function setLayoutCookies(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      name === "rbai-token" && token ? { value: token } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  } as never);
}

function treeHasText(node: unknown, text: string): boolean {
  if (typeof node === "string") return node.includes(text);
  if (Array.isArray(node)) return node.some((n) => treeHasText(n, text));
  if (node && typeof node === "object") {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props?.children !== undefined)
      return treeHasText(props.children, text);
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.admin.findUnique.mockResolvedValue(null);
  db.revokedToken.findUnique.mockResolvedValue(null);
  db.revokedToken.upsert.mockResolvedValue({});
  billingMocks.getSubscription.mockResolvedValue({ isActive: true });
  billingMocks.getBillingCountdown.mockResolvedValue({
    notices: [],
    adminNotice: null,
  });
  billingMocks.getLimitExhaustedState.mockResolvedValue(null);
  billingMocks.getCatalogView.mockResolvedValue([]);
});

describe("dashboard layout — subscription + countdown + limit in one window", () => {
  it("calls countdown and limit BEFORE a pending subscription resolves (parallel, not serial)", async () => {
    const subGate = deferred<{ isActive: boolean }>();
    billingMocks.getSubscription.mockReturnValue(subGate.promise);
    db.admin.findUnique.mockResolvedValue({ businessId: "biz-1" });
    setLayoutCookies(generateToken("admin-1", "admin"));

    const pending = DashboardLayout({ children: null });
    await flush();
    await flush();
    // Old code awaited getSubscription first, so these two calls could
    // not have happened yet while the subscription was still pending.
    expect(billingMocks.getBillingCountdown).toHaveBeenCalledWith("biz-1");
    expect(billingMocks.getLimitExhaustedState).toHaveBeenCalledWith("biz-1");

    subGate.resolve({ isActive: true });
    const element = (await pending) as unknown as {
      props: { exhausted: boolean };
    };
    expect(element.props.exhausted).toBe(false);
    expect(billingMocks.getCatalogView).not.toHaveBeenCalled();
  });

  it("a definitively inactive subscription still redirects to /billing", async () => {
    billingMocks.getSubscription.mockResolvedValue({ isActive: false });
    db.admin.findUnique.mockResolvedValue({ businessId: "biz-1" });
    setLayoutCookies(generateToken("admin-1", "admin"));

    await expect(DashboardLayout({ children: null })).rejects.toMatchObject({
      digest: expect.stringContaining("/billing"),
    });
    // Documented trade-off: the other two reads ran speculatively and
    // were discarded by the redirect — same gate, extra reads.
    expect(billingMocks.getBillingCountdown).toHaveBeenCalledWith("biz-1");
    expect(billingMocks.getLimitExhaustedState).toHaveBeenCalledWith("biz-1");
  });

  it("a throwing subscription degrades (no /billing redirect, limit state discarded)", async () => {
    billingMocks.getSubscription.mockRejectedValue(new Error("store down"));
    billingMocks.getLimitExhaustedState.mockResolvedValue({
      exhausted: true,
      reset: { kind: "period", resetAtMs: Date.now() + 1000 },
      planId: "starter",
      limit: 100,
      used: 100,
    });
    db.admin.findUnique.mockResolvedValue({ businessId: "biz-1" });
    setLayoutCookies(generateToken("admin-1", "admin"));

    const element = (await DashboardLayout({
      children: null,
    })) as unknown as { props: { exhausted: boolean } };
    // Exhausted state discarded: the work-action guard must NOT see a
    // limit it cannot trust while the store is down.
    expect(element.props.exhausted).toBe(false);
    expect(treeHasText(element, "account data is temporarily")).toBe(true);
    expect(billingMocks.getCatalogView).not.toHaveBeenCalled();
  });

  it("an exhausted limit still loads plans and marks the provider exhausted", async () => {
    billingMocks.getLimitExhaustedState.mockResolvedValue({
      exhausted: true,
      reset: { kind: "period", resetAtMs: Date.now() + 1000 },
      planId: "starter",
      limit: 100,
      used: 100,
    });
    billingMocks.getCatalogView.mockResolvedValue([
      { id: "starter", active: true },
      { id: "pro", active: false },
    ]);
    db.admin.findUnique.mockResolvedValue({ businessId: "biz-1" });
    setLayoutCookies(generateToken("admin-1", "admin"));

    const element = (await DashboardLayout({
      children: null,
    })) as unknown as { props: { exhausted: boolean } };
    expect(element.props.exhausted).toBe(true);
    expect(billingMocks.getCatalogView).toHaveBeenCalledWith(
      expect.any(Date),
      "biz-1"
    );
  });
});

describe("restore route — revocation check + admin lookup in one window", () => {
  it("calls the admin lookup BEFORE a pending revocation read resolves (parallel, not serial)", async () => {
    const revocationGate = deferred<null>();
    db.revokedToken.findUnique.mockReturnValue(revocationGate.promise);
    db.admin.findUnique.mockResolvedValue({ id: "admin-1", role: "admin" });
    const refresh = generateRefreshToken("admin-1", "admin");

    const pending = restoreGET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    await flush();
    await flush();
    // Old code awaited verifyRefreshToken first, so the admin lookup
    // could not have happened yet while revocation was still pending.
    // (Merged tree: the select also carries the two 2FA fields the
    // restore-chain kill check reads; see TEAM 2FA block in the route.)
    expect(db.admin.findUnique).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      select: {
        id: true,
        role: true,
        twoFactorEnabled: true,
        twoFactorActivatedAt: true,
      },
    });

    revocationGate.resolve(null);
    const res = await pending;
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/dashboard");
    // Rotation still happened: the old refresh token was revoked.
    expect(db.revokedToken.upsert).toHaveBeenCalled();
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    expect(setCookies.some((c) => c.startsWith("rbai-token="))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("rbai-refresh="))).toBe(true);
  });

  it("a revoked token still lands on /login with cookies cleared (admin row discarded)", async () => {
    db.revokedToken.findUnique.mockResolvedValue({
      jti: "revoked",
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    db.admin.findUnique.mockResolvedValue({ id: "admin-1", role: "admin" });
    const refresh = generateRefreshToken("admin-1", "admin");

    const res = await restoreGET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/login");
    expect(db.revokedToken.upsert).not.toHaveBeenCalled();
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    expect(
      setCookies.some(
        (c) => c.startsWith("rbai-token=") && c.includes("Max-Age=0")
      )
    ).toBe(true);
  });

  it("a quota failure on the revocation read still preserves the cookie pair", async () => {
    db.revokedToken.findUnique.mockRejectedValue(QUOTA());
    db.admin.findUnique.mockResolvedValue({ id: "admin-1", role: "admin" });
    const refresh = generateRefreshToken("admin-1", "admin");

    const res = await restoreGET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/login");
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    expect(
      setCookies.some(
        (c) => c.startsWith("rbai-token=") && c.includes("Max-Age=0")
      )
    ).toBe(false);
    expect(
      setCookies.some(
        (c) => c.startsWith("rbai-refresh=") && c.includes("Max-Age=0")
      )
    ).toBe(false);
    expect(db.revokedToken.upsert).not.toHaveBeenCalled();
  });

  it("a missing admin still lands on /login (verified token, no account)", async () => {
    db.revokedToken.findUnique.mockResolvedValue(null);
    db.admin.findUnique.mockResolvedValue(null);
    const refresh = generateRefreshToken("admin-1", "admin");

    const res = await restoreGET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": refresh,
      })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/login");
    expect(db.revokedToken.upsert).not.toHaveBeenCalled();
  });

  it("an unsigned garbage refresh token runs no admin read at all", async () => {
    const res = await restoreGET(
      pageRequest("/api/auth/restore?next=/dashboard", {
        "rbai-refresh": "not-a-token",
      })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/login");
    expect(db.admin.findUnique).not.toHaveBeenCalled();
  });
});
