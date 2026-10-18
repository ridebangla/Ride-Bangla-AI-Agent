import OpenAI, { toFile } from "openai";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

export type MediaKind = "image" | "video" | "audio";

export interface MediaInput {
  kind: MediaKind;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Result of the perception step. Multimodal input is perceived FIRST by a
 * dedicated model (vision / transcription) into plain text, which the main
 * brain then reasons over. This keeps the dialogue pipeline provider-agnostic
 * while every path stays real: no stubs.
 */
export interface Perception {
  kind: MediaKind;
  /** Text understanding, prefixed for the brain, e.g. "[Photo]: ..." */
  description: string;
}

function visionModelFor(configuredModel: string): string {
  // Use the business's own model when it can see; otherwise a capable,
  // inexpensive vision default. Same OpenAI API key is reused.
  if (/^(gpt-4o|gpt-4\.1|o1|o3|gpt-5)/.test(configuredModel)) return configuredModel;
  return "gpt-4o-mini";
}

function dataUri(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function describeImageWithVision(
  apiKey: string,
  model: string,
  bytes: Buffer,
  mimeType: string,
  question: string
): Promise<string> {
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: visionModelFor(model),
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: dataUri(bytes, mimeType) } },
        ],
      },
    ],
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("Vision model returned no description");
  return text;
}

/** Best-effort audio transcription via OpenAI Whisper. */
export async function transcribeAudio(
  apiKey: string,
  bytes: Buffer,
  mimeType: string
): Promise<string> {
  const ext = mimeType.includes("mp3")
    ? "mp3"
    : mimeType.includes("wav")
      ? "wav"
      : mimeType.includes("webm")
        ? "webm"
        : "ogg";
  const client = new OpenAI({ apiKey });
  const file = await toFile(bytes, `voice-${randomUUID()}.${ext}`, { type: mimeType });
  const result = await client.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });
  const text = (result.text ?? "").trim();
  if (!text) throw new Error("Transcription came back empty");
  return text;
}

/**
 * Understand a video by extracting representative frames and describing them
 * with vision. Requires `ffmpeg` on the host (documented in OPERATIONS.md).
 * Frames at ~10%, 50%, 90% give start/middle/end coverage of short clips.
 */
export async function describeVideo(
  apiKey: string,
  model: string,
  bytes: Buffer,
  mimeType: string
): Promise<string> {
  const workDir = join(tmpdir(), `rbai-video-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("webm") ? "webm" : "bin";
  const videoPath = join(workDir, `input.${ext}`);

  try {
    await writeFile(videoPath, bytes);

    // Probe duration (seconds); fall back to fixed offsets when probing fails.
    let duration = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ]);
      duration = Math.max(0, parseFloat(stdout.trim()) || 0);
    } catch {
      duration = 0;
    }
    const offsets =
      duration > 1 ? [duration * 0.1, duration * 0.5, duration * 0.9] : [0.5, 1.5, 2.5];

    const frameDescriptions: string[] = [];
    for (let i = 0; i < offsets.length; i++) {
      const framePath = join(workDir, `frame-${i}.jpg`);
      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-ss",
          String(offsets[i]),
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          framePath,
        ]);
        const frameBytes = await readFile(framePath);
        const desc = await describeImageWithVision(
          apiKey,
          model,
          frameBytes,
          "image/jpeg",
          `This is frame ${i + 1} of 3 from a customer's video message. ` +
            `Describe what is visible: objects, people, products, text/signs, setting. Be concrete.`
        );
        frameDescriptions.push(`Frame ${i + 1}: ${desc}`);
      } catch (frameErr) {
        logger.warn("[media] frame extraction/description failed", { frame: i, error: frameErr instanceof Error ? frameErr.message : String(frameErr) });
      }
    }

    if (frameDescriptions.length === 0) {
      throw new Error("Could not extract any viewable frame from the video");
    }

    // Synthesize the frame notes into one understanding.
    const client = new OpenAI({ apiKey });
    const synthesis = await client.chat.completions.create({
      model: visionModelFor(model),
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content:
            "These are descriptions of 3 frames (start/middle/end) from a customer's video message to a business support agent. " +
            "Summarize what the video shows in 2-4 sentences, focusing on anything the customer might be asking about " +
            "(a product, a problem, a place, a person). If the frames suggest a product category, name it.\n\n" +
            frameDescriptions.join("\n"),
        },
      ],
    });
    return (
      synthesis.choices[0]?.message?.content?.trim() ??
      frameDescriptions.join("\n")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ffprobe") || msg.includes("ffmpeg") || /ENOENT/.test(msg)) {
      throw new Error(
        "Video understanding needs ffmpeg on the host, which is not installed. " +
          "Install ffmpeg to enable video messages (see OPERATIONS.md)."
      );
    }
    throw err;
  } finally {
    // Best-effort cleanup of temp files.
    try {
      const { readdir } = await import("fs/promises");
      for (const f of await readdir(workDir)) {
        await unlink(join(workDir, f)).catch(() => {});
      }
      const { rmdir } = await import("fs/promises");
      await rmdir(workDir).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

/**
 * Perceive one customer media attachment into text the brain can answer.
 * PHOTO -> vision identifies objects / product category.
 * VIDEO -> frame extraction + vision synthesis.
 * VOICE -> Whisper transcription.
 */
export async function perceiveMedia(
  apiKey: string,
  model: string,
  media: MediaInput,
  catalogHint?: string
): Promise<Perception> {
  if (media.kind === "audio") {
    const transcript = await transcribeAudio(apiKey, media.bytes, media.mimeType);
    return {
      kind: "audio",
      description: `[Voice message transcript]: "${transcript}"`,
    };
  }

  if (media.kind === "image") {
    const seen = await describeImageWithVision(
      apiKey,
      model,
      media.bytes,
      media.mimeType,
      "A customer sent this photo to a business support agent. " +
        "Describe exactly what you see: the main object/product, brand or text visible, colors, condition, setting. " +
        "If it looks like a purchasable product, state which category of product it most likely is. " +
        (catalogHint ? `The business sells: ${catalogHint}. If the photo matches one of these, say which.` : "")
    );
    return { kind: "image", description: `[Photo]: ${seen}` };
  }

  const understood = await describeVideo(apiKey, model, media.bytes, media.mimeType);
  return { kind: "video", description: `[Video]: ${understood}` };
}
