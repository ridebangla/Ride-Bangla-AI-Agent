export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
}

export interface AIConfig {
  provider: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  /**
   * Phase 5 (user decision 17): global AI kill-switch from settings.
   * false = the chat pipeline stays silent on every conversation.
   */
  aiEnabled: boolean;
  /**
   * Leg D (video round 2) — reply approval mode, read from settings by
   * getAIConfig. Optional so older config objects still type-check:
   * absent = direct send (approval off), the platform default.
   */
  replyApprovalEnabled?: boolean;
  replyApprovalWaitSeconds?: number;
  /**
   * Leg J: per-channel / per-page AI toggles from the tenant's
   * settings doc (see src/lib/channel-toggles.ts). Missing/empty =
   * everything ON. Populated by getAIConfig(); defaultAIConfig()
   * returns empty objects (all ON) on a settings-read outage.
   */
  channelAiToggles?: Record<string, boolean>;
  pageAiToggles?: Record<string, { messages?: boolean; comments?: boolean }>;
}

export interface ConversationContext {
  businessName: string;
  businessDesc: string;
  welcomeMessage: string;
  tone: string;
  language: string;
  /**
   * Per-business behavior instructions (settings.agentBehavior). Injected
   * verbatim into the system prompt as "Business Behavior Instructions".
   * Lets each business define addressing style, convince/retain rules and
   * honesty guardrails without code changes.
   */
  agentBehavior: string;
  /**
   * Supplementary business rules section (LEG G, staged): formatted
   * from the tenant's saved business rules, or "" when none are
   * set. Optional so older call sites keep working.
   */
  businessRulesSection?: string;
  knowledgeBase: KnowledgeItem[];
  customerName: string;
  customerHistory: string[];
  channel: string;
}

export interface KnowledgeItem {
  category: string;
  title: string;
  content: string;
  priority: number;
}

import type { MediaInput } from "./media";

export interface ChatOptions {
  /**
   * Customer media attachment (photo / video / voice message). It is
   * perceived FIRST by a dedicated model (vision / Whisper) into text, which
   * the brain then answers — a real multimodal path, not a stub.
   */
  media?: MediaInput;
}
