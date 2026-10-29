import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

// Phone (AI Call) actions: test / connect / disconnect.
//
// "test" only VERIFIES the Twilio credentials with read-only Twilio API
// calls. It never places a call — the dashboard button used to show a
// fake "Test call initiated" note without calling anything, while the
// POST itself 404'd (no route existed here at all).
//
// "connect" verifies first, then marks the channel row connected, so the
// badge reflects verified credentials. Live call handling reads the same
// saved config; the Twilio webhook signature check is a separate module
// and is untouched by this route.
//
// Credentials are never logged and never appear in any response message.

interface TwilioCheck {
  ok: boolean;
  message: string;
  warning?: string;
}

async function verifyTwilio(
  sid: string,
  token: string,
  phone: string
): Promise<TwilioCheck> {
  if (!sid || !token) {
    return {
      ok: false,
      message: "Enter the Twilio Account SID and Auth Token first.",
    };
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };
  let accountRes: Response;
  try {
    accountRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
  } catch {
    return {
      ok: false,
      message: "Could not reach Twilio. Check the connection and try again.",
    };
  }
  if (!accountRes.ok) {
    return {
      ok: false,
      message:
        "Twilio rejected these credentials. Check the Account SID and Auth Token, then try again.",
    };
  }
  if (phone) {
    // Best-effort number check (first page only): a number the account
    // owns on a later page warns instead of failing the whole check.
    try {
      const numsRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=50`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (numsRes.ok) {
        const data = await numsRes.json();
        const numbers = (data.incoming_phone_numbers || []) as Array<{
          phone_number?: string;
        }>;
        if (!numbers.some((n) => n.phone_number === phone)) {
          return {
            ok: true,
            message: "Twilio credentials verified.",
            warning: `Connected to Twilio, but ${phone} was not found among this account's numbers. Check the number, then Save.`,
          };
        }
      }
    } catch {
      // Number-list failure does not invalidate verified credentials.
    }
  }
  return { ok: true, message: "Twilio credentials verified." };
}

async function readSavedPhoneConfig(businessId: string): Promise<{
  twilioSid: string;
  twilioToken: string;
  twilioPhone: string;
} | null> {
  const doc = await prisma.channel.findUnique({
    where: { id: `${businessId}:phone` },
  });
  const cfg = (doc as { config?: Record<string, unknown> } | null)?.config;
  if (!cfg?.twilioSid || !cfg?.twilioToken) return null;
  return {
    twilioSid: String(cfg.twilioSid),
    twilioToken: String(cfg.twilioToken),
    twilioPhone: String(cfg.twilioPhone || ""),
  };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "channels:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    const body = await request.json();
    const { action } = body;
    const channelId = `${auth.businessId}:phone`;

    if (action === "test") {
      // Tests exactly what the dashboard passes (the form's current
      // values); falls back to the saved row when nothing is passed.
      // Nothing is saved by a test.
      const passed =
        body.config && typeof body.config === "object" ? body.config : null;
      const cfg = passed
        ? {
            twilioSid: String(passed.twilioSid || ""),
            twilioToken: String(passed.twilioToken || ""),
            twilioPhone: String(passed.twilioPhone || ""),
          }
        : await readSavedPhoneConfig(auth.businessId);
      if (!cfg) {
        return NextResponse.json(
          { error: "Save your Twilio details first, then test." },
          { status: 400 }
        );
      }
      const result = await verifyTwilio(
        cfg.twilioSid,
        cfg.twilioToken,
        cfg.twilioPhone
      );
      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      return NextResponse.json({
        message: result.warning || result.message,
      });
    }

    if (action === "connect") {
      // Connect verifies the SAVED row (the listener pipeline reads saved
      // config, so connecting unsaved edits would verify the wrong thing;
      // the card guards this with "Save your details first").
      const saved = await readSavedPhoneConfig(auth.businessId);
      if (!saved) {
        return NextResponse.json(
          { error: "Save your Twilio details first, then Connect." },
          { status: 400 }
        );
      }
      const result = await verifyTwilio(
        saved.twilioSid,
        saved.twilioToken,
        saved.twilioPhone
      );
      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      const updated = await prisma.channel.upsert({
        where: { id: channelId },
        update: { status: "connected" },
        create: {
          id: channelId,
          businessId: auth.businessId,
          type: "phone",
          config: {},
          isActive: false,
          status: "connected",
        },
      });
      return NextResponse.json(
        result.warning ? { ...updated, message: result.warning } : updated
      );
    }

    if (action === "disconnect") {
      const updated = await prisma.channel.upsert({
        where: { id: channelId },
        update: { status: "disconnected" },
        create: {
          id: channelId,
          businessId: auth.businessId,
          type: "phone",
          config: {},
          isActive: false,
          status: "disconnected",
        },
      });
      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  });
}
