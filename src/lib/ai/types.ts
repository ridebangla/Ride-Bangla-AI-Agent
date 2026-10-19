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
