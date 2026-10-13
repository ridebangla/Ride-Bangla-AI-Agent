import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/channels/sms", () => ({
  handleIncomingSms: vi.fn().mockResolvedValue("sms reply"),
}));
vi.mock("@/lib/channels/phone", () => ({
  handleIncomingCall: vi.fn().mockResolvedValue("<Response/>"),
  handleSpeechInput: vi.fn().mockResolvedValue("<Response/>"),
  handleCallEnd: vi.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

const TOKEN = "twilio-test-auth-token";

function twilioSignature(url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], "");
  return crypto.createHmac("sha1", TOKEN).update(data, "utf-8").digest("base64");
}

function formRequest(
  path: string,
  params: Record<string, string>,
  headers: Record<string, string> = {}
): NextRequest {
  const body = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

const ROUTES = [
  { path: "/api/channels/sms", params: { From: "+1555000111", Body: "hello" }, module: "@/app/api/channels/sms/route" },
  { path: "/api/channels/phone/incoming", params: { From: "+1555000111", CallSid: "CA123" }, module: "@/app/api/channels/phone/incoming/route" },
  { path: "/api/channels/phone/gather", params: { SpeechResult: "yes", CallSid: "CA123" }, module: "@/app/api/channels/phone/gather/route" },
  { path: "/api/channels/phone/status", params: { CallSid: "CA123", CallStatus: "completed", CallDuration: "30" }, module: "@/app/api/channels/phone/status/route" },
] as const;

describe("Twilio fail-closed verification (M-52)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(ROUTES)(
    "rejects $path with 403 when twilioToken is unset (fail-closed)",
    async ({ path, params, module }) => {
      mockPrisma.settings.findFirst.mockResolvedValue({ twilioToken: "" });
      const { POST } = await import(module);
      const response = await POST(formRequest(path, params));
      expect(response.status).toBe(403);
    }
  );

  it.each(ROUTES)(
    "rejects $path with 403 on an invalid signature",
    async ({ path, params, module }) => {
      mockPrisma.settings.findFirst.mockResolvedValue({ twilioToken: TOKEN });
      const { POST } = await import(module);
      const response = await POST(
        formRequest(path, params, { "x-twilio-signature": "bogus" })
      );
      expect(response.status).toBe(403);
    }
  );

  it.each(ROUTES)(
    "accepts $path with a valid signature",
    async ({ path, params, module }) => {
      mockPrisma.settings.findFirst.mockResolvedValue({ twilioToken: TOKEN });
      const { POST } = await import(module);
      const url = `http://localhost:3000${path}`;
      const response = await POST(
        formRequest(path, params, {
          "x-twilio-signature": twilioSignature(url, params),
        })
      );
      expect(response.status).not.toBe(403);
    }
  );
});
