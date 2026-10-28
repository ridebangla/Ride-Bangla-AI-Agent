/**
 * POST /api/agent-desk/preview — test reply under a draft (or
 * unsaved) rule text, exactly as the live engine would build it,
 * before anything goes live.
 *
 * STAGED ONLY (agent booking batch, LEG G).
 *
 * FIDELITY, AND ITS HONEST LIMITS:
 *  - The system prompt is built by the LIVE engine's own
 *    buildSystemPrompt, with agentBehavior replaced by the draft
 *    text and the tenant's live knowledge base — same business
 *    name, tone, language, knowledge, and doctrine sections as a
 *    real customer turn. A pure greeting takes the SAME
 *    deterministic path as live (isPureGreeting +
 *    buildGreetingReply), because live greetings never reach the
 *    LLM at all.
 *  - The reply is then rendered by the dashboard inside a phone
 *    frame, so the owner sees the wording as a customer would
 *    see it on a phone.
 *  - WHAT PREVIEW IS NOT: it runs NO tools and writes NO
 *    conversation, message, order, or ticket. A preview can show
 *    wording; it can never show a completed order, a tool-chosen
 *    product card, or a follow-up. The completion carries one
 *    extra instruction — this is a TEST preview, claim no order,
 *    booking, ticket, or notification as created — because with
 *    no tools available, a model that claimed otherwise would be
 *    inventing a side effect. The response is labelled
 *    isPreview + notSent on every call.
 *
 * GATES (mirroring /api/knowledge/test exactly, so preview spend
 * cannot bypass the limit model): inactive subscription or a
 * grant scoped away from chat → 402 subscription_paused; no
 * provider key → 400; plan limit reached → 402
 * message_limit_reached; a successful LLM preview is metered with
 * recordAiMessage. A deterministic greeting preview spends no
 * provider tokens and is not metered (it is a fixed string, not
 * an AI message — the one deliberate metering difference from a
 * live greeting turn, flagged as an owner decision in the leg
 * report). A refused rule text (blocking validation code) is
 * rejected BEFORE any LLM call, so forbidden text never spends.
 *
 * TENANT SCOPING: the draft (if any), the settings, the keys,
 * and the knowledge entries are all read under this business's
 * runWithBusiness context. A draftId belonging to another
 * business resolves to nothing here and answers 404 not_found.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, runWithBusiness } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  requireActiveSubscription,
  SubscriptionInactiveError,
} from "@/lib/subscription";
import { checkMessageLimitExceeded, recordAiMessage } from "@/lib/billing-usage";
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
  toPhonePreview,
  validateRuleText,
  validateTestMessage,
  type AgentRuleVersion,
} from "@/lib/agent-desk";

const PREVIEW_SUFFIX = [
  "This is a TEST preview for the business owner. Answer exactly as you would to a customer.",
  "No tools are available in this preview: do not claim to have created an order, booking, ticket, or notification.",
].join(" ");

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "agent-desk:write");
  if (!isAuthenticated(auth)) return auth;

  if (!auth.businessId) {
    return NextResponse.json(
      { error: "No business configured — complete setup first." },
      { status: 400 }
    );
  }

  // Billing hard-stop BEFORE any LLM tokens are spent (same shape
  // and order as /api/knowledge/test).
  let subscription;
  try {
    subscription = await requireActiveSubscription(auth.businessId);
  } catch (err) {
    if (err instanceof SubscriptionInactiveError) {
      logger.warn(`[billing] blocked agent-desk preview for business ${auth.businessId}: subscription inactive`);
      return NextResponse.json({ ok: false, error: "subscription_paused" }, { status: 402 });
    }
    throw err;
  }
  if (subscription.scopeAllowsChat === false) {
    logger.warn(`[billing] blocked agent-desk preview for business ${auth.businessId}: grant scope excludes chat`);
    return NextResponse.json({ ok: false, error: "subscription_paused" }, { status: 402 });
  }

  return runWithBusiness(auth.businessId, async () => {
    try {
      const body = await request.json();
      const { plainText, draftId, testMessage } = body ?? {};

      if (!validateTestMessage(testMessage)) {
        return NextResponse.json(
          { error: "A test message is required" },
          { status: 400 }
        );
      }

      // Resolve the rule text: a saved draft row, or unsaved text
      // typed in the Desk (preview before even saving a draft).
      let ruleText: string;
      let rulesVersionNumber: number | null = null;
      let source: "draft" | "unsaved_text" | "version";
      if (typeof draftId === "string" && draftId) {
        const rows = (await prisma.agentRuleVersion.findMany({
          where: { id: draftId, businessId: auth.businessId },
          take: 1,
        })) as unknown as AgentRuleVersion[];
        if (rows.length === 0) {
          return NextResponse.json(
            { error: "not_found" },
            { status: 404 }
          );
        }
        ruleText = rows[0].plainText;
        rulesVersionNumber = rows[0].versionNumber;
        source = rows[0].status === "DRAFT" ? "draft" : "version";
      } else if (typeof plainText === "string") {
        ruleText = plainText;
        source = "unsaved_text";
      } else {
        return NextResponse.json(
          { error: "Provide draftId or plainText" },
          { status: 400 }
        );
      }

      // Refused text never reaches the model.
      const validation = validateRuleText(ruleText);
      if (!validation.ok) {
        return NextResponse.json(
          { error: "Rule text refused", codes: validation.errors },
          { status: 400 }
        );
      }

      const settings = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });
      const businessName =
        ((settings as { businessName?: unknown } | null)?.businessName as
          | string
          | undefined) || "My Business";

      // Pure greeting: the live deterministic reply, not an LLM
      // guess at it (live greetings never reach the LLM).
      if (isPureGreeting(testMessage as string)) {
        const reply = buildGreetingReply(
          testMessage as string,
          businessName,
          ((settings as { language?: unknown } | null)?.language as
            | string
            | null) ?? null
        );
        return NextResponse.json(
          toPhonePreview({
            businessName,
            reply,
            rulesVersionNumber,
            source,
            warnings: validation.warnings,
            model: "deterministic",
          })
        );
      }

      const keys = await resolveSiteKeys(auth.businessId);
      if (!hasAnyProviderKey(keys)) {
        return NextResponse.json(
          { error: "AI API key is not configured. Please configure it in Settings." },
          { status: 400 }
        );
      }

      if (await checkMessageLimitExceeded(auth.businessId)) {
        return NextResponse.json({ ok: false, error: "message_limit_reached" }, { status: 402 });
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
          // THE draft under test, in the live behaviour slot.
          agentBehavior: ruleText,
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
          customerHistory: [],
          channel: "preview",
        },
        undefined
      );

      const completion = await completeWithFallback(
        {
          messages: [
            { role: "system", content: systemPrompt + "\n\n" + PREVIEW_SUFFIX },
            { role: "user", content: (testMessage as string).trim() },
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
          label: "agent-desk-preview",
        }
      );

      if (completion) void recordAiMessage(auth.businessId);

      return NextResponse.json(
        toPhonePreview({
          businessName,
          reply: completion?.text || "",
          rulesVersionNumber,
          source,
          warnings: validation.warnings,
          model:
            completion?.model ||
            ((settings as { aiModel?: unknown } | null)?.aiModel as string) ||
            "gpt-4o-mini",
        })
      );
    } catch (error) {
      logger.error("Failed to generate agent desk preview:", error);
      return NextResponse.json(
        { error: "Failed to generate preview" },
        { status: 500 }
      );
    }
  });
}
