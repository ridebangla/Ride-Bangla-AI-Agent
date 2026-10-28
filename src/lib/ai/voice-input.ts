/**
 * STAGED ONLY — Presswayy-video round 2, Leg A (customer voice-message
 * understanding). NOT pushed, NOT deployed, NOT wired into any live route
 * by this file alone. Target path on merge: `src/lib/ai/voice-input.ts`.
 *
 * Base HEAD (re-verified live, GitHub API, 2026-10-25):
 *   ridebangla/Ride-Bangla-AI-Agent @ 706df0fd…
 *
 * What this module is: the PURE decision layer for "a customer voice
 * message in chat is understood by the agent and answered in TEXT like
 * any other message". It has ZERO imports on purpose, so it can be
 * unit-tested without Firestore, providers, or Next.js:
 *
 *   audio bytes (downloaded by a channel handler)
 *     -> transcription (provider Whisper, owner's launch-step key)
 *     -> THIS MODULE decides: route the transcript into the EXISTING
 *        engine/message path, or answer with an honest fallback
 *     -> text reply out through the channel's existing sender
 *
 * What it is NOT:
 * - NOT a second engine. Routing means: hand the transcript to the
 *   existing `chat()` / `processChannelMessage()` path, exactly as a
 *   typed message travels. No new model call, no new tool, no new
 *   order path is created here.
 * - NOT read-aloud (text-to-speech reply) and NOT voice-bubble media
 *   rendering — those belong to the earlier voice/media batch and are
 *   deliberately not redone here.
 * - NOT AI voice calls or call recordings (owner-excluded).
 * - NOT chat-teaching / business learning. A voice transcript is a
 *   customer message to be answered, not knowledge to be indexed.
 *
 * Honesty rules enforced here (never relaxed by callers):
 * - An empty, whitespace-only, or missing transcript is NEVER guessed
 *   at: it becomes the `unintelligible` fallback, and the agent asks
 *   the customer to type the message instead.
 * - A missing provider key is NEVER papered over with a fake reply:
 *   it becomes the `no_key` fallback.
 * - A failed audio download is NEVER silently dropped: it becomes the
 *   `download_failed` fallback, sent as text, so the customer is not
 *   left in silence.
 * - No transcript content is ever invented, completed, or "cleaned up"
 *   by this module: the routed transcript is the provider text,
 *   trimmed, verbatim.
 * - Audio bytes are NEVER persisted by this module or by the staged
 *   channel diffs: bytes live in memory only, exactly like the widget
 *   voice route at HEAD. How long transcripts (stored as ordinary
 *   customer messages by the existing chat path) are kept is an
 *   OWNER DECISION — flagged in LEG-REPORT.md, not silently picked.
 *
 * Language handling — follows the EXISTING script-based detection,
 * nothing invented:
 * - HEAD `src/lib/ai/behaviour.ts` (`detectBengali`, Bengali-script
 *   regex U+0980–U+09FF; `resolveBehaviourLang`: business setting
 *   "bn"/"en" wins, else Bengali script -> "bn", else "en") is the
 *   only language detection that exists at HEAD. `detectVoiceReplyLang`
 *   below mirrors that rule purely, so fallback strings render in the
 *   conversation's language. Route code that already runs inside a
 *   business context SHOULD prefer the real `resolveBehaviourLang`
 *   where it can; this pure copy exists for the harness and for
 *   handlers that only have prior text.
 * - GAP, flagged not invented: the transcription seam at HEAD
 *   (`transcribeAudioWithFallback`) returns a bare string — it does
 *   NOT surface the provider's detected language. The platform
 *   therefore cannot today distinguish "transcribed in a language the
 *   business does not serve" from "transcribed fine". This module
 *   does NOT invent a language gate on script: a non-empty transcript
 *   in any script routes exactly like a typed message in that script
 *   would (typed non-Bengali text today also gets an English reply
 *   under `resolveBehaviourLang`). Adding a provider-language
 *   allowlist is an owner/platform decision, listed in LEG-REPORT.md.
 *
 * Confirmation guard — the agent never confirms alone:
 * - At HEAD the agent tool list (11 tools in `src/lib/ai/tools.ts`)
 *   contains NO confirm / approve / status / cancel tool, and
 *   `take_order` creates a PENDING order only; only a human dashboard
 *   action confirms. A voice transcript therefore cannot confirm
 *   anything by itself: it travels the same `chat()` path as typed
 *   text, with the same tool surface. `isConfirmAction` exists so
 *   future voice wiring can assert that no voice turn ever invokes a
 *   confirm-class action, and so the harness can pin that rule.
 *
 * Doctrines kept (see LEG-REPORT.md for the full list):
 * - Per-surface identity: transcripts are answered as the tenant's
 *   business, never as Ride Bangla; nothing here touches identity.
 * - Confirmed = locked: untouched; voice turns create no confirmed
 *   record of any kind.
 * - Review doctrine: untouched; no review is requested, fabricated,
 *   or suppressed by voice handling.
 * - Limit model: voice turns travel `processChannelMessage`, which
 *   applies the existing subscription / message-limit hard-stops
 *   before any LLM spend; no new meter is invented here. (Company =
 *   unlimited, trial = no usage quotas, free tier ~= 100 msgs/month
 *   — all enforced by the existing path, not by this module.)
 * - No invented copy: every user-facing string below is a PROPOSAL
 *   for owner approval, never silently shipped wording.
 * - No fare quoting, no stock guessing: transcripts are customer
 *   words, not prices; stock answers come from the inventory batch's
 *   stock truth via the existing engine, never from this module.
 */

