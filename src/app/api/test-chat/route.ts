/**
 * GET /api/test-chat — list this business's test sessions (newest
 * first, capped) plus the current live-switch snapshot.
 * POST /api/test-chat — start a new test session.
 *
 * STAGED ONLY (test-chat sandbox leg).
 *
 * ISOLATION: both handlers query testChatSessions ONLY. They never
 * query conversations or messages, so a test session can never
 * appear in the inbox, the conversation list, analytics, or any
 * real-conversation count — by construction, not by filtering.
 * Every response carries isTest + notSent. Creating a session
 * writes one test row and nothing else: no conversation, no
 * message in a customer thread, no order, no ticket, no usage
 * record, no channel send.
 *
 * LIVE SNAPSHOT: GET also reports the existing global AI switch
 * (settings.aiEnabled, normalised missing = ON exactly as the
 * engine reads it) so the page can say honestly whether the agent
 * is already live, explicitly off, or never set. This snapshot is
 * READ-ONLY here: only the existing Settings PUT changes it, via
 * the page's Go live control (see the dashboard page).
 *
 * Tenant scoping: requireAuth + runWithBusiness + an explicit
 * businessId filter on every query. A null businessId (Super Admin
 * without a selected business) answers 400, mirroring the settings
 * route — it never falls back to another business's sessions.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  MAX_OPEN_SESSIONS_PER_BUSINESS,
  TEST_SESSION_LIST_LIMIT,
  canStartSession,
  normaliseLiveFlag,
  publicSession,
  validateSessionTitle,
  type TestChatSession,
} from "@/lib/test-chat";

async function readLiveSnapshot(businessId: string): Promise<{
  agentLive: boolean;
  agentLiveExplicit: boolean;
}> {
  const settings = await prisma.settings.findUnique({
    where: { businessId },
  });
  const { live, explicit } = normaliseLiveFlag(
    (settings as { aiEnabled?: unknown } | null)?.aiEnabled
  );
  return { agentLive: live, agentLiveExplicit: explicit };
}

export async function GET(request: NextRequest) {
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
        where: { businessId: auth.businessId },
        orderBy: [{ createdAt: "desc" }],
        take: TEST_SESSION_LIST_LIMIT,
      })) as unknown as TestChatSession[];
      const snapshot = await readLiveSnapshot(auth.businessId);

      return NextResponse.json({
        isTest: true,
        notSent: true,
        testMode: true,
        agentLive: snapshot.agentLive,
        agentLiveExplicit: snapshot.agentLiveExplicit,
        sessions: rows.map(publicSession),
      });
    } catch (error) {
      logger.error("Failed to fetch test chat sessions:", error);
      return NextResponse.json(
        { error: "Failed to fetch test chat sessions" },
        { status: 500 }
      );
    }
  });
}

export async function POST(request: NextRequest) {
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
      const body = await request.json();
      const { title } = body ?? {};

      if (!validateSessionTitle(title)) {
        return NextResponse.json(
          { error: "Session title is too long" },
          { status: 400 }
        );
      }

      const openRows = (await prisma.testChatSession.findMany({
        where: { businessId: auth.businessId, status: "open" },
      })) as unknown as TestChatSession[];
      if (!canStartSession(openRows.length)) {
        return NextResponse.json(
          {
            error: "test_session_limit",
            detail: `Close a test session before starting a new one (limit ${MAX_OPEN_SESSIONS_PER_BUSINESS} open sessions).`,
          },
          { status: 409 }
        );
      }

      const snapshot = await readLiveSnapshot(auth.businessId);

      const created = (await prisma.testChatSession.create({
        data: withBusinessId({
          isTest: true,
          status: "open",
          title: typeof title === "string" ? title.trim() : "",
          createdBy: auth.userId,
          createdByName: auth.name,
          startedWhileLive: snapshot.agentLive,
          messageCount: 0,
          closedAt: null,
        }),
      })) as unknown as TestChatSession;

      return NextResponse.json({
        isTest: true,
        notSent: true,
        testMode: true,
        session: publicSession(created),
      });
    } catch (error) {
      logger.error("Failed to start test chat session:", error);
      return NextResponse.json(
        { error: "Failed to start test chat session" },
        { status: 500 }
      );
    }
  });
}
