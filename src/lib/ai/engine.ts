import OpenAI from "openai";
import { prisma, withBusinessId } from "@/lib/prisma";
import { agentTools, executeToolCall } from "./tools";
import { emitNewMessage } from "@/lib/realtime";
import { analyzeSentiment, detectIntent, estimateConfidence, requiresHumanApproval } from "./guardrails";
import { classifyIntent, getIntentGuidance, RETENTION_DOCTRINE, UNAVAILABLE_PRODUCT_RULE } from "./intent";
import { getCatalogBrief, matchProductsInMessage, matchCategoryProducts, findAlternatives, looksLikeProductInquiry, retainLineFor, type CatalogProduct } from "../catalog";
import { perceiveMedia, type MediaInput } from "./media";
import { logger } from "../logger";
import type {
  AIMessage,
  AIConfig,
  ConversationContext,
  KnowledgeItem,
} from "./types";

/**
 * Phase 3 (user decision 10): a product card the widget renders in-chat —
 * photo, name, price, short description, Order button. Structured data only;
 * the widget owns the presentation.
 */
export interface ProductCard {
  id: string;
  name: string;
  price: number | null;
  currency: string;
  imageUrl: string;
  description: string;
}

/**
 * Phase 3: the chat pipeline's result. `products` carries the product cards
 * for this turn (AI tool-chosen + deterministically name-matched, deduped,
 * max 3). `silent` is true only on the human-takeover path (user decision
 * 17): the customer message was stored and NO AI reply was generated — the
 * caller must render nothing.
 */
export interface ChatResult {
  response: string;
  products: ProductCard[];
  silent: boolean;
}

function toProductCard(p: CatalogProduct): ProductCard {
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    imageUrl: p.imageUrl,
    description: p.description,
  };
}

