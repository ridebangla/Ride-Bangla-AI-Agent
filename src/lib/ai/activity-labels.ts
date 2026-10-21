/**
 * Live agent activity — shared types + human labels.
 *
 * This module is intentionally dependency-free (no prisma, no realtime)
 * so BOTH the server (engine / channel handlers) and client components
 * (dashboard inbox) can import it. The vanilla-JS widget embed carries
 * its own short-form copy of these captions (it cannot import TS).
 *
 * HONESTY RULE (owner spec 2026-10-21): a caption may only be produced
 * for an action the engine is genuinely executing at that moment. Every
 * kind below maps to a real execution point (see activity.ts). The one
 * exception is `searching_website`: the owner named the caption, but the
 * engine has NO website browse/search execution point yet, so nothing
 * ever emits it — the label exists so the day a real browse tool lands,
 * its caption is ready. It must never be emitted speculatively.
 */

export type AgentActivityKind =
  | "composing"
  | "consulting_knowledge"
  | "perceiving_media"
  | "searching_catalog"
  | "searching_website"
  | "recommending_alternatives"
  | "finding_products"
  | "creating_ticket"
  | "assigning_ticket"
  | "sending_email"
  | "checking_history"
  | "scheduling_followup"
  | "taking_order"
  | "triggering_webhook"
  | "sending_reply";

export interface AgentActivity {
  kind: AgentActivityKind;
  /** Channel the action runs on (for sending_reply), e.g. "whatsapp". */
  channel?: string | null;
  /** ISO timestamp of when the action was reported. */
  at: string;
}

/**
 * Readers treat an activity older than this as absent. A turn that
 * crashes mid-action can leave a stale entry behind; the next turn
 * overwrites it, and this window bounds how long a ghost caption could
 * ever show. Normal turns clear their activity explicitly on settle.
 */
export const ACTIVITY_STALE_MS = 90_000;

export function isFreshActivity(
  value: unknown,
  now: number = Date.now()
): value is AgentActivity {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<AgentActivity>;
  if (typeof a.kind !== "string" || typeof a.at !== "string") return false;
  const at = Date.parse(a.at);
  if (Number.isNaN(at)) return false;
  return now - at < ACTIVITY_STALE_MS && at - now < 5_000;
}

type Lang = "en" | "bn";

/** Dashboard phrasing: the tenant watching THEIR agent work. */
const DASHBOARD_LABELS: Record<Lang, Record<AgentActivityKind, string>> = {
  en: {
    composing: "Your agent is typing a reply…",
    consulting_knowledge: "Your agent is checking the knowledge base…",
    perceiving_media: "Your agent is looking at the customer's media…",
    searching_catalog: "Your agent is searching the catalog…",
    searching_website: "Your agent is searching the website…",
    recommending_alternatives: "Your agent is looking for alternatives…",
    finding_products: "Your agent is finding products to show…",
    creating_ticket: "Your agent is creating a support ticket…",
    assigning_ticket: "Your agent is assigning this to the team…",
    sending_email: "Your agent is emailing the team…",
    checking_history: "Your agent is checking the customer's history…",
    scheduling_followup: "Your agent is scheduling a follow-up…",
    taking_order: "Your agent is taking the order…",
    triggering_webhook: "Your agent is notifying the business system…",
    sending_reply: "Your agent is sending the reply…",
  },
  bn: {
    composing: "আপনার এজেন্ট উত্তর লিখছে…",
    consulting_knowledge: "আপনার এজেন্ট জ্ঞানভাণ্ডার যাচাই করছে…",
    perceiving_media: "আপনার এজেন্ট গ্রাহকের মিডিয়া দেখছে…",
    searching_catalog: "আপনার এজেন্ট ক্যাটালগে খুঁজছে…",
    searching_website: "আপনার এজেন্ট ওয়েবসাইট সার্চ করছে…",
    recommending_alternatives: "আপনার এজেন্ট বিকল্প খুঁজছে…",
    finding_products: "আপনার এজেন্ট দেখানোর জন্য পণ্য খুঁজছে…",
    creating_ticket: "আপনার এজেন্ট সাপোর্ট টিকিট তৈরি করছে…",
    assigning_ticket: "আপনার এজেন্ট টিমের কাছে হস্তান্তর করছে…",
    sending_email: "আপনার এজেন্ট টিমকে ইমেইল পাঠাচ্ছে…",
    checking_history: "আপনার এজেন্ট গ্রাহকের আগের বার্তা দেখছে…",
    scheduling_followup: "আপনার এজেন্ট ফলো-আপ ঠিক করছে…",
    taking_order: "আপনার এজেন্ট অর্ডার নিচ্ছে…",
    triggering_webhook: "আপনার এজেন্ট ব্যবসার সিস্টেমে জানাচ্ছে…",
    sending_reply: "আপনার এজেন্ট উত্তর পাঠাচ্ছে…",
  },
};

/** sending_reply phrasing per channel — only channels with a real
 *  in-process send call ever emit this (see activity.ts / handlers). */
const SEND_CHANNEL_LABELS: Record<Lang, Record<string, string>> = {
  en: {
    whatsapp: "Your agent is messaging on WhatsApp…",
    facebook: "Your agent is messaging on Facebook…",
    instagram: "Your agent is messaging on Instagram…",
    messenger: "Your agent is messaging on Messenger…",
    telegram: "Your agent is messaging on Telegram…",
    email: "Your agent is sending an email…",
  },
  bn: {
    whatsapp: "আপনার এজেন্ট WhatsApp-এ মেসেজ করছে…",
    facebook: "আপনার এজেন্ট Facebook-এ মেসেজ করছে…",
    instagram: "আপনার এজেন্ট Instagram-এ মেসেজ করছে…",
    messenger: "আপনার এজেন্ট Messenger-এ মেসেজ করছে…",
    telegram: "আপনার এজেন্ট Telegram-এ মেসেজ করছে…",
    email: "আপনার এজেন্ট ইমেইল পাঠাচ্ছে…",
  },
};

/**
 * Human label for a live activity. Unknown kinds fall back to the
 * generic composing caption — never a specific claim we cannot back.
 */
export function activityLabel(
  activity: Pick<AgentActivity, "kind" | "channel">,
  lang: Lang = "en"
): string {
  const labels = DASHBOARD_LABELS[lang] || DASHBOARD_LABELS.en;
  if (activity.kind === "sending_reply" && activity.channel) {
    const perChannel = (SEND_CHANNEL_LABELS[lang] || SEND_CHANNEL_LABELS.en)[
      activity.channel
    ];
    if (perChannel) return perChannel;
  }
  return labels[activity.kind] || labels.composing;
}
