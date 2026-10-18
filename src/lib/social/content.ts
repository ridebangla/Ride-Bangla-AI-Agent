/**
 * AI post-content generation (TEXT + PICTURE only — no video).
 *
 * - generatePostContent(): asks the AI to write platform-ready post text and
 *   an image prompt, grounded in business settings, knowledge base,
 *   audience brief, and website content.
 * - generatePostImage(): calls OpenAI's image model and returns raw BYTES
 *   (Buffer + mimeType) — not a fake URL. The publisher uploads these bytes
 *   directly to Facebook/X. IMPORTANT: Instagram does NOT accept byte
 *   uploads — it requires a public image_url. For Instagram, generate the
 *   image, host it somewhere public, and pass its URL as `imageUrl`.
 */
import { getOpenAI, getKnowledgeContext } from "./ai";
import { getAudienceBrief } from "./audience";
import { fetchWebsiteContent } from "./website";
import type { SocialPlatform } from "./accounts";

export interface PostContentInput {
  platform: SocialPlatform;
  topic: string;
  postType?: string; // promo | announcement | engagement | tip
  textOverride?: string;
  imagePromptOverride?: string;
}

export interface PostContent {
  text: string;
  imagePrompt: string;
}

const PLATFORM_GUIDE: Record<SocialPlatform, string> = {
  facebook:
    "Facebook: up to ~2000 chars is fine but keep the hook in the first 2 lines. Conversational tone, one clear call to action.",
  instagram:
    "Instagram: visual-first caption, hook line first, short paragraphs, end with relevant hashtags (max 8).",
  x: "X/Twitter: hard limit of 280 characters. Punchy, one idea, no fluff.",
};

export async function generatePostContent(
  input: PostContentInput
): Promise<PostContent> {
  if (input.textOverride && input.textOverride.trim()) {
    return {
      text: input.textOverride.trim(),
      imagePrompt:
        input.imagePromptOverride?.trim() ||
        `Promotional social media image about: ${input.topic}`,
    };
  }

  const { client, settings } = await getOpenAI();
  const knowledge = await getKnowledgeContext();
  const brief = await getAudienceBrief(input.platform);
  let website = "";
  try {
    const pages = await fetchWebsiteContent();
    website = pages
      .map((p) => `${p.title}: ${p.text.slice(0, 1500)}`)
      .join("\n\n")
      .slice(0, 4000);
  } catch {
    website = ""; // website grounding is best-effort
  }

  const system = [
    `You write social media posts for "${settings.businessName}".`,
    settings.businessDesc ? `Business: ${settings.businessDesc}` : "",
    `Platform rules: ${PLATFORM_GUIDE[input.platform]}`,
    `Post type: ${input.postType || "promo"}. Topic: ${input.topic}.`,
    "Reply in the SAME language the topic implies (Bengali or English).",
    "Write natural, human-like copy. No markdown formatting symbols.",
    knowledge ? `\nBusiness facts (do not invent others):\n${knowledge}` : "",
    brief ? `\nAudience insight: ${brief}` : "",
    website ? `\nWebsite content:\n${website}` : "",
    "",
    "Return JSON only: { \"text\": \"<post text>\", \"imagePrompt\": \"<detailed image prompt for a 1:1 promotional image, no text overlays unless essential>\" }",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await client.chat.completions.create({
    model: settings.model,
    messages: [{ role: "system", content: system }],
    max_tokens: 1200,
    temperature: 0.8,
    response_format: { type: "json_object" },
  });

  const raw = res.choices[0]?.message?.content?.trim();
  if (!raw) throw new Error("AI returned no content.");

  let parsed: { text?: string; imagePrompt?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI returned unparsable content JSON.");
  }

  const text = (parsed.text || "").trim();
  if (!text) throw new Error("AI returned empty post text.");

  return {
    text,
    imagePrompt:
      input.imagePromptOverride?.trim() ||
      (parsed.imagePrompt || "").trim() ||
      `Promotional social media image about: ${input.topic}`,
  };
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

/** Generate a picture for a post. Returns raw bytes — never a fake URL. */
export async function generatePostImage(
  imagePrompt: string
): Promise<GeneratedImage> {
  const { client } = await getOpenAI();

  const res = await client.images.generate({
    model: "gpt-image-1",
    prompt: imagePrompt,
    size: "1024x1024",
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image generation returned no image data.");
  }

  return { bytes: Buffer.from(b64, "base64"), mimeType: "image/png" };
}
