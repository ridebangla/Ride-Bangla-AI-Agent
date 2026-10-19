/**
 * Phase 5: X (Twitter) API — post/reply functions + DM webhook.
 *
 * Env (all optional; every flow degrades honestly when absent):
 *   X_API_KEY, X_API_SECRET, X_BEARER_TOKEN, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *
 * Posting/replying uses OAuth 1.0a user context (X_API_KEY + X_API_SECRET +
 * X_ACCESS_TOKEN + X_ACCESS_SECRET) because app-only bearer tokens cannot
 * write. Reading mentions uses X_BEARER_TOKEN (already exercised by the
 * engagement sync).
 *
 * The DM webhook (Account Activity API, paid tier) answers the CRC
 * challenge with HMAC-SHA256(X_API_SECRET). When the API keys are absent
 * the webhook route answers honestly instead of faking a handshake.
 */
import crypto from "crypto";
import { logger } from "@/lib/logger";

export function getXEnv() {
  return {
    apiKey: process.env.X_API_KEY || "",
    apiSecret: process.env.X_API_SECRET || "",
    bearerToken: process.env.X_BEARER_TOKEN || "",
    accessToken: process.env.X_ACCESS_TOKEN || "",
    accessSecret: process.env.X_ACCESS_SECRET || "",
  };
}

export function isXConfigured(): boolean {
  const e = getXEnv();
  return Boolean(e.bearerToken || (e.apiKey && e.apiSecret));
}

export function isXWriteConfigured(): boolean {
  const e = getXEnv();
  return Boolean(e.apiKey && e.apiSecret && e.accessToken && e.accessSecret);
}

/** Percent-encode per RFC 3986 (OAuth 1.0a needs this, not encodeURIComponent). */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

interface OAuth1Params {
  method: "POST";
  url: string;
  bodyParams: Record<string, string>;
}

/**
 * Sign an X API request with OAuth 1.0a (HMAC-SHA1). Returns the
 * Authorization header value. Pure function — no network.
 */
export function signOAuth1(
  { method, url, bodyParams }: OAuth1Params,
  consumerKey: string,
  consumerSecret: string,
  token: string,
  tokenSecret: string,
  nonce?: string,
  timestamp?: string
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp || Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const all = { ...bodyParams, ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(all[k])}`)
    .join("&");
  const baseString = [method, rfc3986(url), rfc3986(paramString)].join("&");
  const signingKey = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
  const header = Object.keys(oauth)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`)
    .join(", ");
  return `OAuth ${header}, oauth_signature="${rfc3986(signature)}"`;
}

/**
 * Post a tweet, optionally as a reply to another tweet. Real API write —
 * only a platform-returned tweet ID counts as success.
 */
export async function postXTweet(
  text: string,
  inReplyToTweetId?: string
): Promise<{ tweetId: string } | null> {
  const e = getXEnv();
  if (!isXWriteConfigured()) {
    logger.warn("[X] write not configured — cannot post");
    return null;
  }
  const url = "https://api.twitter.com/2/tweets";
  const body: Record<string, unknown> = { text: text.slice(0, 280) };
  if (inReplyToTweetId) body.reply = { in_reply_to_tweet_id: inReplyToTweetId };

  // OAuth 1.0a signs the body params for form-encoded requests; for JSON
  // bodies the signature covers oauth params only (X accepts this).
  const auth = signOAuth1(
    { method: "POST", url, bodyParams: {} },
    e.apiKey,
    e.apiSecret,
    e.accessToken,
    e.accessSecret
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const resBody = await res.text();
    if (!res.ok) {
      logger.warn("[X] post failed", {
        status: res.status,
        body: resBody.slice(0, 300),
      });
      return null;
    }
    const data = JSON.parse(resBody) as { data?: { id?: string } };
    if (!data.data?.id) return null;
    return { tweetId: data.data.id };
  } catch (err) {
    logger.error("[X] post threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Reply to a tweet (same write path). */
export async function replyXTweet(
  tweetId: string,
  text: string
): Promise<{ tweetId: string } | null> {
  return postXTweet(text, tweetId);
}

/**
 * Send an X DM via the v1.1 direct_messages/events/new endpoint (user
 * context). Returns true only on platform acceptance.
 */
export async function sendXDM(
  recipientUserId: string,
  text: string
): Promise<boolean> {
  const e = getXEnv();
  if (!isXWriteConfigured()) {
    logger.warn("[X] write not configured — cannot send DM");
    return false;
  }
  const url = "https://api.twitter.com/1.1/direct_messages/events/new.json";
  const auth = signOAuth1(
    { method: "POST", url, bodyParams: {} },
    e.apiKey,
    e.apiSecret,
    e.accessToken,
    e.accessSecret
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event: {
          type: "message_create",
          message_create: {
            target: { recipient_id: recipientUserId },
            message_data: { text: text.slice(0, 10000) },
          },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn("[X] DM send failed", {
        status: res.status,
        body: body.slice(0, 300),
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error("[X] DM send threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Answer the Account Activity API CRC challenge. Returns the response
 * token, or null when X_API_SECRET is absent (the route then answers
 * honestly instead of faking the handshake).
 */
export function answerXCRChallenge(crcToken: string): string | null {
  const { apiSecret } = getXEnv();
  if (!apiSecret || !crcToken) return null;
  const hash = crypto
    .createHmac("sha256", apiSecret)
    .update(crcToken)
    .digest("base64");
  return `sha256=${hash}`;
}
