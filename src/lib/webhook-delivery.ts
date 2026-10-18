import crypto from "crypto";
import { prisma, withBusinessId } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { validateOutboundUrl } from "@/lib/ssrf";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [5000, 30000, 300000]; // 5s, 30s, 5min
const DELIVERY_TIMEOUT = 10000;

interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload verification.
 */
export function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Deliver a webhook with retry logic and delivery tracking.
 */
export async function deliverWebhook(
  webhook: WebhookConfig,
  event: string,
  data: Record<string, unknown>
): Promise<{ deliveryId: string; success: boolean }> {
  const payload = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    webhookId: webhook.id,
    data,
  });

  const delivery = await prisma.webhookDelivery.create({
    data: withBusinessId({
      webhookId: webhook.id,
      event,
      payload: JSON.parse(payload),
      status: "pending",
      attempts: 0,
    }),
  });

  const result = await attemptDelivery(webhook, payload, delivery.id);

  return { deliveryId: delivery.id, success: result };
}

async function attemptDelivery(
  webhook: WebhookConfig,
  payload: string,
  deliveryId: string,
  attempt = 1
): Promise<boolean> {
  // C-08: SSRF blocklist applies to real deliveries too, not just the test
  // endpoint. A blocked URL fails terminally (no retry — retrying a
  // blocked target only re-probes the internal network).
  const urlCheck = await validateOutboundUrl(webhook.url);
  if (!urlCheck.ok) {
    const blockedMessage = `Webhook URL blocked by SSRF validation: ${urlCheck.error}`;
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "failed",
        attempts: attempt,
        lastError: blockedMessage,
        statusCode: null,
      },
    });
    logger.error("Webhook delivery blocked by SSRF validation", null, {
      deliveryId,
      webhookId: webhook.id,
      event: "delivery_blocked_ssrf",
    });
    return false;
  }

  const webhookSecret = process.env.WEBHOOK_SECRET || "";

  // M-54: fail closed when WEBHOOK_SECRET is unset — never deliver an
  // unsigned webhook. Previously deliveries went out with NO X-RBAI-Signature
  // at all, so receivers could not tell a real delivery from a forgery.
  // Fails terminally (no retry): retrying cannot help until the operator
  // sets WEBHOOK_SECRET; the delivery can be retried manually afterwards.
  if (!webhookSecret) {
    const missingSecretMessage =
      "WEBHOOK_SECRET is not configured — delivery refused (fail-closed). Set WEBHOOK_SECRET, then retry the delivery.";
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "failed",
        attempts: attempt,
        lastError: missingSecretMessage,
        statusCode: null,
      },
    });
    logger.error("Webhook delivery refused: WEBHOOK_SECRET is not configured", null, {
      deliveryId,
      webhookId: webhook.id,
      event: "delivery_blocked_no_secret",
    });
    return false;
  }

  const signature = generateSignature(payload, webhookSecret);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "RBAI-Webhook/1.0",
      ...webhook.headers,
    };
    // Never let a stored header override the request Host.
    delete headers.host;
    delete headers.Host;

    // WEBHOOK_SECRET is required (fail-closed above), so every delivery is signed.
    headers["X-RBAI-Signature"] = signature;

    const response = await fetch(webhook.url, {
      method: webhook.method,
      headers,
      body: webhook.method !== "GET" ? payload : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "delivered",
          statusCode: response.status,
          attempts: attempt,
        },
      });
      return true;
    }

    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  } catch (error) {
    clearTimeout(timeoutId);

    const errorMessage = error instanceof Error
      ? (error.name === "AbortError" ? "Request timed out" : error.message)
      : String(error);

    if (attempt < MAX_ATTEMPTS) {
      const retryDelay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      const nextRetryAt = new Date(Date.now() + retryDelay);

      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "pending",
          attempts: attempt,
          lastError: errorMessage,
          nextRetryAt,
        },
      });

      logger.warn(`Webhook delivery failed, retrying in ${retryDelay / 1000}s`, {
        deliveryId,
        webhookId: webhook.id,
        attempt,
        error: errorMessage,
      });

      // Schedule retry
      setTimeout(() => {
        attemptDelivery(webhook, payload, deliveryId, attempt + 1).catch((err) =>
          logger.error("Webhook retry failed", err)
        );
      }, retryDelay);

      return false;
    }

    // All retries exhausted
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "failed",
        attempts: attempt,
        lastError: errorMessage,
        statusCode: null,
      },
    });

    logger.error("Webhook delivery permanently failed", null, {
      deliveryId,
      webhookId: webhook.id,
      event: "delivery_failed",
    });

    return false;
  }
}

/**
 * Retry a specific failed delivery.
 */
export async function retryDelivery(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });

  if (!delivery || !delivery.webhook) {
    return false;
  }

  const payload = JSON.stringify(delivery.payload);

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: "pending", attempts: 0, lastError: null },
  });

  return attemptDelivery(
    {
      id: delivery.webhook.id,
      name: delivery.webhook.name,
      url: delivery.webhook.url,
      method: delivery.webhook.method,
      headers: (delivery.webhook.headers || {}) as Record<string, string>,
    },
    payload,
    deliveryId
  );
}
