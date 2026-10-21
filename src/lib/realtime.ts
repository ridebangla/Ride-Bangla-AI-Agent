/**
 * Real-time Event System
 *
 * Server-Sent Events (SSE) based real-time updates.
 * Lighter than WebSocket, works with Next.js edge runtime,
 * and doesn't require socket.io dependency.
 */

import { logger } from "@/lib/logger";

export type EventType =
  | "message:new"
  | "message:updated"
  | "conversation:new"
  | "conversation:updated"
  | "conversation:assigned"
  | "ticket:new"
  | "ticket:updated"
  | "typing:start"
  | "typing:stop"
  | "agent:activity"
  | "agent:online"
  | "agent:offline"
  | "notification";

interface EventPayload {
  type: EventType;
  data: Record<string, unknown>;
  timestamp: string;
  conversationId?: string;
}

type EventCallback = (event: EventPayload) => void;

// In-memory subscriber registry
const subscribers = new Map<string, Set<EventCallback>>();

/**
 * Subscribe to real-time events.
 * Returns an unsubscribe function.
 */
export function subscribe(
  channel: string,
  callback: EventCallback
): () => void {
  if (!subscribers.has(channel)) {
    subscribers.set(channel, new Set());
  }
  subscribers.get(channel)!.add(callback);

  return () => {
    const subs = subscribers.get(channel);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) subscribers.delete(channel);
    }
  };
}

/**
 * Publish an event to all subscribers on a channel.
 */
export function publish(channel: string, event: Omit<EventPayload, "timestamp">): void {
  const payload: EventPayload = {
    ...event,
    timestamp: new Date().toISOString(),
  };

  const subs = subscribers.get(channel);
  if (subs) {
    for (const callback of subs) {
      try {
        callback(payload);
      } catch (error) {
        logger.error("SSE subscriber callback error", error);
      }
    }
  }

  // Also publish to global channel
  if (channel !== "global") {
    const globalSubs = subscribers.get("global");
    if (globalSubs) {
      for (const callback of globalSubs) {
        try {
          callback(payload);
        } catch (error) {
          logger.error("SSE global subscriber callback error", error);
        }
      }
    }
  }
}

/**
 * Helper: Emit a new message event.
 */
export function emitNewMessage(
  conversationId: string,
  message: { id: string; role: string; content: string }
): void {
  publish(`conversation:${conversationId}`, {
    type: "message:new",
    conversationId,
    data: message,
  });
  publish("global", {
    type: "message:new",
    conversationId,
    data: { conversationId, messageId: message.id, role: message.role },
  });
}

/**
 * Helper: Emit typing indicator.
 */
export function emitTyping(
  conversationId: string,
  userName: string,
  isTyping: boolean
): void {
  publish(`conversation:${conversationId}`, {
    type: isTyping ? "typing:start" : "typing:stop",
    conversationId,
    data: { userName },
  });
}

/**
 * Helper: Emit conversation update.
 */
export function emitConversationUpdate(
  conversationId: string,
  changes: Record<string, unknown>
): void {
  publish("global", {
    type: "conversation:updated",
    conversationId,
    data: changes,
  });
}

/**
 * Helper: Emit a live agent-activity change (what the AI agent is doing
 * right now on this conversation — see lib/ai/activity.ts). `activity`
 * is null when the turn settled and the agent is idle again.
 */
export function emitAgentActivity(
  conversationId: string,
  activity: { kind: string; channel?: string | null; at: string } | null
): void {
  publish(`conversation:${conversationId}`, {
    type: "agent:activity",
    conversationId,
    data: { activity },
  });
  publish("global", {
    type: "agent:activity",
    conversationId,
    data: { conversationId, activity },
  });
}

/**
 * Get subscriber count for monitoring.
 */
export function getSubscriberCount(): number {
  let count = 0;
  for (const subs of subscribers.values()) {
    count += subs.size;
  }
  return count;
}