function buildSystemPrompt(
  context: ConversationContext,
  extras?: { intentGuidance?: string; catalogBrief?: string }
): string {
  const toneGuide: Record<string, string> = {
    friendly:
      "Be warm, approachable, and conversational. Use a casual but professional tone.",
    professional:
      "Be polished and business-like. Maintain a confident, competent tone while remaining personable.",
    formal:
      "Be professional, polished, and courteous. Use formal language and proper grammar.",
    technical:
      "Be precise and detailed. Use technical terminology when appropriate and provide thorough explanations.",
  };

  const knowledgeSection =
    context.knowledgeBase.length > 0
      ? context.knowledgeBase
          .sort((a, b) => b.priority - a.priority)
          .map(
            (k) =>
              `[${k.category}] ${k.title}:\n${k.content}`
          )
          .join("\n\n---\n\n")
      : "No specific knowledge base entries available. Answer based on general knowledge about the business.";

  return `You are the Ride Bangla AI Agent, the AI customer support assistant for ${context.businessName}.

${context.businessDesc ? `About the business: ${context.businessDesc}` : ""}

## Communication Style
${toneGuide[context.tone] || toneGuide.friendly}
${context.language !== "auto" ? `Always respond in: ${context.language}` : "Respond in the same language the customer uses. If the customer writes in Bengali (বাংলা), reply in Bengali. If they write in English, reply in English. Never mix languages in one reply unless the customer does."}

## Your Knowledge Base
Use the following information to answer customer questions accurately:

${knowledgeSection}

## Important Guidelines
- Always be helpful and try to resolve the customer's issue
- If you cannot answer a question from the knowledge base, honestly say so and offer to connect them with a team member
- Use the create_ticket tool when a customer reports a problem that needs human intervention
- Use send_internal_email to notify relevant team members about urgent issues
- Use get_customer_history to check if the customer has contacted before
- Never make up information that isn't in your knowledge base
- Keep responses concise but thorough
- The customer is contacting via: ${context.channel}
${context.customerName !== "Unknown" ? `- Customer name: ${context.customerName}` : ""}

## Customer History
${context.customerHistory.length > 0 ? context.customerHistory.join("\n") : "This is the customer's first interaction."}

${RETENTION_DOCTRINE}

${UNAVAILABLE_PRODUCT_RULE}

${extras?.catalogBrief ? `## ${extras.catalogBrief}\n` : ""}
${extras?.intentGuidance ? `## How to handle THIS message\n${extras.intentGuidance}\n` : ""}
## Order Taking
When the customer confirms an order or booking, use the take_order tool. Pass everything you collected in customFields (keyed by the business's order fields) and items (name, qty, price) when they picked from the catalog. If the tool replies with needsFields, ask the customer for exactly those details (in their language) and call take_order again — never record the order until all required fields are collected. The order is saved for the team to fulfill — always confirm the reference back to the customer.
## Follow-ups
If the customer asks to be reminded or contacted later, use the schedule_followup tool — it is persisted and a background job delivers it.}`;
}

async function getKnowledgeBase(): Promise<KnowledgeItem[]> {
  const entries = await prisma.knowledgeEntry.findMany({
    where: { isActive: true },
    include: { category: true },
    orderBy: { priority: "desc" },
  });

  return entries.map((e: { category: { name: string }; title: string; content: string; priority: number }) => ({
    category: e.category.name,
    title: e.title,
    content: e.content,
    priority: e.priority,
  }));
}

/** Exported for the Phase 3 media endpoints (/api/chat/vision, /api/chat/voice). */
export async function getAIConfig(): Promise<AIConfig & ConversationContext> {
  let settings = await prisma.settings.findFirst();
  if (!settings) {
    settings = await prisma.settings.create({ data: withBusinessId({}) });
  }

  return {
    provider: settings.aiProvider,
    model: settings.aiModel,
    apiKey: settings.aiApiKey,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    // Phase 5 (user decision 17): global kill-switch. Missing = enabled
    // (all pre-Phase-5 settings keep working).
    aiEnabled: settings.aiEnabled !== false,
    businessName: settings.businessName,
    businessDesc: settings.businessDesc,
    welcomeMessage: settings.welcomeMessage,
    tone: settings.tone,
    language: settings.language,
    knowledgeBase: [],
    customerName: "",
    customerHistory: [],
    channel: "",
  };
}

export async function chat(
  conversationId: string,
  userMessage: string,
  opts?: { media?: MediaInput }
): Promise<ChatResult> {
  const config = await getAIConfig();

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { createdAt: "asc" }, take: 50 },
    },
  });

  if (!conversation) {
    return { response: "Conversation not found.", products: [], silent: false };
  }

  // ---- Phase 5 hook: HUMAN TAKEOVER (user decision 17) ----
  // When the business owner flips the dashboard AI switch OFF, the
  // conversation's `aiEnabled` becomes false. From then on this pipeline
  // stores the customer's message and returns in PURE SILENCE — no AI
  // reply, no tool calls, no realtime assistant event, zero interjection.
  // The customer talks directly to the owner; flipping the switch back ON
  // resumes the AI with full history intact (the messages above are always
  // loaded, so the engine reads recent history on resume). Missing/true =
  // AI enabled (all pre-Phase-3 conversations keep working).
  //
  // Phase 5 addition: the GLOBAL kill-switch (settings.aiEnabled) is
  // checked first — when the owner kills AI globally, EVERY conversation
  // goes silent regardless of its own switch.
  if (config.aiEnabled === false || conversation.aiEnabled === false) {
    await prisma.message.create({
      data: withBusinessId({
        conversationId,
        role: "customer",
        content: userMessage,
      }),
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    logger.info(
      `[brain] human takeover: stored customer message silently for conversation ${conversationId}` +
        (config.aiEnabled === false ? " (global kill-switch)" : "")
    );
    return { response: "", products: [], silent: true };
  }

  // ---- Multimodal perception (real path, not a stub) ----
  // Photo -> vision identifies what it shows (product/category).
  // Video  -> frame extraction + vision synthesis.
  // Voice  -> Whisper transcription.
  let effectiveMessage = userMessage;
  if (opts?.media) {
    if (!config.apiKey) {
      // Graceful: no brain connected — keep the message, skip perception.
      logger.info(
        `[brain] media received but no API key; skipping perception (${opts.media.kind})`
      );
    } else {
      try {
        const perception = await perceiveMedia(config.apiKey, config.model, opts.media);
        effectiveMessage = `${perception.description}\n${userMessage}`.trim();
        logger.info(`[brain] perceived ${opts.media.kind} for conversation ${conversationId}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn("[brain] media perception failed", { kind: opts.media.kind, reason });
        const kindLabel =
          opts.media.kind === "audio" ? "a voice message" : `a ${opts.media.kind}`;
        effectiveMessage =
          `[The customer sent ${kindLabel}, but I could not process it: ${reason}]\n${userMessage}`.trim();
      }
    }
  }

  // Save user message — always. The dashboard (and a human who took over)
  // must see what the customer said even when the AI brain is offline.
  await prisma.message.create({
    data: withBusinessId({
      conversationId,
      role: "customer",
      content: effectiveMessage,
    }),
  });

  if (!config.apiKey) {
    // Graceful degradation: an honest message, never a faked AI reply.
    // Deterministic product cards still attach when the customer names a
    // catalog item — real catalog data, no AI involved. When nothing
    // matched but this looks like a product inquiry, the retain path
    // offers budget/category alternatives with the retain phrasing.
    const attached = await attachMentionedProducts(effectiveMessage, []);
    let fallbackResponse =
      "The AI brain isn't connected yet — the business owner still needs to add the AI API key in Settings. Your message has been saved and the team can see it.";
    if (attached.retain) {
      fallbackResponse += `\n\n${retainLineFor(effectiveMessage)}`;
    }
    return {
      response: fallbackResponse,
      products: attached.products,
      silent: false,
    };
  }

  const knowledgeBase = await getKnowledgeBase();

  // ---- Intent understanding: shape the answer for THIS question ----
  const intent = classifyIntent(effectiveMessage);
  const intentGuidance = getIntentGuidance(intent.intent);
  const catalogBrief = await getCatalogBrief().catch(() => "");

  const context: ConversationContext = {
    ...config,
    knowledgeBase,
    customerName: conversation.customerName,
    channel: conversation.channel,
    customerHistory: [],
  };

  // Build message history
  const messages: AIMessage[] = [
    { role: "system", content: buildSystemPrompt(context, { intentGuidance, catalogBrief }) },
  ];

  for (const msg of conversation.messages) {
    if (msg.role === "customer") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: msg.content });
    }
  }

  messages.push({ role: "user", content: effectiveMessage });

  // Guardrails: check if human approval needed
  const approval = requiresHumanApproval(effectiveMessage);
  if (approval.required) {
    const sentiment = analyzeSentiment(effectiveMessage);
    const intent = detectIntent(effectiveMessage);

    // Store metadata for dashboard visibility
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        metadata: {
          escalationReason: approval.reason,
          sentiment: sentiment.sentiment,
          intent: intent.intent,
        },
      },
    });
  }

  // Call AI (collects show_products tool cards along the way)
  const aiResult = await callAI(config, messages, conversationId);

  // Phase 3: deterministic product cards. Merge the AI's tool-chosen cards
  // with name-matched cards from the conversation text (the customer may
  // name a product the model didn't card, or vice versa), then category-
  // intent matches, then the budget-aware retain path. Deduped, max 3.
  const attached = await attachMentionedProducts(
    `${effectiveMessage}\n${aiResult.response}`,
    aiResult.products
  );
  const products = attached.products;

  // Save assistant message
  const savedMessage = await prisma.message.create({
    data: withBusinessId({
      conversationId,
      role: "assistant",
      content: aiResult.response,
    }),
  });

  // Update conversation timestamp
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  // Confidence scoring
  const confidence = estimateConfidence(aiResult.response, knowledgeBase.length, false);
  if (confidence.shouldEscalate) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: "escalated" },
    });
  }

  emitNewMessage(conversationId, { id: savedMessage.id, role: "assistant", content: aiResult.response });

  return { response: aiResult.response, products, silent: false };
}

