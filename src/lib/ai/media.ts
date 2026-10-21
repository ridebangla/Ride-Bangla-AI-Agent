import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "../logger";
import {
  completeTextWithFallback,
  describeImageWithFallback,
  transcribeAudioWithFallback,
  type ProviderKeys,
} from "./providers";

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

/**
 * Describe one image with the provider chain (OpenAI / Groq vision /
 * Gemini). `keys` are the site's resolved ProviderKeys — never a bare key
 * string, so callers can't accidentally leak one.
 */
export async function describeImageWithVision(
  keys: ProviderKeys,
  model: string,
  bytes: Buffer,
  mimeType: string,
  question: string
): Promise<string> {
  const result = await describeImageWithFallback(
    keys,
    { bytes, mimeType },
    question,
    { model, label: "vision" }
  );
  if (!result) throw new Error("No AI provider key configured");
  return result.text;
}

/** Best-effort audio transcription with provider failover (Whisper on
 *  OpenAI/Groq, native transcription on Gemini). */
export async function transcribeAudio(
  keys: ProviderKeys,
  bytes: Buffer,
  mimeType: string
): Promise<string> {
  const text = await transcribeAudioWithFallback(keys, { bytes, mimeType }, { label: "voice" });
  if (!text) throw new Error("No AI provider key configured");
  return text;
}

/**
 * Understand a video by extracting representative frames and describing them
 * with vision. Requires `ffmpeg` on the host (documented in OPERATIONS.md).
 * Frames at ~10%, 50%, 90% give start/middle/end coverage of short clips.
 */
export async function describeVideo(
  keys: ProviderKeys,
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
          keys,
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

    // Synthesize the frame notes into one understanding (provider chain).
    const synthesis = await completeTextWithFallback(
      keys,
      "These are descriptions of 3 frames (start/middle/end) from a customer's video message to a business support agent. " +
        "Summarize what the video shows in 2-4 sentences, focusing on anything the customer might be asking about " +
        "(a product, a problem, a place, a person). If the frames suggest a product category, name it.\n\n" +
        frameDescriptions.join("\n"),
      { maxTokens: 400, model, label: "video-synthesis" }
    );
    return synthesis?.text ?? frameDescriptions.join("\n");
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
 * Perceive a video whose frames were extracted IN THE BROWSER (media
 * fix 2026-10-22). Server-side frame extraction needs ffmpeg, which
 * does not exist on the serverless production host, so the widget now
 * decodes the customer's video client-side (every browser can play the
 * file it was handed), captures representative frames as JPEGs, and
 * posts those. Each frame goes through the same vision chain as a
 * photo; the frame notes are then synthesized exactly like
 * describeVideo() synthesizes its ffmpeg frames.
 */
export async function perceiveVideoFrames(
  keys: ProviderKeys,
  model: string,
  frames: Array<{ bytes: Buffer; mimeType: string }>,
  catalogHint?: string
): Promise<Perception> {
  if (frames.length === 0) {
    throw new Error("No video frames were provided");
  }
  const frameDescriptions: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const desc = await describeImageWithVision(
      keys,
      model,
      frames[i].bytes,
      frames[i].mimeType || "image/jpeg",
      `This is frame ${i + 1} of ${frames.length} from a customer's video message. ` +
        `Describe what is visible: objects, people, products, text/signs, setting. Be concrete.` +
        (catalogHint ? ` The business sells: ${catalogHint}. If the frame matches one of these, say which.` : "")
    );
    frameDescriptions.push(`Frame ${i + 1}: ${desc}`);
  }

  const synthesis = await completeTextWithFallback(
    keys,
    "These are descriptions of frames (start/middle/end) from a customer's video message to a business support agent. " +
      "Summarize what the video shows in 2-4 sentences, focusing on anything the customer might be asking about " +
      "(a product, a problem, a place, a person). If the frames suggest a product category, name it.\n\n" +
      frameDescriptions.join("\n"),
    { maxTokens: 400, model, label: "video-synthesis" }
  );
  return {
    kind: "video",
    description: `[Video]: ${synthesis?.text ?? frameDescriptions.join("\n")}`,
  };
}

/**
 * Perceive one customer media attachment into text the brain can answer.
 * PHOTO -> vision identifies objects / product category.
 * VIDEO -> frame extraction + vision synthesis.
 * VOICE -> Whisper transcription.
 */
export async function perceiveMedia(
  keys: ProviderKeys,
  model: string,
  media: MediaInput,
  catalogHint?: string
): Promise<Perception> {
  if (media.kind === "audio") {
    const transcript = await transcribeAudio(keys, media.bytes, media.mimeType);
    return {
      kind: "audio",
      description: `[Voice message transcript]: "${transcript}"`,
    };
  }

  if (media.kind === "image") {
    const seen = await describeImageWithVision(
      keys,
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

  const understood = await describeVideo(keys, model, media.bytes, media.mimeType);
  return { kind: "video", description: `[Video]: ${understood}` };
}
