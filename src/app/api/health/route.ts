import { NextResponse } from "next/server";
import { getUnscopedPrisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { getCompanyIdentity } from "@/lib/company-identity";

const startTime = Date.now();

export async function GET() {
  const checks: Record<string, string> = {};
  // Health probes run outside any tenant context: use the unscoped client
  // (the scoped client would throw TenantContextError here).
  const db = getUnscopedPrisma();

  // Database check
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = "connected";
  } catch {
    checks.database = "error";
  }

  // AI provider reachability check — probes the CONFIGURED provider's
  // base URL (OpenRouter tenants must not be probed against OpenAI).
  try {
    // The probe's intent is "the platform's configured provider": when
    // the company business is known (shared identity record, 60s-cached,
    // fail-soft), read ITS settings row by the unique businessId
    // instead of an unscoped findFirst that scans the whole settings
    // collection on every uptime ping. Fall back to the old findFirst
    // when identity is empty or the company row has no settings.
    const identity = await getCompanyIdentity();
    const companyBusinessId = identity.aiBusinessIds[0];
    const companySettings = companyBusinessId
      ? await db.settings.findUnique({
          where: { businessId: companyBusinessId },
          select: { aiApiKey: true, aiProvider: true },
        })
      : null;
    const settings =
      companySettings ??
      (await db.settings.findFirst({
        select: { aiApiKey: true, aiProvider: true },
      }));
    const isOpenRouter = settings?.aiProvider === "openrouter";
    const modelsUrl = isOpenRouter
      ? "https://openrouter.ai/api/v1/models"
      : "https://api.openai.com/v1/models";
    if (settings?.aiApiKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(modelsUrl, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${settings.aiApiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      checks.openai = res.ok ? "reachable" : "error";
    } else {
      checks.openai = "not_configured";
    }
  } catch {
    checks.openai = "unreachable";
  }

  const allHealthy = Object.values(checks).every(
    (v) => v === "connected" || v === "reachable" || v === "not_configured"
  );
  const status = allHealthy ? "ok" : "degraded";

  // M-59: /api/health was public AND leaked environment, version, memory,
  // and DB/OpenAI status. Unauthenticated callers (and non-admin roles) now
  // get only `{ status }` — enough for load balancers / uptime monitors,
  // nothing useful to an attacker. Full details require an admin session.
  const user = await getCurrentUser().catch(() => null);
  // Details (environment, memory, service internals) are platform-operator
  // data: only the Super Admin gets them. Tenant admins (role "admin" —
  // every paying customer) get the same minimal { status } as the public.
  if (user?.role !== "super_admin") {
    return NextResponse.json({ status });
  }

  // Uptime
  const uptimeMs = Date.now() - startTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  // Memory
  const mem = process.memoryUsage();

  return NextResponse.json({
    status,
    version: process.env.npm_package_version || "0.1.1",
    environment: process.env.NODE_ENV || "development",
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    services: checks,
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heap: `${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    },
  });
}
