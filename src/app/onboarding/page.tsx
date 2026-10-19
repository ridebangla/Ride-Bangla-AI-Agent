import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifySessionToken } from "@/lib/auth";
import { getUnscopedPrisma } from "@/lib/prisma";
import { requireActiveSubscriptionOrRedirect } from "@/lib/subscription";
import OnboardingWizard from "./wizard";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Set up your business — Ride Bangla AI Agent",
  robots: { index: false, follow: false },
};

// Onboarding is for signed-in tenant admins only. Inactive trials go to
// /billing (same enforcement as the dashboard layout).
export default async function OnboardingPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("rbai-token")?.value;
  const payload = token ? await verifySessionToken(token) : null;
  if (!payload) redirect("/login");

  const admin = await getUnscopedPrisma().admin.findUnique({
    where: { id: payload.userId },
    select: { businessId: true, role: true },
  });
  if (!admin) redirect("/login");

  // Super Admin has no business to onboard.
  if (!admin.businessId) redirect("/dashboard");

  await requireActiveSubscriptionOrRedirect(admin.businessId);

  return <OnboardingWizard />;
}
