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

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "knowledge:read");
  if (!isAuthenticated(auth)) return auth;

  // Billing hard-stop BEFORE any LLM tokens are spent (sibling-spender
  // parity with /api/public/ai/generate): an inactive subscription or
  // a grant scoped away from "chat" blocks with the same 402 shape.
  let subscription;
  try {
    subscription = await requireActiveSubscription(auth.businessId);
  } catch (err) {
    if (err instanceof SubscriptionInactiveError) {
      logger.warn(`[billing] blocked knowledge test for business ${auth.businessId}: subscription inactive`);
      return NextResponse.json({ ok: false, error: "subscription_paused" }, { status: 402 });
    }
    throw err;
  }
  if (subscription.scopeAllowsChat === false) {
    logger.warn(`[billing] blocked knowledge test for business ${auth.businessId}: grant scope excludes chat`);
    return NextResponse.json({ ok: false, error: "subscription_paused" }, { status: 402 });
  }

  return runWithBusiness(auth.businessId, async () => {
    if (!auth.businessId) {
      return NextResponse.json({ error: "No business selected." }, { status: 400 });
    }

    try {
      const body = await request.json();
      const { question } = body;

      if (!question || typeof question !== "string" || question.trim().length === 0) {
        return NextResponse.json(
          { error: "Question is required" },
          { status: 400 }
        );
      }

      // Load settings for the model's generation parameters only.
      const settings = await prisma.settings.findUnique({
        where: { businessId: auth.businessId },
      });

      // B7: keys resolve through the SAME funnel the chat engine uses
      // (resolveSiteKeys — per-business keys with platform env fallback;
      // internal businesses resolve the platform keys only). The old
      // code hard-required the legacy settings.aiApiKey, so the test
      // was dead for any business — the company included — whose keys
      // live anywhere else, even when the engine itself was online.
      const keys = await resolveSiteKeys(auth.businessId);
      if (!hasAnyProviderKey(keys)) {
        return NextResponse.json(
          { error: "AI API key is not configured. Please configure it in Settings." },
          { status: 400 }
        );
      }

      // Plan quota hard-stop (same response shape as
      // /api/public/ai/generate) — checked after the provider-key
      // check so an unconfigured business keeps its existing 400.
      if (await checkMessageLimitExceeded(auth.businessId)) {
        return NextResponse.json({ ok: false, error: "message_limit_reached" }, { status: 402 });
      }

      // Load all active knowledge entries
      const entries = await prisma.knowledgeEntry.findMany({
        where: { isActive: true },
        include: {
          category: {
            select: { id: true, name: true, color: true },
          },
        },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      });

      if (entries.length === 0) {
        return NextResponse.json(
          { error: "No active knowledge base entries found. Add entries first." },
          { status: 400 }
        );
      }

      // Build knowledge context
      const knowledgeContext = entries
        .map(
          (entry, index) =>
            `[Entry ${index + 1}] Category: ${entry.category.name} | Title: ${entry.title}\n${entry.content}`
        )
        .join("\n\n---\n\n");

      const systemPrompt = `You are a knowledge base testing assistant. You have access to the following knowledge base entries. Answer the user's question using ONLY the information provided below. If the answer is not in the knowledge base, say so clearly.

  After your answer, list which knowledge base entries were most relevant to your answer by referencing their entry numbers and titles.

  ## Knowledge Base

  ${knowledgeContext}

  ## Response Format
  Provide your answer first, then on a new line write "---SOURCES---" followed by a JSON array of the entry numbers (1-based) that were most relevant. Example:
  Your answer here...
  ---SOURCES---
  [1, 3, 5]`;

      // Same completion funnel as the engine (provider priority,
      // failover, circuit breaker) with the keys resolved above — the
      // test now answers with the provider that would actually serve
      // this business's customers.
      const completion = await completeWithFallback(
        {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: question.trim() },
          ],
          model: settings?.aiModel || "gpt-4o-mini",
          maxTokens: Math.min(settings?.maxTokens || 2048, 1024),
          temperature: settings?.temperature ?? 0.7,
        },
        {
          keys,
          preferredProvider: normalizePreferredProvider(settings?.aiProvider),
          label: "knowledge-test",
        }
      );

      // Meter the spend against the business's plan quota
      // (fire-and-forget, same contract as /api/public/ai/generate).
      if (completion) void recordAiMessage(auth.businessId);

      const responseText = completion?.text || "";

      // Parse sources from response
      let answer = responseText;
      let sourceIndices: number[] = [];

      const sourcesSplit = responseText.split("---SOURCES---");
      if (sourcesSplit.length > 1) {
        answer = sourcesSplit[0].trim();
        try {
          const parsed = JSON.parse(sourcesSplit[1].trim());
          if (Array.isArray(parsed)) {
            sourceIndices = parsed.filter(
              (n: unknown) => typeof n === "number" && n >= 1 && n <= entries.length
            );
          }
        } catch {
          // If parsing fails, no sources to show
        }
      }

      // Map source indices to actual entries
      const sources = sourceIndices.map((idx) => {
        const entry = entries[idx - 1];
        return {
          id: entry.id,
          title: entry.title,
          category: entry.category.name,
          categoryColor: entry.category.color,
          contentPreview: entry.content.slice(0, 200),
        };
      });

      return NextResponse.json({
        answer,
        sources,
        model: completion?.model || settings?.aiModel || "gpt-4o-mini",
        totalEntries: entries.length,
      });
    } catch (error) {
      logger.error("Failed to test knowledge base:", error);
      // Never return the raw provider error to the client — it can carry
      // provider internals (and, from a misbehaving gateway, credential
      // material). The full error is in the server log above.
      return NextResponse.json(
        { error: "Failed to test knowledge base" },
        { status: 500 }
      );
    }

  });
}
