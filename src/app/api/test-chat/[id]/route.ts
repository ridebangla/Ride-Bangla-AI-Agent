/**
 * GET /api/test-chat/[id] — one test session with its test turns.
 *
 * STAGED ONLY (test-chat sandbox leg).
 *
 * ISOLATION: the session and its turns are read from
 * testChatSessions / testChatMessages ONLY, under this business's
 * id. A session id belonging to another business resolves to
 * nothing here and answers 404 not_found, never 403, so one
 * business cannot probe another's test session ids. The response
 * carries isTest + notSent on every call, and every message row
 * carries isTest + channel "test-chat". No real conversation or
 * customer message is ever read or returned by this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  toTestEnvelope,
  type TestChatMessage,
  type TestChatSession,
} from "@/lib/test-chat";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireAuth(request, "test-chat:read");
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

      const messages = (await prisma.testChatMessage.findMany({
        where: { sessionId: session.id, businessId: auth.businessId },
        orderBy: { createdAt: "asc" },
      })) as unknown as TestChatMessage[];

      return NextResponse.json(toTestEnvelope({ session, messages }));
    } catch (error) {
      logger.error("Failed to fetch test chat session:", error);
      return NextResponse.json(
        { error: "Failed to fetch test chat session" },
        { status: 500 }
      );
    }
  });
}
