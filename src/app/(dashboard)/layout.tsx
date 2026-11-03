import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { Sidebar } from "@/components/layout/sidebar";
import { SessionKeeper } from "@/components/auth/session-keeper";
import {
  getRefreshCookieName,
  verifySessionTokenForEntry,
  verifyToken,
} from "@/lib/auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getSubscription } from "@/lib/subscription";
import { getBillingCountdown, getLimitExhaustedState } from "@/lib/billing-usage";
import { getCatalogView } from "@/lib/plan-catalog";
import { LimitUxProvider } from "@/components/billing/limit-ux-context";
import { LimitExhaustedBar } from "@/components/billing/limit-exhausted-bar";
import { LimitExhaustedPopup } from "@/components/billing/limit-exhausted-popup";

// This layout wraps every dashboard page, so it is the page-level
// enforcement point for the SaaS trial/subscription rule (Phase 1):
// a logged-in TENANT admin whose trial/subscription is inactive is sent to
// /billing and can never reach the dashboard. The Super Admin
// (businessId null) is always active and passes through.
//
// NOTE: this check deliberately lives here and NOT in src/middleware.ts —
// middleware runs on the edge runtime and cannot query Firestore (see the
// C-07 comment there). Server components/layouts do the DB check instead.
export const dynamic = "force-dynamic";

