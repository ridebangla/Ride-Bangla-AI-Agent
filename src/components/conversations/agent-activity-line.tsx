"use client";

/**
 * Live agent-activity line for dashboard conversation views.
 *
 * Renders ONLY while the conversation carries a fresh `liveActivity`
 * (written by the engine at real execution points — see
 * src/lib/ai/activity.ts). Stale or absent activity renders nothing:
 * the dashboard never claims the agent is doing something it is not
 * verifiably doing right now.
 */
import { Bot } from "lucide-react";
import {
  activityLabel,
  isFreshActivity,
  type AgentActivity,
} from "@/lib/ai/activity-labels";

export function AgentActivityLine({
  activity,
}: {
  activity?: AgentActivity | null;
}) {
  if (!isFreshActivity(activity)) return null;
  return (
    <div
      className="px-4 py-2 bg-green-50 border-b border-green-200 flex items-center gap-2"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2 flex-none">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-600" />
      </span>
      <Bot className="h-4 w-4 text-green-700 flex-shrink-0" />
      <p className="text-xs font-semibold text-green-800">
        {activityLabel(activity)}
      </p>
    </div>
  );
}
