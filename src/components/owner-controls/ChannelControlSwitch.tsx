"use client";

/**
 * CHANNEL CONTROL SWITCH — dashboard component (settled model).
 *
 * Real repo path (NEW file):
 *   src/components/owner-controls/ChannelControlSwitch.tsx
 *
 * This is the switch that sits at the TOP of a channel tab in the
 * unified inbox (one per channel tab — Website, WhatsApp, Messenger,
 * Facebook, Instagram, X, and any other channel tab). It is the
 * CHANNEL-level switch the settled model requires. It does NOT
 * replace HEAD's per-conversation switch or the global kill-switch:
 *   - channel switch OFF (owner) -> AI silent on the WHOLE channel
 *     while the owner holds it; other channels unaffected.
 *   - per-conversation switch -> one thread only (HEAD, unchanged).
 *   - global switch -> everything (HEAD, unchanged).
 *
 * Presentation only: it takes its state and callbacks as props and
 * fetches nothing, so it cannot invent a business, a channel, or a
 * permission. Wording reuses HEAD's inbox wording ("You took over",
 * "AI is silent") — no new customer-facing copy is introduced here.
 * No emoji. Styling follows HEAD's AiToggle pattern (Bot / BotOff
 * icons, role="switch").
 */

import { Bot, BotOff } from "lucide-react";
import type { ChannelId, ChannelMode } from "@/lib/owner-controls/channel-controls";

export interface ChannelControlSwitchProps {
  channel: ChannelId;
  /** Human label for the tab, e.g. "WhatsApp". Supplied by the page. */
  label: string;
  mode: ChannelMode;
  /** True while a takeover/hand-back request is in flight. */
  busy?: boolean;
  /** True when the global kill-switch is off (HEAD Settings). */
  globalAiOff?: boolean;
  onTakeOver: () => void;
  onHandBack: () => void;
}

export function ChannelControlSwitch({
  channel,
  label,
  mode,
  busy = false,
  globalAiOff = false,
  onTakeOver,
  onHandBack,
}: ChannelControlSwitchProps) {
  const ownerHeld = mode === "owner";
  const disabled = busy || globalAiOff;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-white border-b border-gray-200">
      <span className="text-sm font-medium text-gray-900">
        {label} channel
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={!ownerHeld}
        aria-label={`AI replies for the ${label} channel`}
        disabled={disabled}
        onClick={() => (ownerHeld ? onHandBack() : onTakeOver())}
        title={
          ownerHeld
            ? "You took over this channel — click to hand back to AI"
            : "AI is replying on this channel — click to take over"
        }
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors ${
          ownerHeld
            ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
            : "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
        } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        {ownerHeld ? <BotOff className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        AI {ownerHeld ? "OFF" : "ON"}
      </button>
      {ownerHeld && (
        <span className="text-xs text-amber-800">
          You took over {label}. The AI is silent on this channel — the
          customer talks directly to you. Other channels are unaffected.
        </span>
      )}
      {globalAiOff && (
        <span className="text-xs text-amber-800">
          AI is switched off globally, so this channel switch is paused
          until you turn AI back on in Settings.
        </span>
      )}
      <span className="hidden" data-channel={channel} />
    </div>
  );
}

/**
 * Banner text for a channel the owner holds. Kept as a separate
 * export so the inbox page can reuse the exact settled wording in
 * the thread view without duplicating strings.
 */
export function channelOwnerBannerText(label: string): string {
  return `You took over ${label}. The AI is silent on this channel — the customer talks directly to you. Flip the switch back on and the AI resumes with full history.`;
}