// The whole authenticated dashboard group is private tenant data — never
// indexable. (The pages are client components and cannot export metadata;
// this server layout is the group's enforcement point.)
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get("rbai-token")?.value;
  // Q-SIGNIN (2026-10-23): ENTRY uses the degraded-aware verify. When
  // the data store's revocation read fails (quota wall), a
  // signature-valid token still proves ENTRY and the layout renders a
  // degraded shell with an honest notice — the session is NOT treated
  // as fully proven (degraded sessions skip every business/billing
  // read and redirect below; API routes keep their strict checks).
  // A definitively invalid/revoked/expired token is unchanged: payload
  // null, degraded false, the fail-closed backstop below runs.
  const { payload, degraded: sessionDegraded } = token
    ? await verifySessionTokenForEntry(token)
    : { payload: null, degraded: false };
  // Fail-closed: no valid session -> login (middleware normally redirects
  // first; this is the backstop).
  if (!payload) {
    // Session-restore backstop (2026-10-21): middleware normally bounces
    // an expired-access + live-refresh load to /api/auth/restore before
    // this gate renders. If we still land here sessionless, do the same
    // when the access token is merely EXPIRED (or absent) and a refresh
    // cookie exists. A token that verifies cryptographically but was
    // REVOKED (verifyToken passes, verifySessionToken fails) is NOT
    // restorable — straight to /login, fail-closed as before.
    const refreshToken = cookieStore.get(getRefreshCookieName())?.value;
    const accessExpired = !token || verifyToken(token) === null;
    if (refreshToken && accessExpired) {
      redirect("/api/auth/restore?next=/dashboard");
    }
    redirect("/login");
  }

  // Q-SIGNIN: profile/business reads no longer GATE entry. A read that
  // throws (quota wall) degrades the shell instead of 500-ing the whole
  // dashboard; only a DEFINITIVE answer gates — admin record gone →
  // /login, subscription read successfully AND inactive → /billing
  // (trial semantics preserved exactly). A degraded session never
  // redirects to /billing: its state is unknown, not inactive.
  let degraded = sessionDegraded;
  let admin: { businessId: string | null } | null = null;
  try {
    admin = await getUnscopedPrisma().admin.findUnique({
      where: { id: payload.userId },
      select: { businessId: true },
    });
  } catch {
    degraded = true;
  }
  if (!admin && !degraded) redirect("/login");

  // Login/dashboard performance (owner directive 2026-10-22, extended):
  // getSubscription, getBillingCountdown and getLimitExhaustedState are
  // INDEPENDENT — all three key off businessId only and none consumes
  // another's result — so they run in ONE Promise.allSettled window
  // instead of two sequential windows (subscription, then the
  // countdown/limit pair). Wall-clock on the active path drops from
  // sum(subscription, max(countdown, limit)) to
  // max(subscription, countdown, limit); the read COUNT on that path
  // is unchanged (the same three calls).
  // Outcome preservation (checked, not assumed):
  //  - subscription throws -> degraded=true and the other two results
  //    are DISCARDED, exactly as before when they never ran;
  //  - subscription definitively inactive -> redirect("/billing");
  //  - countdown/limit never throw (both catch internally to null),
  //    so a rejected settled result is treated as null, matching
  //    their old null-on-failure behaviour.
  // Trade-off, stated plainly: on the inactive and subscription-failure
  // paths the countdown/limit reads now run speculatively and are
  // discarded (before, they never ran there). Those paths end in a
  // redirect or a degraded shell, so the extra reads buy nothing
  // there; they are the price of the single window on the active
  // path, which is the path that actually paints a dashboard.
  // The subscription GATE itself is untouched: only a definitive
  // inactive answer redirects, and a failed read still degrades
  // instead of redirecting.
  let countdown: Awaited<ReturnType<typeof getBillingCountdown>> = null;
  let limitState: Awaited<ReturnType<typeof getLimitExhaustedState>> = null;
  if (admin?.businessId && !sessionDegraded) {
    const businessId = admin.businessId;
    const [subResult, countdownResult, limitResult] =
      await Promise.allSettled([
        getSubscription(businessId),
        getBillingCountdown(businessId),
        getLimitExhaustedState(businessId),
      ]);
    if (subResult.status === "rejected") {
      // Read failed (quota wall): state unknown — degrade, never redirect.
      degraded = true;
    } else {
      if (!subResult.value.isActive) redirect("/billing");
      countdown =
        countdownResult.status === "fulfilled"
          ? countdownResult.value
          : null;
      limitState =
        limitResult.status === "fulfilled" ? limitResult.value : null;
    }
  }

  // Billing Phase 2: countdown banner — shown ONLY when a warning threshold
  // is breached (days 7/3/1, usage 80%/100%) or the team posted an
  // adminNotice. Otherwise the dashboard stays exactly as it was.
  // Q-SIGNIN: in degraded mode these billing reads are skipped entirely
  // (they would only re-hit the down data store); the shell renders
  // with the honest notice below and no limit UX — the spend gates in
  // the API routes remain the enforcement point once the store is back.

  // Limit-exhausted UX (owner directive 2026-10-22): when the tenant's
  // product limit is finished, the dashboard still renders fully — a
  // bar + popup show the account state, WHEN it resets, and the plans
  // from the live ai_plans catalog. ONLY the work-action is disabled.
  // Internal/company accounts are exempt (getLimitExhaustedState
  // returns null for them); the Super Admin (businessId null) never
  // has a limit. The auth/session path above is untouched.
  const limitPlans =
    limitState && admin?.businessId
      ? (await getCatalogView(new Date(), admin.businessId)).filter(
          (p) => p.active
        )
      : [];

  // While the limit-exhausted UX is active it supersedes the old
  // 100%-usage banner line (same exhausted fact, one voice).
  const countdownNotices = limitState
    ? (countdown?.notices ?? []).filter(
        (n) => !(n.type === "usage" && n.threshold === 100)
      )
    : (countdown?.notices ?? []);
  const showCountdownBanner =
    !!countdown &&
    (countdownNotices.length > 0 || !!countdown.adminNotice);

  return (
    <LimitUxProvider exhausted={!!limitState}>
      <SessionKeeper />
      {degraded && (
        <div
          role="status"
          className="bg-amber-50 border-b border-amber-200 px-4 py-2.5"
        >
          <div className="max-w-5xl mx-auto text-sm text-amber-900">
            <span className="font-medium">
              You are signed in, but account data is temporarily
              unavailable.
            </span>{" "}
            Our data store has reached its temporary limit, so business
            information and usage state cannot be loaded right now. Some
            actions may be paused until it recovers — please check back
            shortly.
          </div>
        </div>
      )}
      {limitState && <LimitExhaustedBar reset={limitState.reset} />}
      {/*
        Always mounted (not only when limitState is non-null): a
        mid-session client trigger (402 from a dashboard caller after
        page load) calls openPopup(), and a popup that was never
        mounted cannot render at all. When limitState is null the
        props are absent and the popup falls back to headline + CTA
        only — no invented reset, usage, or plan details — and the
        Modal stays closed until openPopup() fires, so a
        not-exhausted dashboard renders exactly as before. Server
        state computation above is untouched: this changes only
        whether the popup component is mounted, never when the
        server considers the limit exhausted.
      */}
      <LimitExhaustedPopup
        reset={limitState?.reset}
        plans={limitPlans}
        currentPlanId={limitState?.planId}
        used={limitState?.used}
        limit={limitState?.limit}
      />
      {showCountdownBanner && countdown && (
        <div
          role="status"
          className="bg-amber-50 border-b border-amber-200 px-4 py-2.5"
        >
          <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-amber-900">
            {countdown.adminNotice && (
              <span className="font-medium">
                Notice from our team: {countdown.adminNotice.message}
              </span>
            )}
            {countdownNotices.map((n, i) =>
              n.type === "days" ? (
                <span key={`d-${i}`}>
                  {n.daysRemaining <= 0
                    ? "Your billing period ends today."
                    : `Your billing period ends in ${n.daysRemaining} day${n.daysRemaining === 1 ? "" : "s"}.`}
                </span>
              ) : (
                <span key={`u-${i}`}>
                  You have used {n.percentUsed}% of your AI messages this
                  period
                  {n.messagesRemaining === 0
                    ? " — upgrade your plan to keep the AI replying."
                    : ` (${n.messagesRemaining} left).`}
                </span>
              )
            )}
            <Link
              href="/billing"
              className="font-medium text-amber-800 underline underline-offset-2 hover:text-amber-950"
            >
              View billing
            </Link>
          </div>
        </div>
      )}
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
      </div>
    </LimitUxProvider>
  );
}
