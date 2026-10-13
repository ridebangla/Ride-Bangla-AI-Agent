import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { hasPermission, Permission } from "@/lib/rbac";
import { hashApiKey } from "@/lib/api-keys";
import { prisma } from "@/lib/prisma";

interface AuthContext {
  userId: string;
  role: string;
  username: string;
  name: string;
  authMethod: "cookie" | "api_key";
  /** API-key scope list. Empty for cookie auth (role permissions apply). */
  scopes: string[];
}

/**
 * Authenticate via API key (X-API-Key header).
 * Only the SHA-256 hash of the key is stored; the presented key is hashed
 * and compared by hash. The key may only use permissions in its scope list.
 */
async function authenticateApiKey(apiKey: string): Promise<AuthContext | null> {
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(apiKey) },
  });

  if (!key || !key.isActive) return null;

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
  };
}

/**
 * Authenticate and authorize an API request.
 * Supports both cookie (JWT) and API key (X-API-Key header) auth.
 * Returns the auth context or a 401/403 response.
 */
export async function requireAuth(
  request: NextRequest,
  permission?: Permission
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
  const token = request.cookies.get("owly-token")?.value;

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

  const admin = await prisma.admin.findUnique({
    where: { id: payload.userId },
    select: { id: true, username: true, name: true, role: true },
  });

  if (!admin) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "User not found" } },
      { status: 401 }
    );
  }

  return {
    userId: admin.id,
    role: admin.role,
    username: admin.username,
    name: admin.name,
    authMethod: "cookie",
    scopes: [],
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
