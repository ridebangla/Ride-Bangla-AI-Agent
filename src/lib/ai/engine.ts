import OpenAI from "openai";
import { prisma, withBusinessId } from "@/lib/prisma";
import { agentTools, executeToolCall } from "./tools";
import { emitNewMessage } from "@/lib/realtime";
import { analyzeSentiment, detectIntent, estimateConfidence, requiresHumanApproval } from "./guardrails";
import { classifyIntent, getIntentGuidance, RETENTION_DOCTRINE, UNAVAILABLE_PRODUCT_RULE } from "./intent";
import { getCatalogBrief } from "../catalog";
import { perceiveMedia, type MediaInput } from "./media";
import { logger } from "../logger";
import type {
  AIMessage,
  AIConfig,
  ConversationContext,
  KnowledgeItem,
} from "./types";

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
When the customer confirms an order or booking, use the take_order tool with the collected details (service type, pickup/drop-off, contact). The order is saved for the team to fulfill — always confirm the reference back to the customer.
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

async function getAIConfig(): Promise<AIConfig & ConversationContext> {
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
): Promise<string> {
  const config = await getAIConfig();

  if (!config.apiKey) {
    return "AI is not configured. Please add your API key in Settings > AI Configuration.";
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { createdAt: "asc" }, take: 50 },
    },
  });

  if (!conversation) {
    return "Conversation not found.";
  }

  // ---- Multimodal perception (real path, not a stub) ----
  // Photo -> vision identifies what it shows (product/category).
  // Video  -> frame extraction + vision synthesis.
  // Voice  -> Whisper transcription.
  let effectiveMessage = userMessage;
  if (opts?.media) {
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

  // Save user message
  await prisma.message.create({
    data: withBusinessId({
      conversationId,
      role: "customer",
      content: effectiveMessage,
    }),
  });

  // Call AI
  const response = await callAI(config, messages, conversationId);

  // Save assistant message
  const savedMessage = await prisma.message.create({
    data: withBusinessId({
      conversationId,
      role: "assistant",
      content: response,
    }),
  });

  // Update conversation timestamp
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  // Confidence scoring
  const confidence = estimateConfidence(response, knowledgeBase.length, false);
  if (confidence.shouldEscalate) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: "escalated" },
    });
  }

  emitNewMessage(conversationId, { id: savedMessage.id, role: "assistant", content: response });

  return response;
}

async function callAI(
  config: AIConfig,
  messages: AIMessage[],
  conversationId: string,
  depth = 0
): Promise<string> {
  if (depth > 5) {
    return "I apologize, but I'm having trouble processing your request. Let me connect you with a team member.";
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
    return "I'm temporarily unable to process your request. Please try again in a moment, or I can connect you with a team member.";
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

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: toolCall.id,
      });
    }

    // Continue the conversation with tool results
    return callAI(config, messages, conversationId, depth + 1);
  }

  return choice.message.content || "I apologize, I could not generate a response.";
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
      ...(customerId && { customerId }),
    }),
  });
}
