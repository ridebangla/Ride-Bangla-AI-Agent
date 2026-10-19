import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { DEFAULT_ICP } from "@/lib/lead-engine";

const MAILBOX_PROVIDERS = ["gmail", "microsoft", "smtp", "none"];
const AI_BACKENDS = ["claude", "codex", "none"];

function sanitizeIcp(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 20)
      : [];
  return {
    industries: arr(r.industries),
    companySize: typeof r.companySize === "string" ? r.companySize.slice(0, 60) : "",
    titles: arr(r.titles),
    geography: arr(r.geography),
  };
}

/** Get (or lazily create) the tenant's Lead Engine settings. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "leads:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      let settings = await prisma.leadSettings.findFirst({});
      if (!settings) {
        settings = await prisma.leadSettings.create({
          data: { icp: DEFAULT_ICP } as never,
        });
      }
      // Never leak the mailbox secret to the client — only whether one is set.
      const { mailboxSecret: _secret, ...safe } = settings as Record<string, unknown>;
      return NextResponse.json({ ...safe, hasMailboxSecret: !!_secret });
    } catch (error) {
      logger.error("Failed to fetch lead settings:", error);
      return NextResponse.json(
        { error: "Failed to fetch lead settings" },
        { status: 500 }
      );
    }
  });
}

/** Update ICP + connect mailbox / AI backend credentials. */
export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request, "leads:write");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const data: Record<string, unknown> = {};

      if (body.icp !== undefined) data.icp = sanitizeIcp(body.icp);

      if (body.mailboxProvider !== undefined) {
        if (!MAILBOX_PROVIDERS.includes(body.mailboxProvider)) {
          return NextResponse.json({ error: "Invalid mailbox provider" }, { status: 400 });
        }
        data.mailboxProvider = body.mailboxProvider;
        // Switching provider disconnects until re-connected with credentials.
        data.mailboxConnected = false;
      }
      if (typeof body.mailboxUser === "string") {
        data.mailboxUser = body.mailboxUser.slice(0, 200);
      }
      if (typeof body.mailboxSecret === "string" && body.mailboxSecret.length > 0) {
        // Stored like settings.smtpPass (same existing pattern); a Secret
        // Manager migration is future work — see code comment there.
        data.mailboxSecret = body.mailboxSecret.slice(0, 500);
        data.mailboxConnected = true;
      }
      if (body.mailboxConnected === false) data.mailboxConnected = false;

      if (body.aiBackend !== undefined) {
        if (!AI_BACKENDS.includes(body.aiBackend)) {
          return NextResponse.json({ error: "Invalid AI backend" }, { status: 400 });
        }
        data.aiBackend = body.aiBackend;
        data.aiBackendConnected = body.aiBackend !== "none" && body.aiBackendConnected !== false
          ? body.aiBackendConnected === true
          : false;
      }
      if (typeof body.maxDailySends === "number") {
        data.maxDailySends = Math.max(1, Math.min(500, Math.floor(body.maxDailySends)));
      }
      if (typeof body.requireApproval === "boolean") {
        // The approval gate is structural and cannot be disabled from the UI.
        // (Harvey's require_approval stays true — nothing sends without a human.)
        data.requireApproval = true;
      }

      let settings = await prisma.leadSettings.findFirst({});
      if (!settings) {
        settings = await prisma.leadSettings.create({ data: { icp: DEFAULT_ICP, ...data } as never });
      } else {
        settings = await prisma.leadSettings.update({
          where: { id: settings.id },
          data: data as never,
        });
      }
      const { mailboxSecret: _secret, ...safe } = settings as Record<string, unknown>;
      return NextResponse.json({ ...safe, hasMailboxSecret: !!_secret });
    } catch (error) {
      logger.error("Failed to update lead settings:", error);
      return NextResponse.json(
        { error: "Failed to update lead settings" },
        { status: 500 }
      );
    }
  });
}
