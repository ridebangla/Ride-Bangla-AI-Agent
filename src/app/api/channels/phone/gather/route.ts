import { NextRequest, NextResponse } from "next/server";
import { handleSpeechInput } from "@/lib/channels/phone";
import { verifyTwilioRequest } from "@/lib/twilio-verify";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = String(value);
    });

    // M-52: fail-closed Twilio verification — unset token now rejects (403)
    // instead of silently skipping verification.
    const verified = await verifyTwilioRequest("phone/gather", request, params);
    if (!verified.ok) return verified.response as NextResponse;

    const speechResult = params.SpeechResult || "";
    const conversationId = request.nextUrl.searchParams.get("conversationId") || "";
    const callSid = request.nextUrl.searchParams.get("callSid") || params.CallSid || "";

    const twiml = await handleSpeechInput(speechResult, conversationId, callSid);

    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    logger.error("[Phone] Failed to handle speech input:", error);
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">An error occurred. Please try again.</Say></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  }
}
