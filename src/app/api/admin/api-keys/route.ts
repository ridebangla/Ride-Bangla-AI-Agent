import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  DEFAULT_API_KEY_SCOPES,
  hashApiKey,
  keySuffixOf,
  publicApiKey,
  validateScopes,
} from "@/lib/api-keys";

function generateApiKey(): string {
  return "owly_" + crypto.randomBytes(32).toString("hex");
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const [keys, total] = await Promise.all([
      prisma.apiKey.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.apiKey.count(),
    ]);

    // Never return the stored hash; the `key` field is the masked display form.
    const masked = keys.map((k) => publicApiKey(k));

    return NextResponse.json(paginatedResponse(masked, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch API keys:", error);
    return NextResponse.json(
      { error: "Failed to fetch API keys" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "admin:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { name, scopes } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Key name is required" },
        { status: 400 }
      );
    }

    // Per-key scopes (H-15). Omitted scopes default to the agent-role set —
    // never full admin. Explicit scopes must be known permission strings.
    let resolvedScopes: string[] = DEFAULT_API_KEY_SCOPES;
    if (scopes !== undefined) {
      const scopeError = validateScopes(scopes);
      if (scopeError) {
        return NextResponse.json({ error: scopeError }, { status: 400 });
      }
      resolvedScopes = scopes as string[];
    }

    const fullKey = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        name: name.trim(),
        // H-15: store ONLY the SHA-256 hash, never the full key.
        keyHash: hashApiKey(fullKey),
        keySuffix: keySuffixOf(fullKey),
        scopes: resolvedScopes,
      },
    });

    // Return the full key only on creation — it can never be retrieved again.
    // The stored hash is never returned.
    const { keyHash: _dropped, ...rest } = apiKey;
    void _dropped;
    return NextResponse.json(
      {
        ...rest,
        key: fullKey,
      },
      { status: 201 }
    );
  } catch (error) {
    logger.error("Failed to create API key:", error);
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
