/**
 * POST /api/test-chat/[id]/messages — one test turn: the tester
 * sends a message, the OWN agent answers in TEST mode.
 *
 * STAGED ONLY (test-chat sandbox leg).
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO (the isolation proof
 * lives here, in the import list as much as in the code):
 *  - It does NOT call the live chat pipeline (engine chat()).
 *    That pipeline persists customer messages, offers the order
 *    tool, meters the turn, and returns a reply for delivery to a
 *    visitor. Calling it would create a real conversation row, a
 *    possible order, and a metered turn — exactly the
 *    contamination this leg must prevent.
 *  - It does NOT import the usage-metering module. Test turns
 *    neither increment usage nor are blocked by usage counts:
 *    they are excluded from usage metering by construction.
 *    (Deliberate deviation from the Agent Desk preview, which
 *    meters like the knowledge test — see the leg report. The
 *    provider-token cost of a test turn still exists; capping or
 *    metering test turns separately is an owner decision, not a
 *    silent default. Session/turn caps in the pure module bound
 *    the exposure in the meantime.)
 *  - It does NOT offer tools to the provider. The completion call
 *    takes messages only (the same tool-less shape the Agent Desk
 *    preview uses), so no order, booking, ticket, follow-up, or
 *    courier action can execute behind a test reply, and a test
 *    reply can never confirm anything.
 *  - It does NOT touch any channel code, any conversation or
 *    customer message collection, any order/ticket/follow-up
 *    collection, or any knowledge-entry write. The only rows it
 *    writes are testChatMessages rows (isTest: true, role
 *    "tester" / "assistant", channel "test-chat") and the owning
 *    session's messageCount.
 *
 * WHAT IT DOES DO (same reuse shape as the Agent Desk preview):
 *  - Subscription ACCESS gate, mirroring the preview: an inactive
 *    subscription, or a grant scoped away from chat, answers 402
 *    subscription_paused before any provider token is spent.
 *    (Access gate only — it records no usage. A paused tenant
 *    cannot test; an active tenant's tests are not counted.)
 *  - Pure greeting: the live deterministic greeting reply
 *    (isPureGreeting + buildGreetingReply), no provider call.
 *  - Otherwise: the LIVE system prompt from buildSystemPrompt —
 *    live behaviour text, live knowledge base, business name /
 *    tone / language — with prior TEST turns (not customer
 *    history) in the customerHistory slot, plus the TEST suffix
 *    from the pure module. Fidelity limits, stated: a test turn
 *    shows wording only, never a completed order, a tool-chosen
 *    product card, or a follow-up; live turns additionally add
 *    intent guidance and a catalog brief, which a test turn does
 *    not (single test message, no live conversation context).
 *  - Failure honesty: if the provider returns no text, NO
 *    assistant row is stored and the route answers 500. The
 *    tester row stays stored (the turn happened), and the tester
 *    can retry. Nothing is faked.
 *
 * Test-chat is a TESTING tool, not a teaching path: no turn here
 * writes knowledge, changes website/details data, or teaches the
 * agent anything for live customers.
 *
 * Tenant scoping: requireAuth + runWithBusiness + explicit
 * businessId on every query; a foreign session id answers 404
 * not_found, never 403. A null businessId answers 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, withBusinessId, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  requireActiveSubscription,
  SubscriptionInactiveError,
} from "@/lib/subscription";
import {
  resolveSiteKeys,
  hasAnyProviderKey,
  completeWithFallback,
  normalizePreferredProvider,
} from "@/lib/ai/providers";
import {
  buildSystemPrompt,
  isPureGreeting,
  buildGreetingReply,
} from "@/lib/ai/engine";
import {
  MAX_TURNS_PER_SESSION,
  TEST_COMPLETION_SUFFIX,
  buildTestHistory,
  canAddTurn,
  toTestEnvelope,
  validateTestMessage,
  type TestChatMessage,
  type TestChatSession,
} from "@/lib/test-chat";

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

    // Subscription ACCESS gate BEFORE any provider token is spent
    // (same shape and order as the Agent Desk preview). This gate
    // records nothing: it only decides whether testing is allowed.
    let subscription;
    try {
      subscription = await requireActiveSubscription(auth.businessId);
    } catch (err) {
      if (err instanceof SubscriptionInactiveError) {
        logger.warn(
          `[billing] blocked test chat turn for business ${auth.businessId}: subscription inactive`
        );
        return NextResponse.json(
          { ok: false, error: "subscription_paused" },
          { status: 402 }
        );
      }
      throw err;
    }
    if (subscription.scopeAllowsChat === false) {
      logger.warn(
        `[billing] blocked test chat turn for business ${auth.businessId}: grant scope excludes chat`
      );
      return NextResponse.json(
        { ok: false, error: "subscription_paused" },
        { status: 402 }
      );
    }

    try {
      const body = await request.json();
      const { message } = body ?? {};

      if (!validateTestMessage(message)) {
        return NextResponse.json(
          { error: "A test message is required" },
          { status: 400 }
        );
      }
      const text = (message as string).trim();

      const sessionRows = (await prisma.testChatSession.findMany({
        where: { id: id, businessId: auth.businessId },
        take: 1,
      })) as unknown as TestChatSession[];
      if (sessionRows.length === 0) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const session = sessionRows[0];
      if (session.status === "closed") {
        return NextResponse.json(
          { error: "test_session_closed" },
          { status: 409 }
        );
      }
      if (!canAddTurn(session)) {
        return NextResponse.json(
          {
            error: "test_session_turn_limit",
            detail: `This test session reached its turn limit (${MAX_TURNS_PER_SESSION} turns). Start a new test session.`,
          },
          { status: 409 }
        );
      }

      // Prior TEST turns only — never customer history.
      const prior = (await prisma.testChatMessage.findMany({
        where: { sessionId: session.id, businessId: auth.businessId },
        orderBy: { createdAt: "asc" },
      })) as unknown as TestChatMessage[];
      const history = buildTestHistory(prior);

      const settings = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });
      const businessName =
        ((settings as { businessName?: unknown } | null)?.businessName as
          | string
          | undefined) || "My Business";

      // The tester turn is stored first, as a TEST row only.
      await prisma.testChatMessage.create({
        data: withBusinessId({
          sessionId: session.id,
          isTest: true,
          role: "tester",
          content: text,
          channel: "test-chat",
          model: "",
        }),
      });

      let reply: string;
      let model: string;

      // Pure greeting: the live deterministic reply, not an LLM
      // guess at it (live greetings never reach the LLM).
      if (isPureGreeting(text)) {
        reply = buildGreetingReply(
          text,
          businessName,
          ((settings as { language?: unknown } | null)?.language as
            | string
            | null) ?? null
        );
        model = "deterministic";
      } else {
        const keys = await resolveSiteKeys(auth.businessId);
        if (!hasAnyProviderKey(keys)) {
          return NextResponse.json(
            {
              error:
                "AI API key is not configured. Please configure it in Settings.",
            },
            { status: 400 }
          );
        }

        const entries = await prisma.knowledgeEntry.findMany({
          where: { isActive: true },
          include: {
            category: {
              select: { id: true, name: true, color: true },
            },
          },
          orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        });

        const systemPrompt = buildSystemPrompt(
          {
            businessName,
            businessDesc:
              ((settings as { businessDesc?: unknown } | null)
                ?.businessDesc as string) || "",
            welcomeMessage:
              ((settings as { welcomeMessage?: unknown } | null)
                ?.welcomeMessage as string) || "",
            tone:
              ((settings as { tone?: unknown } | null)?.tone as string) ||
              "friendly",
            language:
              ((settings as { language?: unknown } | null)?.language as
                string) || "auto",
            // THE LIVE behaviour text — test-chat tests the live
            // agent. Draft-rule testing lives in Agent Desk preview.
            agentBehavior:
              ((settings as { agentBehavior?: unknown } | null)
                ?.agentBehavior as string) || "",
            knowledgeBase: (entries as Array<{
              category?: { name?: string } | null;
              title: string;
              content: string;
              priority: number;
            }>).map((e) => ({
              category: e.category?.name ?? "",
              title: e.title,
              content: e.content,
              priority: e.priority,
            })),
            customerName: "",
            customerHistory: history,
            channel: "test-chat",
          },
          undefined
        );

        const completion = await completeWithFallback(
          {
            messages: [
              {
                role: "system",
                content: systemPrompt + "\n\n" + TEST_COMPLETION_SUFFIX,
              },
              { role: "user", content: text },
            ],
            model:
              ((settings as { aiModel?: unknown } | null)?.aiModel as
                | string
                | undefined) || "gpt-4o-mini",
            maxTokens: Math.min(
              (((settings as { maxTokens?: unknown } | null)?.maxTokens as
                | number
                | undefined) || 2048),
              1024
            ),
            temperature:
              (((settings as { temperature?: unknown } | null)
                ?.temperature as number | undefined) ?? 0.7),
          },
          {
            keys,
            preferredProvider: normalizePreferredProvider(
              ((settings as { aiProvider?: unknown } | null)?.aiProvider as
                | string
                | undefined)
            ),
            label: "test-chat",
          }
        );

        // Honest failure: no text, no assistant row, no fake reply.
        // The tester row stays stored; the tester can retry.
        if (!completion?.text) {
          return NextResponse.json(
            { error: "Failed to generate test reply" },
            { status: 500 }
          );
        }
        reply = completion.text;
        model =
          completion.model ||
          ((settings as { aiModel?: unknown } | null)?.aiModel as string) ||
          "gpt-4o-mini";
      }

      // The agent reply is stored as a TEST row only. No usage is
      // recorded, no channel is sent to, no order/ticket/follow-up
      // is created — by the absence of those calls above.
      await prisma.testChatMessage.create({
        data: withBusinessId({
          sessionId: session.id,
          isTest: true,
          role: "assistant",
          content: reply,
          channel: "test-chat",
          model,
        }),
      });

      await prisma.testChatSession.update({
        where: { id: session.id, businessId: auth.businessId },
        data: { messageCount: prior.length + 2 },
      });

      const freshSession = (await prisma.testChatSession.findMany({
        where: { id: session.id, businessId: auth.businessId },
        take: 1,
      })) as unknown as TestChatSession[];
      const freshMessages = (await prisma.testChatMessage.findMany({
        where: { sessionId: session.id, businessId: auth.businessId },
        orderBy: { createdAt: "asc" },
      })) as unknown as TestChatMessage[];

      return NextResponse.json(
        toTestEnvelope({ session: freshSession[0], messages: freshMessages })
      );
    } catch (error) {
      logger.error("Failed to generate test chat reply:", error);
      return NextResponse.json(
        { error: "Failed to generate test chat reply" },
        { status: 500 }
      );
    }
  });
}
