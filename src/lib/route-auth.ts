import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { hasPermission, Permission } from "@/lib/rbac";
import { hashApiKey } from "@/lib/api-keys";
import { prisma, getUnscopedPrisma } from "@/lib/prisma";
import { enterBusinessContext } from "@/lib/tenant";

interface AuthContext {
  userId: string;
  role: string;
  username: string;
  name: string;
  authMethod: "cookie" | "api_key";
  /** API-key scope list. Empty for cookie auth (role permissions apply). */
  scopes: string[];
  /** Business this caller belongs to. null = Super Admin (all businesses). */
  businessId: string | null;
}

/**
 * Authenticate via API key (X-API-Key header).
 * Only the SHA-256 hash of the key is stored; the presented key is hashed
 * and compared by hash. The key may only use permissions in its scope list.
 */
async function authenticateApiKey(apiKey: string): Promise<(AuthContext & { businessId: string | null }) | null> {
  // Unscoped lookup: keyHash is globally unique, and we have no tenant
  // context yet (this function ESTABLISHES it).
  const key = await getUnscopedPrisma().apiKey.findUnique({
    where: { keyHash: hashApiKey(apiKey) },
  });

  if (!key || !key.isActive) return null;

  // NOTE: this enterWith() covers only the remainder of THIS function's
  // execution — it does not reach the route handler that awaited
  // authenticateApiKey(). The handler must wrap its work in
  // runWithBusiness(auth.businessId, ...).
  enterBusinessContext(key.businessId);

  // Update lastUsed timestamp
  prisma.apiKey.update({
    where: { id: key.id },
    data: { lastUsed: new Date() },
  }).catch(() => { /* fire and forget */ });

  return {
    userId: "api-key:" + key.id,
    // API keys are NOT admins. Their authority is exactly their scope list.
    role: "api_key",
    username: key.name,
    name: key.name,
    authMethod: "api_key",
    scopes: key.scopes ?? [],
    businessId: key.businessId,
  };
}

/**
 * Authenticate and authorize an API request.
 * Supports both cookie (JWT) and API key (X-API-Key header) auth.
 * Returns the auth context or a 401/403 response.
 */
export async function requireAuth(
  request: NextRequest,
  permission?: Permission,
  options?: { allowUnscopedSuperAdmin?: boolean }
): Promise<AuthContext | NextResponse> {
  // Try API key auth first
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) {
    const context = await authenticateApiKey(apiKey);
    if (!context) {
      return NextResponse.json(
        { error: { code: "INVALID_API_KEY", message: "Invalid or inactive API key" } },
        { status: 401 }
      );
    }

    if (permission && !context.scopes.includes(permission)) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
        { status: 403 }
      );
    }

    return context;
  }

  // Fall back to cookie auth
  const token = request.cookies.get("rbai-token")?.value;

  if (!token) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required. Use cookie or X-API-Key header." } },
      { status: 401 }
    );
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return NextResponse.json(
      { error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } },
      { status: 401 }
    );
  }

  if (permission && !hasPermission(payload.role, permission)) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
      { status: 403 }
    );
  }

  const admin = await getUnscopedPrisma().admin.findUnique({
    where: { id: payload.userId },
    select: { id: true, username: true, name: true, role: true, businessId: true },
  });

  if (!admin) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "User not found" } },
      { status: 401 }
    );
  }

  // Resolve the effective business for this request. The returned
  // AuthContext.businessId lets the route handler wrap its work in
  // runWithBusiness(businessId, ...) so every downstream prisma query on a
  // tenant model is auto-scoped to this business (fail-closed).
  // NOTE: the enterBusinessContext() call below does NOT propagate to the
  // route handler (AsyncLocalStorage.enterWith() never crosses the
  // `await requireAuth(...)` boundary back into the caller) — it is kept
  // only as a best-effort default, not the mechanism handlers rely on.
  let effectiveBusinessId: string | null = admin.businessId ?? null;
  const requestedSlug = request.nextUrl.searchParams.get("business");
  const db = getUnscopedPrisma();
  if (requestedSlug) {
    const biz = await db.business.findUnique({ where: { slug: requestedSlug } });
    if (!biz || !biz.isActive) {
      return NextResponse.json(
        { error: { code: "UNKNOWN_BUSINESS", message: "Unknown business" } },
        { status: 400 }
      );
    }
    if (effectiveBusinessId && effectiveBusinessId !== biz.id) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Not a member of this business" } },
        { status: 403 }
      );
    }
    effectiveBusinessId = biz.id;
  } else if (!effectiveBusinessId) {
    // Super Admin without an explicit ?business=: with exactly one active
    // business, work inside it automatically (first-run friendly). With
    // several, the caller must choose; with none, stay unscoped (fresh install).
    const businesses = await db.business.findMany({
      where: { isActive: true },
      select: { id: true },
      take: 2,
    });
    if (businesses.length === 1) {
      effectiveBusinessId = businesses[0].id;
    } else if (businesses.length > 1) {
      // FIX (2026-10-31, profile): an ADMIN-scoped route (the caller's own
      // profile) must not fail for a Super Admin with several businesses.
      // Guessing a business for a business-scoped read/write would risk
      // acting on the wrong tenant, so the default stays fail-closed
      // (BUSINESS_REQUIRED) — only routes that explicitly opt in, and
      // that read no business data beyond the caller's own profile,
      // stay unscoped (businessId null) instead of 400ing.
      if (options?.allowUnscopedSuperAdmin) {
        effectiveBusinessId = null;
      } else {
        return NextResponse.json(
          {
            error: {
              code: "BUSINESS_REQUIRED",
              message: "Multiple businesses exist — pass ?business=<slug> to select one.",
            },
          },
          { status: 400 }
        );
      }
    }
  }
  enterBusinessContext(effectiveBusinessId);

  return {
    userId: admin.id,
    role: admin.role,
    username: admin.username,
    name: admin.name,
    authMethod: "cookie",
    scopes: [],
    businessId: effectiveBusinessId,
  };
}

/**
 * Type guard: check if result is an auth context (not an error response).
 */
export function isAuthenticated(
  result: AuthContext | NextResponse
): result is AuthContext {
  return !(result instanceof NextResponse);
}
