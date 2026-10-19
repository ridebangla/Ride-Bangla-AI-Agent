import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { Sidebar } from "@/components/layout/sidebar";
import { verifySessionToken } from "@/lib/auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getSubscription } from "@/lib/subscription";
import { getBillingCountdown } from "@/lib/billing-usage";

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

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get("rbai-token")?.value;
  const payload = token ? await verifySessionToken(token) : null;
  // Fail-closed: no valid session -> login (middleware normally redirects
  // first; this is the backstop).
  if (!payload) redirect("/login");

  const admin = await getUnscopedPrisma().admin.findUnique({
    where: { id: payload.userId },
    select: { businessId: true },
  });
  if (!admin) redirect("/login");

  if (admin.businessId) {
    const sub = await getSubscription(admin.businessId);
    if (!sub.isActive) redirect("/billing");
  }

  // Billing Phase 2: countdown banner — shown ONLY when a warning threshold
  // is breached (days 7/3/1, usage 80%/100%) or the team posted an
  // adminNotice. Otherwise the dashboard stays exactly as it was.
  const countdown = admin.businessId
    ? await getBillingCountdown(admin.businessId)
    : null;
  const showCountdownBanner =
    !!countdown &&
    (countdown.notices.length > 0 || !!countdown.adminNotice);

  return (
    <>
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
            {countdown.notices.map((n, i) =>
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
    </>
  );
}
