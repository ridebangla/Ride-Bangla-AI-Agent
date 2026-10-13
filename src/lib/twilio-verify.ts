import crypto from "crypto";
import { NextResponse } from "next/server";

/**
 * Validate Twilio webhook request signature.
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  if (!authToken || !signature) return false;

  // Sort params alphabetically and concatenate
  const data =
    url +
    Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], "");

  const computed = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");

  const computedBuf = Buffer.from(computed);
  const signatureBuf = Buffer.from(signature);

  if (computedBuf.length !== signatureBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, signatureBuf);
}

/**
 * Extract Twilio auth token from settings.
 */
export async function getTwilioAuthToken(): Promise<string> {
  // Dynamic import to avoid circular deps
  const { prisma } = await import("@/lib/prisma");
  const settings = await prisma.settings.findFirst({
    select: { twilioToken: true },
  });
  return settings?.twilioToken || "";
}

/**
 * Fail-closed Twilio webhook verification (M-52).
 *
 * Previously each route did `if (authToken) { verify... }` — with the token
 * unset, verification was silently skipped and ANY caller could inject SMS /
 * calls. Now: unset token → 403 + an error-level log (the alert; this repo
 * has no external alerting sink, so the error log is the signal operators
 * must watch — wire it to Sentry/email alerting if available).
 * Invalid signature → 403.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, response }` where
 * `response` is the 403 the route must return.
 */
export async function verifyTwilioRequest(
  channel: string,
  request: { url: string; headers: Headers },
  params: Record<string, string>
): Promise<{ ok: boolean; response?: NextResponse }> {
  const { logger } = await import("@/lib/logger");
  const authToken = await getTwilioAuthToken();

  if (!authToken) {
    logger.error(
      `[Twilio:${channel}] ALERT: twilioToken is NOT configured — rejecting webhook (fail-closed). ` +
        "Set twilioToken in Settings to restore Twilio webhooks."
    );
    return { ok: false, response: new NextResponse("Forbidden", { status: 403 }) };
  }

  const signature = request.headers.get("x-twilio-signature") || "";
  if (!validateTwilioSignature(authToken, signature, request.url, params)) {
    logger.warn(`[Twilio:${channel}] Invalid Twilio signature`);
    return { ok: false, response: new NextResponse("Forbidden", { status: 403 }) };
  }

  return { ok: true };
}
