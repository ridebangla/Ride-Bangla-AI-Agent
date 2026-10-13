import { NextRequest, NextResponse } from "next/server";
import { handleIncomingCall } from "@/lib/channels/phone";
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
    const verified = await verifyTwilioRequest("phone/incoming", request, params);
    if (!verified.ok) return verified.response as NextResponse;

    const from = params.From || "";
    const callSid = params.CallSid || "";

    const twiml = await handleIncomingCall(from, callSid);

    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    logger.error("[Phone] Failed to handle incoming call:", error);
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred. Please try again later.</Say></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  }
}
