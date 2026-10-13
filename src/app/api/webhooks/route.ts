import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { validateOutboundUrl } from "@/lib/ssrf";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "webhooks:read");
  if (!isAuthenticated(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const { page, limit, skip, take } = parsePagination(searchParams);

  const [webhooks, total] = await Promise.all([
    prisma.webhook.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.webhook.count(),
  ]);

  return NextResponse.json(paginatedResponse(webhooks, total, page, limit));
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "webhooks:create");
  if (!isAuthenticated(auth)) return auth;

  const body = await request.json();
  const { name, description, url, method, headers, triggerOn } = body;

  if (!name || !url || !triggerOn) {
    return NextResponse.json(
      { error: "Name, URL, and triggerOn are required" },
      { status: 400 }
    );
  }

  // M-54: SSRF validation on webhook create — a webhook URL pointing at
  // internal/metadata addresses must never be stored (delivery re-validates
  // too, but rejecting at create time keeps the bad target out entirely).
  const urlCheck = await validateOutboundUrl(url);
  if (!urlCheck.ok) {
    logger.warn("[Webhooks] Create blocked by SSRF validation", {
      reason: urlCheck.error,
    });
    return NextResponse.json(
      { error: `Webhook URL is not allowed: ${urlCheck.error}` },
      { status: 400 }
    );
  }

  const webhook = await prisma.webhook.create({
    data: {
      name,
      description: description || "",
      url,
      method: method || "POST",
      headers: headers || {},
      triggerOn,
    },
  });

  return NextResponse.json(webhook, { status: 201 });
}