/**
 * Phase 3: merge AI tool-chosen product cards with deterministic matches.
 * Layers, in order:
 *  1. seed — cards the AI chose via the show_products tool
 *  2. name/tag match — matchProductsInMessage over the conversation text
 *  3. (a) category intent — "I want X type" -> that category's products
 *  4. (b) retain — product inquiry matched NOTHING -> budget-band / closest
 *     category / available alternatives (100% retain: never walk away).
 * Deduped by product id, capped at 3. `retain` is true when layer 4 fired,
 * so the caller can add the retain phrasing. Never throws — a matching
 * failure must not break the chat turn.
 */
async function attachMentionedProducts(
  text: string,
  seed: ProductCard[]
): Promise<{ products: ProductCard[]; retain: boolean }> {
  const merged: ProductCard[] = [...seed];
  let retain = false;
  const pushUnique = (p: ProductCard) => {
    if (merged.length < 3 && !merged.some((e) => e.id === p.id)) merged.push(p);
  };
  try {
    for (const p of (await matchProductsInMessage(text, 3)).map(toProductCard)) {
      pushUnique(p);
    }
    // (a) category intent fill
    if (merged.length < 3) {
      for (const p of (await matchCategoryProducts(text, 3)).map(toProductCard)) {
        pushUnique(p);
      }
    }
    // (b) budget-aware retain
    if (merged.length === 0 && looksLikeProductInquiry(text)) {
      const alt = await findAlternatives(text, 3);
      if (alt.products.length > 0 && alt.reason !== "direct_match") {
        for (const p of alt.products.map(toProductCard)) pushUnique(p);
        retain = merged.length > 0;
      }
    }
  } catch (err) {
    logger.warn("[brain] product matching failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return { products: merged.slice(0, 3), retain };
}

/**
 * Pull the product cards out of a show_products tool result so the widget
 * can render them. Validates shape — never trusts the model blindly.
 */
function collectShownProducts(
  toolName: string,
  resultJson: string,
  into: ProductCard[]
): void {
  if (toolName !== "show_products") return;
  try {
    const parsed = JSON.parse(resultJson) as {
      products?: Array<Record<string, unknown>>;
    };
    const list = Array.isArray(parsed.products) ? parsed.products : [];
    for (const p of list) {
      if (
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        !into.some((e) => e.id === p.id)
      ) {
        into.push({
          id: p.id,
          name: p.name,
          price: typeof p.price === "number" ? p.price : null,
          currency: typeof p.currency === "string" ? p.currency : "",
          imageUrl: typeof p.imageUrl === "string" ? p.imageUrl : "",
          description: typeof p.description === "string" ? p.description : "",
        });
      }
    }
  } catch {
    /* malformed tool JSON: cards simply don't attach */
  }
}

async function callAI(
  config: AIConfig,
  messages: AIMessage[],
  conversationId: string,
  depth = 0,
  collectedProducts: ProductCard[] = []
): Promise<{ response: string; products: ProductCard[] }> {
  if (depth > 5) {
    return {
      response:
        "I apologize, but I'm having trouble processing your request. Let me connect you with a team member.",
      products: collectedProducts,
    };
  }

  const openai = new OpenAI({ apiKey: config.apiKey });

  let response;
  try {
    response = await openai.chat.completions.create({
      model: config.model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      tools: agentTools as OpenAI.ChatCompletionTool[],
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    });
  } catch {
    return {
      response:
        "I'm temporarily unable to process your request. Please try again in a moment, or I can connect you with a team member.",
      products: collectedProducts,
    };
  }

  const choice = response.choices[0];

  if (
    choice.finish_reason === "tool_calls" &&
    choice.message.tool_calls?.length
  ) {
    // Process tool calls
    const toolCalls = choice.message.tool_calls as Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;

    messages.push({
      role: "assistant",
      content: choice.message.content || "",
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    });

    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await executeToolCall(
        toolCall.function.name,
        args,
        conversationId
      );
      // Phase 3: harvest product cards from show_products tool results so
      // the widget can render them.
      collectShownProducts(toolCall.function.name, result, collectedProducts);

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: toolCall.id,
      });
    }

    // Continue the conversation with tool results
    return callAI(config, messages, conversationId, depth + 1, collectedProducts);
  }

  return {
    response:
      choice.message.content || "I apologize, I could not generate a response.",
    products: collectedProducts,
  };
}

export async function createNewConversation(
  channel: string,
  customerName: string,
  customerContact: string,
  customerId?: string
) {
  return prisma.conversation.create({
    data: withBusinessId({
      channel,
      customerName,
      customerContact,
      // Phase 3 (user decision 17): AI replies ON by default. The Phase 5
      // dashboard switch flips this to false for human takeover.
      aiEnabled: true,
      ...(customerId && { customerId }),
    }),
  });
}

