import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { validateOutboundUrl } from "@/lib/ssrf";
import { logger } from "@/lib/logger";

// C-08: this endpoint was unauthenticated and fetched an admin-stored URL
// with no SSRF protection — an unauthenticated SSRF proxy with a response
// preview. Now: auth + webhooks:test permission + SSRF validation +
// bounded response read + timeout.
const TEST_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_CHARS = 1000;
const MAX_READ_BYTES = 64 * 1024;

async function readCappedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_READ_BYTES) break;
        chunks.push(value);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader already closed.
    }
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "webhooks:test");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { webhookId } = body;

    if (!webhookId) {
      return NextResponse.json(
        { error: "webhookId is required" },
        { status: 400 }
      );
    }

    const webhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
    });

    if (!webhook) {
      return NextResponse.json(
        { error: "Webhook not found" },
        { status: 404 }
      );
    }

    // SSRF: validate scheme/host + every resolved address before fetching.
    const check = await validateOutboundUrl(webhook.url);
    if (!check.ok) {
      logger.warn("[Webhooks] Test blocked by SSRF validation", {
        webhookId: webhook.id,
        reason: check.error,
      });
      return NextResponse.json(
        { error: `Webhook URL is not allowed: ${check.error}` },
        { status: 400 }
      );
    }

    const testPayload = {
      event: webhook.triggerOn,
      test: true,
      timestamp: new Date().toISOString(),
      data: {
        id: "test_123",
        message: "This is a test payload from Ride Bangla AI Agent",
        webhookName: webhook.name,
        triggerEvent: webhook.triggerOn,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Owly-Webhook/1.0",
      ...(typeof webhook.headers === "object" && webhook.headers !== null
        ? (webhook.headers as Record<string, string>)
        : {}),
    };
    // Never let a stored header override the request Host.
    delete headers.host;
    delete headers.Host;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(webhook.url, {
        method: webhook.method,
        headers,
        body: webhook.method !== "GET" ? JSON.stringify(testPayload) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    let responseBody: string;
    try {
      responseBody = await readCappedText(response);
    } catch {
      responseBody = "(unable to read response body)";
    }

    // Cap the preview returned to the caller.
    const bodyPreview =
      responseBody.length > MAX_PREVIEW_CHARS
        ? responseBody.slice(0, MAX_PREVIEW_CHARS) + "..."
        : responseBody;

    return NextResponse.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      bodyPreview,
      sentPayload: testPayload,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send test webhook";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 500 }
    );
  }
}
