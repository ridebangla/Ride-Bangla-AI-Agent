import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { validateOutboundUrl } from "@/lib/ssrf";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "webhooks:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;
    const webhook = await prisma.webhook.findUnique({ where: { id } });

    if (!webhook) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    return NextResponse.json(webhook);
  } catch (error) {
    logger.error("Failed to fetch webhook:", error);
    return NextResponse.json({ error: "Failed to fetch webhook" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "webhooks:update");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;
    const body = await request.json();

    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    // Only allow known fields
    const { name, description, url, method, headers, triggerOn, isActive } = body;

    const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    if (method && !validMethods.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${validMethods.join(", ")}` },
        { status: 400 }
      );
    }

    if (url && typeof url === "string" && !url.startsWith("http")) {
      return NextResponse.json({ error: "URL must start with http:// or https://" }, { status: 400 });
    }

    // M-54: SSRF validation on webhook URL update (same as create).
    if (url && typeof url === "string") {
      const urlCheck = await validateOutboundUrl(url);
      if (!urlCheck.ok) {
        logger.warn("[Webhooks] Update blocked by SSRF validation", {
          webhookId: id,
          reason: urlCheck.error,
        });
        return NextResponse.json(
          { error: `Webhook URL is not allowed: ${urlCheck.error}` },
          { status: 400 }
        );
      }
    }

    const webhook = await prisma.webhook.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(url !== undefined && { url }),
        ...(method !== undefined && { method }),
        ...(headers !== undefined && { headers }),
        ...(triggerOn !== undefined && { triggerOn }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    return NextResponse.json(webhook);
  } catch (error) {
    logger.error("Failed to update webhook:", error);
    return NextResponse.json({ error: "Failed to update webhook" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "webhooks:delete");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;

    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    await prisma.webhook.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("Failed to delete webhook:", error);
    return NextResponse.json({ error: "Failed to delete webhook" }, { status: 500 });
  }
}
