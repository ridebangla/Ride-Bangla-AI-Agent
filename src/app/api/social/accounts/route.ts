import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  encryptToken,
  isSupportedPlatform,
  maskToken,
} from "@/lib/social/accounts";

function toPublic(account: {
  id: string;
  platform: string;
  label: string;
  accountRef: string;
  autoReply: boolean;
  isActive: boolean;
  lastSyncAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: account.id,
    platform: account.platform,
    label: account.label,
    accountRef: account.accountRef,
    tokenHint: maskToken(account),
    // Phase 5 (user decision 6): fail-closed — missing (pre-Phase-5
    // accounts) means NO auto-post, only AI-drafted replies for approval.
    autoReply: account.autoReply === true,
    isActive: account.isActive,
    lastSyncAt: account.lastSyncAt,
    createdAt: account.createdAt,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "automation:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const accounts = await prisma.socialAccount.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          platform: true,
          label: true,
          accountRef: true,
          autoReply: true,
          isActive: true,
          lastSyncAt: true,
          createdAt: true,
        },
      });
      // tokenEnc/tokenIv are never selected — tokens never leave encrypted storage
      return NextResponse.json(accounts.map(toPublic));
    } catch (error) {
      logger.error("Failed to list social accounts:", error);
      return NextResponse.json(
        { error: "Failed to list social accounts" },
        { status: 500 }
      );
    }

  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "automation:create");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const body = await request.json();
      const { platform, label, accountRef, token } = body;

      if (!isSupportedPlatform(platform)) {
        return NextResponse.json(
          { error: "platform must be one of: facebook, instagram, x" },
          { status: 400 }
        );
      }
      if (!accountRef || typeof accountRef !== "string" || !accountRef.trim()) {
        return NextResponse.json(
          { error: "accountRef is required (Page ID, IG user ID, or X user ID)" },
          { status: 400 }
        );
      }
      if (!token || typeof token !== "string" || !token.trim()) {
        return NextResponse.json({ error: "token is required" }, { status: 400 });
      }

      let encrypted: { tokenEnc: string; tokenIv: string };
      try {
        encrypted = encryptToken(token.trim());
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Encryption failed" },
          { status: 500 }
        );
      }

      const account = await prisma.socialAccount.create({
        data: withBusinessId({
          platform,
          label: typeof label === "string" ? label.trim() : "",
          accountRef: accountRef.trim(),
          tokenEnc: encrypted.tokenEnc,
          tokenIv: encrypted.tokenIv,
          // Phase 5 (user decision 6): never auto-post without the setting.
          autoReply: false,
          isActive: true,
        }),
        select: {
          id: true,
          platform: true,
          label: true,
          accountRef: true,
          autoReply: true,
          isActive: true,
          lastSyncAt: true,
          createdAt: true,
        },
      });

      return NextResponse.json(toPublic(account), { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Unique constraint")) {
        return NextResponse.json(
          { error: "An account with this platform and accountRef already exists" },
          { status: 409 }
        );
      }
      logger.error("Failed to create social account:", error);
      return NextResponse.json(
        { error: "Failed to create social account" },
        { status: 500 }
      );
    }

  });
}
