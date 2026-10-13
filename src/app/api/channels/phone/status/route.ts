import { NextRequest, NextResponse } from "next/server";
import { handleCallEnd } from "@/lib/channels/phone";
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
    const verified = await verifyTwilioRequest("phone/status", request, params);
    if (!verified.ok) return verified.response as NextResponse;

    const callSid = params.CallSid || "";
    const callDuration = parseInt(params.CallDuration || "0") || 0;
    const callStatus = params.CallStatus || "";

    if (callStatus === "completed" || callStatus === "failed" || callStatus === "no-answer") {
      await handleCallEnd(callSid, callDuration);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[Phone] Failed to handle call status:", error);
    return NextResponse.json({ ok: true });
  }
}
