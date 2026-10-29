import OpenAI from "openai";
import { prisma, withBusinessId } from "@/lib/prisma";
import { enterBusinessContext, resolveChannelBusiness } from "@/lib/tenant";
import { createNewConversation } from "@/lib/ai/engine";
import { processChannelMessage } from "@/lib/channels/inbound";
import { resolveCustomer } from "@/lib/customer-resolver";

interface PhoneConfig {
  twilioSid: string;
  twilioToken: string;
  twilioPhone: string;
  elevenLabsKey: string;
  elevenLabsVoice: string;
  aiApiKey: string;
}

async function getPhoneConfig(): Promise<PhoneConfig | null> {
  const settings = await prisma.settings.findFirst();

  // The channels dashboard saves Twilio details on the channel doc;
  // prefer them when complete, so what the tenant saves is what runs.
  // The settings-page Twilio section stays as the fallback. aiApiKey is
  // not a dashboard field, so it always keeps coming from settings.
  try {
    const businessId = await resolveChannelBusiness();
    const doc = await prisma.channel.findUnique({
      where: { id: `${businessId}:phone` },
    });
    const cfg = (doc as { config?: Record<string, unknown> } | null)?.config;
    if (cfg?.twilioSid && cfg?.twilioToken) {
      return {
        twilioSid: String(cfg.twilioSid),
        twilioToken: String(cfg.twilioToken),
        twilioPhone: String(cfg.twilioPhone || ""),
        elevenLabsKey: String(cfg.elevenLabsKey || ""),
        elevenLabsVoice: String(cfg.elevenLabsVoice || ""),
        aiApiKey: settings?.aiApiKey || "",
      };
    }
  } catch {
    // Channel-doc read failed: fall through to the settings doc.
  }

  if (!settings?.twilioSid || !settings?.twilioToken) return null;

  return {
    twilioSid: settings.twilioSid,
    twilioToken: settings.twilioToken,
    twilioPhone: settings.twilioPhone,
    elevenLabsKey: settings.elevenLabsKey,
    elevenLabsVoice: settings.elevenLabsVoice,
    aiApiKey: settings.aiApiKey,
  };
}

// Speech-to-Text using OpenAI Whisper
export async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string
): Promise<string> {
  const openai = new OpenAI({ apiKey });

  const file = new File([new Uint8Array(audioBuffer)], "audio.wav", { type: "audio/wav" });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });

  return transcription.text;
}

// Text-to-Speech using ElevenLabs — female voices ONLY (owner rule,
// 2026-10-29, firmest form): an ALLOWLIST, not a denylist. The old
// choke point mapped only the two known male ids (drew, clyde) to
// Rachel and passed every other saved id through unchecked — any
// other male ElevenLabs voice id a tenant pasted in would have
// spoken. Now only the three female voices the dashboard itself
// offers (Rachel / Domi / Bella) can ever speak; anything else —
// an old male id, an unknown id, an empty string — resolves to
// Rachel, the first female voice. No male voice can enter here,
// in any path, in any language.
const FEMALE_VOICE_IDS = new Set(["rachel", "domi", "bella"]);
export async function synthesizeSpeech(
  text: string,
  apiKey: string,
  voiceId: string
): Promise<Buffer> {
  const safeVoiceId = FEMALE_VOICE_IDS.has(voiceId.toLowerCase())
    ? voiceId.toLowerCase()
    : "rachel";
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${safeVoiceId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Generate TwiML response for incoming calls
export function generateTwiMLGather(
  message: string,
  callbackUrl: string
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(message)}</Say>
  <Gather input="speech" action="${callbackUrl}" method="POST" speechTimeout="auto" language="auto">
    <Say voice="alice">I'm listening.</Say>
  </Gather>
  <Say voice="alice">I didn't hear anything. Goodbye.</Say>
</Response>`;
}

export function generateTwiMLSay(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(message)}</Say>
  <Gather input="speech" action="/api/channels/phone/gather" method="POST" speechTimeout="auto" language="auto">
    <Say voice="alice">Is there anything else I can help with?</Say>
  </Gather>
  <Say voice="alice">Thank you for calling. Goodbye.</Say>
</Response>`;
}

export function generateTwiMLStream(websocketUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${websocketUrl}" />
  </Connect>
</Response>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Handle incoming call
export async function handleIncomingCall(
  from: string,
  callSid: string
): Promise<string> {
  enterBusinessContext(await resolveChannelBusiness());
  const config = await getPhoneConfig();
  if (!config) {
    return generateTwiMLSay(
      "Sorry, the phone system is not properly configured. Please try again later."
    );
  }

  // Create call log
  await prisma.callLog.create({
    data: withBusinessId({
      callSid,
      from,
      to: config.twilioPhone,
      status: "in-progress",
    }),
  });

  // Resolve customer identity across channels
  const customerId = await resolveCustomer("phone", from, "Phone Caller");

  // Create or find conversation
  let conversation = await prisma.conversation.findFirst({
    where: {
      channel: "phone",
      status: { in: ["active", "escalated"] },
      OR: [
        { customerId },
        { customerContact: from },
      ],
    },
  });

  if (!conversation) {
    conversation = await createNewConversation("phone", "Phone Caller", from, customerId);
  }

  const settings = await prisma.settings.findFirst();
  const welcomeMessage =
    settings?.welcomeMessage || "Hello! How can I help you today?";

  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/channels/phone/gather?conversationId=${conversation.id}&callSid=${callSid}`;

  return generateTwiMLGather(welcomeMessage, callbackUrl);
}

// Handle speech input during call
export async function handleSpeechInput(
  speechResult: string,
  conversationId: string,
  callSid: string
): Promise<string> {
  const businessId = await resolveChannelBusiness();
  enterBusinessContext(businessId);
  if (!speechResult || speechResult.trim() === "") {
    return generateTwiMLSay("I didn't catch that. Could you please repeat?");
  }

  // Get AI response
  let aiResponse: string;
  try {
    // Phase 5: shared inbound pipeline — subscription hard-stop (user
    // decision 16) first, then the engine (honors per-conversation +
    // global aiEnabled, user decision 17). On human takeover or an
    // inactive subscription the pipeline stored the message in silence —
    // a live call still needs a TwiML answer, so use a static handoff
    // line (never an AI-generated reply).
    const chatResult = await processChannelMessage(conversationId, businessId, speechResult);
    aiResponse = chatResult.silent
      ? "Let me connect you with someone from the team."
      : chatResult.response;
  } catch {
    return generateTwiMLSay("I'm sorry, I'm having trouble right now. Please try again or hold for an agent.");
  }

  // Update call log
  await prisma.callLog.updateMany({
    where: { callSid },
    data: { status: "in-progress" },
  });

  return generateTwiMLSay(aiResponse);
}

// End call handler
export async function handleCallEnd(callSid: string, duration: number) {
  enterBusinessContext(await resolveChannelBusiness());
  await prisma.callLog.updateMany({
    where: { callSid },
    data: {
      status: "completed",
      duration,
    },
  });
}

// Derived from the real config (channel doc first, settings fallback —
// see getPhoneConfig). Previously this was hardcoded to disconnected,
// so the phone row could never show connected. Note: this is now async;
// no caller was found in the dashboard or API routes fetched for this
// batch, so the signature change breaks nothing known — a future sync
// caller must await it.
export async function getPhoneStatus() {
  const config = await getPhoneConfig();
  const configured = Boolean(config?.twilioSid && config?.twilioToken);
  return {
    configured,
    status: configured ? "connected" : ("disconnected" as const),
  };
}

