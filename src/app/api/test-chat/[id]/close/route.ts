/**
 * POST /api/test-chat/[id]/close — end a test session.
 *
 * STAGED ONLY (test-chat sandbox leg).
 *
 * Closing ends testing in that session: further turns answer 409
 * test_session_closed. Closing NEVER deletes anything — the
 * session and its turns stay stored as test records (isTest: true)
 * until the owner decides a retention rule (see the leg report:
 * retention is a numbered owner decision, not a silent default).
 * Closing a test session changes no customer conversation, no
 * order, no ticket, and no live setting. Going live is a separate
 * step, through the existing Settings PUT, and is never implied
 * by closing a test.
 *
 * Tenant scoping: scoped lookup, 404 not_found on a foreign id
 * (never 403); already-closed sessions answer 409, not a silent
 * no-op, so a double-close cannot be mistaken for a fresh action.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { publicSession, type TestChatSession } from "@/lib/test-chat";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireAuth(request, "test-chat:write");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json(
        { error: "No business configured — complete setup first." },
        { status: 400 }
      );
    }

    try {
      const rows = (await prisma.testChatSession.findMany({
        where: { id: id, businessId: auth.businessId },
        take: 1,
      })) as unknown as TestChatSession[];
      if (rows.length === 0) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const session = rows[0];
      if (session.status === "closed") {
        return NextResponse.json(
          { error: "test_session_closed" },
          { status: 409 }
        );
      }

      await prisma.testChatSession.update({
        where: { id: session.id, businessId: auth.businessId },
        data: { status: "closed", closedAt: new Date() },
      });

      const updated = (await prisma.testChatSession.findMany({
        where: { id: session.id, businessId: auth.businessId },
        take: 1,
      })) as unknown as TestChatSession[];

      return NextResponse.json({
        isTest: true,
        notSent: true,
        testMode: true,
        session: publicSession(updated[0]),
      });
    } catch (error) {
      logger.error("Failed to close test chat session:", error);
      return NextResponse.json(
        { error: "Failed to close test chat session" },
        { status: 500 }
      );
    }
  });
}
