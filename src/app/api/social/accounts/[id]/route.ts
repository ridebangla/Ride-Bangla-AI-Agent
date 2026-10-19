import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

/**
 * Phase 5: update a social account's settings.
 *
 * PATCH /api/social/accounts/[id]  { autoReply?: boolean, isActive?: boolean }
 *
 * `autoReply` (user decision 6): when true the AI may reply to comments on
 * this account automatically; when false the AI only drafts replies for
 * inbox approval. Never auto-post without this setting.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:update");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    try {
      const { id } = await params;
      const body = await request.json();
      const { autoReply, isActive } = body;

      const data: Record<string, unknown> = {};
      if (typeof autoReply === "boolean") data.autoReply = autoReply;
      if (typeof isActive === "boolean") data.isActive = isActive;
      if (Object.keys(data).length === 0) {
        return NextResponse.json(
          { error: "Nothing to update (autoReply / isActive)" },
          { status: 400 }
        );
      }

      const account = await prisma.socialAccount.findUnique({ where: { id } });
      if (!account) {
        return NextResponse.json(
          { error: "Social account not found" },
          { status: 404 }
        );
      }

      const updated = await prisma.socialAccount.update({
        where: { id },
        data,
        select: {
          id: true,
          platform: true,
          label: true,
          accountRef: true,
          autoReply: true,
          isActive: true,
          lastSyncAt: true,
        },
      });

      return NextResponse.json(updated);
    } catch (error) {
      logger.error("Failed to update social account:", error);
      return NextResponse.json(
        { error: "Failed to update social account" },
        { status: 500 }
      );
    }
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "automation:delete");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    try {
      const { id } = await params;

      const account = await prisma.socialAccount.findUnique({ where: { id } });
      if (!account) {
        return NextResponse.json(
          { error: "Social account not found" },
          { status: 404 }
        );
      }

      await prisma.socialAccount.delete({ where: { id } });
      return NextResponse.json({ ok: true });
    } catch (error) {
      logger.error("Failed to delete social account:", error);
      return NextResponse.json(
        { error: "Failed to delete social account" },
        { status: 500 }
      );
    }

  });
}
