import { NextRequest, NextResponse } from "next/server";
import { handleIncomingSms } from "@/lib/channels/sms";
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
    const verified = await verifyTwilioRequest("sms", request, params);
    if (!verified.ok) return verified.response as NextResponse;

    const from = params.From || "";
    const body = params.Body || "";

    const response = await handleIncomingSms(from, body);

    // Phase 3 (user decision 17): human takeover — the pipeline stored the
    // message in pure silence. Answer with empty TwiML so Twilio sends no
    // reply SMS at all.
    if (!response) {
      return new NextResponse(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { "Content-Type": "text/xml" } }
      );
    }

    // Return TwiML response
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${response}</Message></Response>`;

    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    logger.error("[SMS] Failed to handle incoming SMS:", error);
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>An error occurred.</Message></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  }
}

