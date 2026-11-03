"use client";

/**
 * Dashboard > Security — the signed-in account's own 2FA setup surface.
 *
 * TEAM 2FA (2026-11-03). Reachable at /security inside an authenticated
 * session. All logic lives in @/components/auth/two-factor-setup and in
 * the /api/auth/two-factor/* routes; this page only mounts them. It does
 * not touch dashboard layout data-loading, profile, or checklist code.
 */
import { Header } from "@/components/layout/header";
import { TwoFactorSetup } from "@/components/auth/two-factor-setup";

export default function SecurityPage() {
  return (
    <>
      <Header
        title="Security"
        description="Authenticator-app two-factor authentication for this account"
      />
      <div className="flex-1 overflow-auto p-6">
        <TwoFactorSetup />
      </div>
    </>
  );
}