/** Reply language for voice fallback strings. Mirrors BehaviourLang. */
export type VoiceReplyLang = "bn" | "en";

/** Bengali-script range — copied from HEAD behaviour.ts, not invented. */
const BENGALI_SCRIPT = /[\u0980-\u09FF]/; // same range as HEAD behaviour.ts

/**
 * Mirror of HEAD `resolveBehaviourLang` (behaviour.ts), pure form.
 * Business setting "bn"/"en" wins; otherwise Bengali script -> "bn",
 * anything else -> "en" (the existing fail-safe default).
 */
export function detectVoiceReplyLang(
  settingsLanguage: string | undefined,
  priorOrTranscriptText: string
): VoiceReplyLang {
  if (settingsLanguage === "bn") return "bn";
  if (settingsLanguage === "en") return "en";
  return BENGALI_SCRIPT.test(priorOrTranscriptText || "") ? "bn" : "en";
}

/** Maximum voice bytes a channel handler may transcribe. Mirrors the
 *  widget voice route at HEAD (10 MB). This is an abuse safeguard,
 *  NOT a plan quota. */
export const VOICE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** Result of validating downloaded voice bytes before transcription. */
export type VoiceAudioValidation =
  | { ok: true }
  | { ok: false; error: "audio_missing" | "unsupported_audio" | "audio_too_large" };

/**
 * Validate audio bytes the way the widget voice route does: present,
 * an audio/* mime, within the size cap. Anything else is refused
 * BEFORE any provider spend, with a machine-coded reason.
 */
export function validateVoiceAudio(
  mimeType: string | undefined,
  byteLength: number
): VoiceAudioValidation {
  if (!byteLength || byteLength <= 0) return { ok: false, error: "audio_missing" };
  if (!mimeType || !mimeType.toLowerCase().startsWith("audio/")) {
    return { ok: false, error: "unsupported_audio" };
  }
  if (byteLength > VOICE_MAX_AUDIO_BYTES) {
    return { ok: false, error: "audio_too_large" };
  }
  return { ok: true };
}

/**
 * Why a voice turn did NOT route to the engine. Machine codes only —
 * user-facing wording lives in `voiceFallbackStrings` (PROPOSAL).
 */
export type VoiceFallbackReason =
  | "no_key"
  | "unintelligible"
  | "download_failed"
  | "unsupported_audio";

/** The single routing decision for one customer voice message. */
export type VoiceTurnDecision =
  | {
      kind: "route";
      /** Provider transcript, trimmed, verbatim — never edited. */
      transcript: string;
      replyLang: VoiceReplyLang;
    }
  | { kind: "fallback"; reason: VoiceFallbackReason; replyLang: VoiceReplyLang };

export interface VoiceTurnInput {
  /** True when the channel handler actually obtained audio bytes. */
  audioDownloaded: boolean;
  /** True when at least one provider key resolves (owner's launch step). */
  providerKeyPresent: boolean;
  /** Provider transcript, or null when transcription threw / no key. */
  transcript: string | null;
  /** Business language setting ("bn"/"en"/other), when known. */
  settingsLanguage?: string;
  /** Prior customer text in the thread, for script detection fallback. */
  priorCustomerText?: string;
  /** Audio validation outcome, when the handler already validated. */
  audioValidation?: VoiceAudioValidation;
}

/**
 * Decide one voice turn. Order matters and is fail-closed:
 *  1. No bytes (download failed) -> fallback, never silence.
 *  2. Invalid audio (wrong mime / too large) -> fallback, never spend.
 *  3. No provider key -> fallback, never a fake reply.
 *  4. Empty / whitespace-only transcript -> `unintelligible` fallback,
 *     NEVER a guess at what the customer said.
 *  5. Anything else -> route the verbatim transcript to the existing
 *     engine/message path, exactly like typed text.
 */
export function decideVoiceTurn(input: VoiceTurnInput): VoiceTurnDecision {
  const replyLang = detectVoiceReplyLang(
    input.settingsLanguage,
    input.priorCustomerText || ""
  );
  if (!input.audioDownloaded) {
    return { kind: "fallback", reason: "download_failed", replyLang };
  }
  if (input.audioValidation && !input.audioValidation.ok) {
    return { kind: "fallback", reason: "unsupported_audio", replyLang };
  }
  if (!input.providerKeyPresent) {
    return { kind: "fallback", reason: "no_key", replyLang };
  }
  const transcript = (input.transcript || "").trim();
  if (!transcript) {
    return { kind: "fallback", reason: "unintelligible", replyLang };
  }
  return { kind: "route", transcript, replyLang };
}

