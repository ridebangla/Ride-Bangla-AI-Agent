import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/layout/sidebar";
import { verifySessionToken } from "@/lib/auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getSubscription } from "@/lib/subscription";

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

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
    </div>
  );
}
