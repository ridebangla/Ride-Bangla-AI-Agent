/**
 * Cross-platform post publisher. TEXT + PICTURE only — no video anywhere.
 *
 * publishPost() returns { ok: true, externalId } on real success and THROWS
 * on any failure. It NEVER returns a fake success: every externalId comes
 * from the platform's own API response.
 *
 * Platform notes:
 * - Facebook: POST /{page-id}/feed for text, /{page-id}/photos (multipart)
 *   for images. accountRef = the Page ID; token = page access token.
 * - Instagram: two-step /{ig-user-id}/media (CREATE container) then
 *   /{ig-user-id}/media_publish. Instagram ONLY accepts a public image_url —
 *   raw bytes cannot be uploaded, so if only bytes are available we throw an
 *   honest error instead of pretending.
 * - X (Twitter): POST /2/tweets for text; when image bytes are provided we
 *   first upload via v1.1 media/upload, then attach the media_id to the tweet.
 */
import { logger } from "@/lib/logger";
import type { SocialPlatform } from "./accounts";

const TIMEOUT_MS = 15_000;

export interface PublishInput {
  platform: SocialPlatform;
  /** Page ID (FB), IG user ID (IG), or unused handle placeholder (X). */
  accountRef: string;
  /** Decrypted bearer/page access token. Never log this. */
  token: string;
  text: string;
  imageBytes?: Buffer;
  imageMime?: string;
  /** Public image URL. Required by Instagram; optional elsewhere. */
  imageUrl?: string;
}

export interface PublishResult {
  ok: true;
  externalId: string;
}

function withTimeout(ms: number = TIMEOUT_MS): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

async function publishFacebook(input: PublishInput): Promise<PublishResult> {
  const base = "https://graph.facebook.com/v21.0";

  if (input.imageBytes) {
    // Multipart upload to /{page-id}/photos
    const { signal, clear } = withTimeout();
    try {
      const form = new FormData();
      form.append("caption", input.text);
      form.append("access_token", input.token);
      const blob = new Blob([new Uint8Array(input.imageBytes)], {
        type: input.imageMime || "image/png",
      });
      form.append("source", blob, "post.png");

      const res = await fetch(
        `${base}/${encodeURIComponent(input.accountRef)}/photos`,
        { method: "POST", body: form, signal }
      );
      if (!res.ok) {
        throw new Error(`facebook photo post failed: ${await readError(res)}`);
      }
      const data = (await res.json()) as { id?: string; post_id?: string };
      const externalId = data.post_id || data.id;
      if (!externalId) {
        throw new Error("facebook photo post succeeded but returned no post ID");
      }
      return { ok: true, externalId };
    } finally {
      clear();
    }
  }

  // Text-only post to /{page-id}/feed
  const { signal, clear } = withTimeout();
  try {
    const params = new URLSearchParams({
      message: input.text,
      access_token: input.token,
    });
    const res = await fetch(
      `${base}/${encodeURIComponent(input.accountRef)}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal,
      }
    );
    if (!res.ok) {
      throw new Error(`facebook feed post failed: ${await readError(res)}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error("facebook feed post succeeded but returned no post ID");
    }
    return { ok: true, externalId: data.id };
  } finally {
    clear();
  }
}

// ---------------------------------------------------------------------------
// Instagram (image_url is mandatory — honest failure when only bytes exist)
// ---------------------------------------------------------------------------

async function publishInstagram(input: PublishInput): Promise<PublishResult> {
  if (!input.imageUrl) {
    throw new Error(
      "Instagram requires a public image URL; provide imageUrl or use a text post. " +
        "The AI image generator returns raw bytes, which Instagram cannot accept — " +
        "upload the image somewhere public first, or post to Facebook/X instead."
    );
  }

  const base = "https://graph.facebook.com/v21.0";
  const igUser = encodeURIComponent(input.accountRef);

  // Step 1: create the media container
  const { signal: s1, clear: c1 } = withTimeout();
  let containerId: string | undefined;
  try {
    const params = new URLSearchParams({
      image_url: input.imageUrl,
      caption: input.text,
      access_token: input.token,
    });
    const res = await fetch(`${base}/${igUser}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: s1,
    });
    if (!res.ok) {
      throw new Error(`instagram media container failed: ${await readError(res)}`);
    }
    const data = (await res.json()) as { id?: string };
    containerId = data.id;
    if (!containerId) {
      throw new Error("instagram media container returned no ID");
    }
  } finally {
    c1();
  }

  // Step 2: publish the container
  const { signal: s2, clear: c2 } = withTimeout();
  try {
    const params = new URLSearchParams({
      creation_id: containerId,
      access_token: input.token,
    });
    const res = await fetch(`${base}/${igUser}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: s2,
    });
    if (!res.ok) {
      throw new Error(`instagram media_publish failed: ${await readError(res)}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error("instagram media_publish returned no media ID");
    }
    return { ok: true, externalId: data.id };
  } finally {
    c2();
  }
}

// ---------------------------------------------------------------------------
// X (Twitter)
// ---------------------------------------------------------------------------

async function uploadMediaToX(
  token: string,
  imageBytes: Buffer,
  imageMime: string
): Promise<string> {
  const { signal, clear } = withTimeout();
  try {
    const form = new FormData();
    form.append(
      "media",
      new Blob([new Uint8Array(imageBytes)], { type: imageMime }),
      "post.png"
    );
    form.append("media_category", "tweet_image");

    const res = await fetch("https://upload.twitter.com/1.1/media/upload.json", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal,
    });
    if (!res.ok) {
      throw new Error(`x media upload failed: ${await readError(res)}`);
    }
    const data = (await res.json()) as { media_id_string?: string };
    if (!data.media_id_string) {
      throw new Error("x media upload returned no media_id_string");
    }
    return data.media_id_string;
  } finally {
    clear();
  }
}

async function publishX(input: PublishInput): Promise<PublishResult> {
  let mediaIds: string[] | undefined;
  if (input.imageBytes) {
    const mediaId = await uploadMediaToX(
      input.token,
      input.imageBytes,
      input.imageMime || "image/png"
    );
    mediaIds = [mediaId];
  }

  const { signal, clear } = withTimeout();
  try {
    const body: Record<string, unknown> = { text: input.text };
    if (mediaIds) body.media = { media_ids: mediaIds };

    const res = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(`x tweet failed: ${await readError(res)}`);
    }
    const data = (await res.json()) as { data?: { id?: string } };
    const externalId = data.data?.id;
    if (!externalId) {
      throw new Error("x tweet succeeded but returned no tweet ID");
    }
    return { ok: true, externalId };
  } finally {
    clear();
  }
}

// ---------------------------------------------------------------------------

export async function publishPost(input: PublishInput): Promise<PublishResult> {
  if (!input.text || !input.text.trim()) {
    throw new Error("Cannot publish an empty post.");
  }
  logger.info(`Publishing ${input.platform} post`, {
    platform: input.platform,
    accountRef: input.accountRef,
    hasImage: Boolean(input.imageBytes || input.imageUrl),
    // token is intentionally never logged
  });

  switch (input.platform) {
    case "facebook":
      return publishFacebook(input);
    case "instagram":
      return publishInstagram(input);
    case "x":
      return publishX(input);
    default:
      throw new Error(`Unsupported platform: ${input.platform}`);
  }
}