/**
 * Customer-facing fallback wording. PROPOSAL ONLY — owner approval
 * required before any of this ships. Meanings mirror the widget voice
 * route's existing honest strings at HEAD; the channel variants never
 * mention dashboard settings to the customer beyond what the widget
 * route already says.
 */
export function voiceFallbackStrings(lang: VoiceReplyLang): Record<VoiceFallbackReason, string> {
  if (lang === "bn") {
    return {
      no_key:
        "আমি এখনো ভয়েস মেসেজ শুনতে পারছি না। অনুগ্রহ করে আপনার মেসেজটি লিখে পাঠান, আমি সাথে সাথে উত্তর দেব।",
      unintelligible:
        "আমি ভয়েস মেসেজটা বুঝতে পারলাম না। আবার রেকর্ড করে পাঠাবেন, অথবা লিখে পাঠান।",
      download_failed:
        "ভয়েস মেসেজটা ডাউনলোড করতে পারলাম না। আবার পাঠাবেন, অথবা লিখে পাঠান।",
      unsupported_audio:
        "এই ধরনের অডিও আমি শুনতে পারছি না। অনুগ্রহ করে আপনার মেসেজটি লিখে পাঠান।",
    };
  }
  return {
    no_key:
      "I can't listen to voice messages yet. Please type your message instead and I'll answer right away.",
    unintelligible:
      "I couldn't understand that voice message. Could you record it again, or type it instead?",
    download_failed:
      "I couldn't download that voice message. Could you send it again, or type it instead?",
    unsupported_audio:
      "I can't listen to this kind of audio. Please type your message instead.",
  };
}

/**
 * Honest stored marker for a voice turn that did NOT route, mirroring
 * the widget voice route's markers at HEAD. The marker is what staff
 * see in the thread; it is never fed to the engine as customer words,
 * and it never pretends to be a transcript.
 */
export function voiceFailureCustomerNote(reason: VoiceFallbackReason): string {
  switch (reason) {
    case "no_key":
      return "(sent a voice message — voice listening not connected)";
    case "unintelligible":
      return "(sent a voice message — transcription failed)";
    case "download_failed":
      return "(sent a voice message — audio download failed)";
    case "unsupported_audio":
      return "(sent a voice message — unsupported audio)";
  }
}

/**
 * Confirm-class action names a voice turn must NEVER invoke. Voice
 * turns flow through `chat()` only, and at HEAD no such tool exists
 * in the agent tool list at all — this list is defense-in-depth for
 * any future wiring, pinned by the harness.
 */
const CONFIRM_ACTION_NAMES: ReadonlyArray<string> = [
  "confirm_order",
  "approve_order",
  "confirm_booking",
  "approve_booking",
  "set_order_status",
  "cancel_order",
  "cancel_booking",
  "mark_order_confirmed",
];

/** True when the named action would confirm / decide a record. */
export function isConfirmAction(actionName: string): boolean {
  return CONFIRM_ACTION_NAMES.includes((actionName || "").trim());
}

/**
 * Guard: a voice turn's only permitted route target is the existing
 * chat/message path. Anything else (a confirm path, an order writer,
 * a billing call) is refused by construction — callers assert this.
 */
export type VoiceRouteTarget = "chat";

export function assertVoiceRouteTarget(target: string): VoiceRouteTarget {
  if (target !== "chat") {
    throw new Error(
      `voice turn refused: route target must be the existing chat path, got "${target}"`
    );
  }
  return "chat";
}

// ---------------------------------------------------------------------------
// Channel-event classifiers (pure; the channel diffs consume these so the
// "is this a voice message?" decision is tested, not hand-rolled twice).
// ---------------------------------------------------------------------------

/** Minimal shape of a Meta messaging-event message we care about. */
export interface MetaMessageShape {
  text?: string;
  attachments?: Array<{ type?: string; payload?: { url?: string } }>;
}

/**
 * Extract a Meta (Messenger / Instagram) audio attachment, if any.
 * Returns null for text-only messages, images, stickers, and every
 * other attachment type — voice handling must never trigger on them.
 */
export function extractMetaAudioAttachment(
  message: MetaMessageShape | undefined | null
): { url: string } | null {
  if (!message?.attachments) return null;
  for (const att of message.attachments) {
    if (att?.type === "audio" && att.payload?.url) {
      return { url: att.payload.url };
    }
  }
  return null;
}

/** Minimal shape of a WhatsApp Cloud message we care about. */
export interface CloudMessageShape {
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string };
}

/**
 * Extract a WhatsApp Cloud audio message's media id, if any.
 * Text messages and every other type return null.
 */
export function extractCloudAudioMessage(
  message: CloudMessageShape | undefined | null
): { mediaId: string; mimeType: string | undefined } | null {
  if (!message || message.type !== "audio") return null;
  if (!message.audio?.id) return null;
  return { mediaId: message.audio.id, mimeType: message.audio.mime_type };
}
