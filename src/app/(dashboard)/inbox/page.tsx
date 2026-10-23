"use client";

/**
 * Phase 5 (user decisions 17 + 18): the unified inbox.
 *
 * ONE page, one channel per tab — Website, WhatsApp, Messenger, Facebook,
 * Instagram, X — plus a Comments tab for the FB/IG comment approval queue.
 * Every conversation carries its channel identity (distinct icon + color +
 * label), unread badges, and a per-conversation AI ON/OFF takeover switch.
 * When the AI is OFF the owner replies directly from the thread
 * (live-chat view); the reply is delivered through the channel's send API
 * only when that channel is connected, otherwise stored honestly as a
 * dashboard-only reply.
 */
import { Header } from "@/components/layout/header";
import {
  MessageCircle,
  MessageSquare,
  Globe,
  Send,
  Search,
  Inbox as InboxIcon,
  ArrowLeft,
  Loader2,
  Bot,
  BotOff,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { FacebookIcon, InstagramIcon, XBrandIcon } from "@/components/ui/channel-icons";
import { useState, useEffect, useRef, useCallback } from "react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { AgentActivityLine } from "@/components/conversations/agent-activity-line";
import {
  isFreshActivity,
  type AgentActivity,
} from "@/lib/ai/activity-labels";

// ---------------------------------------------------------------------------
// Channel identity — distinct icon + color + label per channel.
// ---------------------------------------------------------------------------

interface ChannelDef {
  tab: string;
  label: string;
  icon: React.ElementType;
  chip: string; // icon chip classes
  activeTab: string; // selected tab underline / pill
}

const CHANNELS: ChannelDef[] = [
  {
    tab: "website",
    label: "Website",
    icon: Globe,
    chip: "text-sky-600 bg-sky-50",
    activeTab: "border-sky-500 text-sky-700",
  },
  {
    tab: "whatsapp",
    label: "WhatsApp",
    icon: MessageCircle,
    chip: "text-green-600 bg-green-50",
    activeTab: "border-green-500 text-green-700",
  },
  {
    tab: "messenger",
    label: "Messenger",
    icon: MessageSquare,
    chip: "text-blue-600 bg-blue-50",
    activeTab: "border-blue-500 text-blue-700",
  },
  {
    tab: "facebook",
    label: "Facebook",
    icon: FacebookIcon,
    chip: "text-[#1877F2] bg-blue-50",
    activeTab: "border-[#1877F2] text-[#1877F2]",
  },
  {
    tab: "instagram",
    label: "Instagram",
    icon: InstagramIcon,
    chip: "text-pink-600 bg-pink-50",
    activeTab: "border-pink-500 text-pink-700",
  },
  {
    tab: "x",
    label: "X",
    icon: XBrandIcon,
    chip: "text-slate-700 bg-slate-100",
    activeTab: "border-slate-600 text-slate-800",
  },
  {
    tab: "comments",
    label: "Comments",
    icon: MessageSquare,
    chip: "text-amber-600 bg-amber-50",
    activeTab: "border-amber-500 text-amber-700",
  },
];

function channelDef(tab: string): ChannelDef {
  return CHANNELS.find((c) => c.tab === tab) || CHANNELS[0];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxMessage {
  id: string;
  role: string;
  content: string;
  deliveryNote?: string | null;
  createdAt: string;
}

interface InboxConversation {
  id: string;
  channel: string;
  customerName: string;
  customerContact: string;
  status: string;
  aiEnabled: boolean;
  /** Live agent activity (engine-reported, real execution points only). */
  liveActivity?: AgentActivity | null;
  unread: number;
  createdAt: string;
  updatedAt: string;
  lastMessage: {
    role: string;
    content: string;
    createdAt: string;
  } | null;
  _count: { messages: number };
}

interface CommentItem {
  id: string;
  platform: string;
  externalId: string;
  content: string;
  likes: number;
  draftReply: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto flex-shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-rbai-danger text-white text-xs font-semibold flex items-center justify-center">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function AiToggle({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="AI replies for this conversation"
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      title={enabled ? "AI is replying — click to take over" : "You took over — click to hand back to AI"}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors",
        enabled
          ? "border-rbai-primary/40 bg-rbai-primary/10 text-rbai-primary hover:bg-rbai-primary/15"
          : "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      {enabled ? <Bot className="h-3.5 w-3.5" /> : <BotOff className="h-3.5 w-3.5" />}
      AI {enabled ? "ON" : "OFF"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const [tab, setTab] = useState("website");
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [pendingComments, setPendingComments] = useState(0);
  const [unreadByTab, setUnreadByTab] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<InboxConversation & { messages: InboxMessage[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState<string | null>(null);
  const [togglingAi, setTogglingAi] = useState(false);
  const [globalAiOff, setGlobalAiOff] = useState(false);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ---- Data loading ----

  const fetchTab = useCallback(async (t: string, query: string) => {
    if (t === "comments") {
      const res = await fetch("/api/social/comments?status=pending");
      if (!res.ok) throw new Error("Failed to load comments");
      const data = await res.json();
      setComments(data.comments || []);
      setPendingComments(data.pending || 0);
      return;
    }
    const params = new URLSearchParams({ channel: t });
    if (query.trim()) params.set("search", query.trim());
    const res = await fetch(`/api/inbox?${params.toString()}`);
    if (!res.ok) throw new Error("Failed to load inbox");
    const data = await res.json();
    // /api/inbox returns the paginated envelope { data, pagination, unreadTotal }.
    setConversations(Array.isArray(data.data) ? data.data : []);
    return data;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetchTab(tab, searchQuery);
    } catch {
      showToast("Failed to load inbox", "error");
    } finally {
      setLoading(false);
    }
  }, [tab, searchQuery, fetchTab, showToast]);

  // Unread counts per tab (for the badges) — fetched once per refresh.
  const refreshUnread = useCallback(async () => {
    const tabs = ["website", "whatsapp", "messenger", "facebook", "instagram", "x"];
    const counts: Record<string, number> = {};
    await Promise.all(
      tabs.map(async (t) => {
        try {
          const res = await fetch(`/api/inbox?channel=${t}&limit=1`);
          if (res.ok) {
            const data = await res.json();
            // unreadTotal covers the whole tab, not just the page.
            counts[t] = data.unreadTotal || 0;
          }
        } catch { /* ignore */ }
      })
    );
    // Pending comments badge.
    try {
      const res = await fetch("/api/social/comments?status=pending");
      if (res.ok) {
        const data = await res.json();
        counts.comments = data.pending || 0;
      }
    } catch { /* ignore */ }
    setUnreadByTab(counts);
  }, []);

  const fetchGlobalAi = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setGlobalAiOff(data.aiEnabled === false);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setThread(null);
    setMobileShowDetail(false);
    refresh();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshUnread();
    fetchGlobalAi();
  }, [refreshUnread, fetchGlobalAi]);

  // Signature of the last rendered thread payload — silent polls skip
  // the state write when nothing material changed, so an idle open
  // thread never re-renders (or yanks the scroll) every few seconds.
  const threadSigRef = useRef<string>("");
  // Delta sync: newest message createdAt held for the open conversation
  // (keyed by conversation id — a different id means a full first load),
  // plus a mirror of the rendered thread for merging delta responses.
  const threadDeltaRef = useRef<{ id: string; ts: string } | null>(null);
  const threadRef = useRef<(InboxConversation & { messages: InboxMessage[] }) | null>(null);

  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  const fetchThread = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setDetailLoading(true);
    try {
      const deltaTs =
        threadDeltaRef.current?.id === id ? threadDeltaRef.current.ts : "";
      const res = await fetch(
        deltaTs
          ? `/api/conversations/${id}?since=${encodeURIComponent(deltaTs)}`
          : `/api/conversations/${id}`
      );
      if (res.ok) {
        const data = await res.json();
        const msgs: InboxMessage[] = Array.isArray(data?.messages) ? data.messages : [];
        if (data?.delta) {
          // Delta response: replace the conversation fields from the
          // payload, append only messages not already held, in
          // createdAt order.
          const existing =
            threadRef.current?.id === id ? threadRef.current.messages : [];
          const existingIds = new Set(existing.map((m) => m.id));
          const fresh = msgs.filter((m) => !existingIds.has(m.id));
          const mergedMsgs = [...existing, ...fresh].sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
          // Signature guard: skip the state write when the delta brings
          // no new messages and the non-message fields are unchanged.
          const sig = [
            fresh.length,
            fresh.length ? fresh[fresh.length - 1]?.id ?? "" : "",
            data?.liveActivity?.kind ?? "",
            data?.liveActivity?.at ?? "",
            data?.aiEnabled,
            data?.status,
            data?._count?.messages ?? "",
            JSON.stringify(data?.customer ?? null),
            JSON.stringify(data?.tags ?? null),
            JSON.stringify(data?.tickets ?? null),
          ].join("|");
          if (!opts?.silent || sig !== threadSigRef.current) {
            threadSigRef.current = sig;
            if (mergedMsgs.length) {
              threadDeltaRef.current = {
                id,
                ts: mergedMsgs[mergedMsgs.length - 1].createdAt,
              };
            } else {
              threadDeltaRef.current = { id, ts: deltaTs };
            }
            const { delta: _delta, ...rest } = data;
            setThread({ ...rest, messages: mergedMsgs });
          }
          return;
        }
        const sig = [
          msgs.length,
          msgs.length ? msgs[msgs.length - 1]?.id ?? "" : "",
          data?.liveActivity?.kind ?? "",
          data?.liveActivity?.at ?? "",
          data?.aiEnabled,
          data?.status,
        ].join("|");
        if (!opts?.silent || sig !== threadSigRef.current) {
          threadSigRef.current = sig;
          setThread(data);
        }
        // Full response: (re)seed the delta cursor for this conversation.
        if (msgs.length) {
          let maxTs = msgs[0].createdAt;
          for (const m of msgs) if (m.createdAt > maxTs) maxTs = m.createdAt;
          threadDeltaRef.current = { id, ts: maxTs };
        } else {
          threadDeltaRef.current = null;
        }
      }
    } catch { /* ignore */ } finally {
      if (!opts?.silent) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) fetchThread(selectedId);
  }, [selectedId, fetchThread]);

  // Live thread: while a conversation is open, silently re-fetch every
  // 3s so the agent-activity line (and any new messages) appear as the
  // agent actually works — no spinner, and the signature guard above
  // keeps unchanged payloads from re-rendering.
  useEffect(() => {
    if (!selectedId) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchThread(selectedId, { silent: true });
      }
    }, 3000);
    return () => clearInterval(t);
  }, [selectedId, fetchThread]);

  // Keep the list rows (incl. their agent-working indicators) fresh too.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchTab(tab, searchQuery).catch(() => undefined);
      }
    }, 6000);
    return () => clearInterval(t);
  }, [tab, searchQuery, fetchTab]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages]);

  // ---- Actions ----

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setMobileShowDetail(true);
    setDeliveryNote(null);
    setReplyText("");
  };

  const handleAiToggle = async (enabled: boolean) => {
    if (!selectedId || togglingAi) return;
    setTogglingAi(true);
    try {
      const res = await fetch(`/api/conversations/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiEnabled: enabled }),
      });
      if (!res.ok) throw new Error("Failed");
      setThread((t) => (t ? { ...t, aiEnabled: enabled } : t));
      setConversations((prev) =>
        prev.map((c) => (c.id === selectedId ? { ...c, aiEnabled: enabled } : c))
      );
      showToast(
        enabled
          ? "AI is back on — it will read the full history and resume naturally"
          : "AI is off — the customer now talks directly to you",
        "success"
      );
    } catch {
      showToast("Failed to switch AI mode", "error");
    } finally {
      setTogglingAi(false);
    }
  };

  const handleSendReply = async () => {
    if (!replyText.trim() || !selectedId || sending) return;
    setSending(true);
    setDeliveryNote(null);
    try {
      const res = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: replyText.trim(), role: "admin" }),
      });
      if (!res.ok) throw new Error("Failed to send");
      const data = await res.json();
      setDeliveryNote(data.deliveryNote || null);
      setReplyText("");
      await fetchThread(selectedId);
      refresh();
      refreshUnread();
    } catch {
      showToast("Failed to send reply", "error");
    } finally {
      setSending(false);
    }
  };

  const handleApproveComment = async (id: string, text: string) => {
    if (!text.trim()) return;
    try {
      const res = await fetch(`/api/social/comments/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      showToast("Reply posted to the comment", "success");
      setComments((prev) => prev.filter((c) => c.id !== id));
      refreshUnread();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to post reply", "error");
    }
  };

  const handleDismissComment = async (id: string) => {
    try {
      const res = await fetch(`/api/social/comments/${id}/dismiss`, { method: "POST" });
      if (!res.ok) throw new Error("Failed");
      setComments((prev) => prev.filter((c) => c.id !== id));
      refreshUnread();
    } catch {
      showToast("Failed to dismiss", "error");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendReply();
    }
  };

  const def = channelDef(tab);

  return (
    <>
      <Header
        title="Inbox"
        description="Every channel, one place — reply as yourself or let the AI handle it"
      />

      {/* Channel tabs */}
      <div className="px-6 pt-4 bg-rbai-surface border-b border-rbai-border">
        <div className="flex gap-1 overflow-x-auto">
          {CHANNELS.map((c) => {
            const Icon = c.icon;
            const active = tab === c.tab;
            const unread = unreadByTab[c.tab] || 0;
            return (
              <button
                key={c.tab}
                type="button"
                onClick={() => setTab(c.tab)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors",
                  active
                    ? cn(c.activeTab, "border-b-2")
                    : "border-transparent text-rbai-text-light hover:text-rbai-text hover:border-rbai-border"
                )}
              >
                <span className={cn("p-1.5 rounded-lg", c.chip)}>
                  <Icon className="h-4 w-4" />
                </span>
                {c.label}
                {unread > 0 && (
                  <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-rbai-danger text-white text-xs font-semibold flex items-center justify-center">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Global AI kill-switch banner */}
      {globalAiOff && (
        <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
          <p className="text-xs text-amber-800">
            <span className="font-semibold">AI is switched off globally</span> (Settings) — every
            conversation is silent until you turn it back on.
          </p>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {tab === "comments" ? (
          <CommentsPanel
            comments={comments}
            loading={loading}
            onApprove={handleApproveComment}
            onDismiss={handleDismissComment}
            onRetry={refresh}
          />
        ) : (
          <>
            {/* Left: conversation list */}
            <div
              className={cn(
                "w-full md:w-96 lg:w-[420px] border-r border-rbai-border flex flex-col bg-rbai-surface",
                mobileShowDetail && "hidden md:flex"
              )}
            >
              <div className="p-3 border-b border-rbai-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-rbai-text-light" />
                  <input
                    type="text"
                    placeholder={`Search ${def.label} conversations...`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && refresh()}
                    className="w-full pl-9 pr-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center h-40">
                    <Loader2 className="h-6 w-6 animate-spin text-rbai-primary" />
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-64 px-6 text-center">
                    <div className="p-4 rounded-full bg-rbai-primary-50 mb-4">
                      <InboxIcon className="h-8 w-8 text-rbai-primary" />
                    </div>
                    <p className="font-medium text-rbai-text">No {def.label} conversations</p>
                    <p className="text-sm text-rbai-text-light mt-1">
                      New {def.label} messages will appear here
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-rbai-border">
                    {conversations.map((conv) => {
                      const isSelected = selectedId === conv.id;
                      return (
                        <button
                          key={conv.id}
                          onClick={() => handleSelect(conv.id)}
                          className={cn(
                            "w-full px-4 py-3.5 text-left hover:bg-rbai-primary-50/50 transition-colors",
                            isSelected && "bg-rbai-primary-50 border-l-2 border-l-rbai-primary"
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="font-medium text-sm text-rbai-text truncate">
                                  {conv.customerName}
                                </p>
                                <UnreadBadge count={conv.unread} />
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-rbai-text-light">
                                  {formatRelativeTime(conv.updatedAt)}
                                </span>
                                {!conv.aiEnabled && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">
                                    <BotOff className="h-3 w-3" /> AI off
                                  </span>
                                )}
                                {isFreshActivity(conv.liveActivity) && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700">
                                    <span className="h-1.5 w-1.5 rounded-full bg-green-600 animate-pulse" /> Agent working
                                  </span>
                                )}
                              </div>
                              {conv.lastMessage && (
                                <p className="text-sm text-rbai-text-light mt-1 truncate">
                                  {conv.lastMessage.role === "admin" && (
                                    <span className="text-rbai-primary font-medium">You: </span>
                                  )}
                                  {conv.lastMessage.role === "assistant" && (
                                    <span className="text-rbai-primary font-medium">AI: </span>
                                  )}
                                  {conv.lastMessage.content}
                                </p>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Right: thread */}
            <div className={cn("flex-1 flex flex-col bg-rbai-bg", !mobileShowDetail && "hidden md:flex")}>
              {!selectedId ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                  <div className="p-5 rounded-full bg-rbai-surface border border-rbai-border mb-4">
                    <def.icon className="h-10 w-10 text-rbai-text-light" />
                  </div>
                  <p className="font-semibold text-lg text-rbai-text">Select a {def.label} conversation</p>
                  <p className="text-sm text-rbai-text-light mt-1 max-w-sm">
                    Read the thread, take over from the AI with one switch, and reply directly.
                  </p>
                </div>
              ) : detailLoading && !thread ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-rbai-primary" />
                </div>
              ) : thread ? (
                <>
                  {/* Thread header */}
                  <div className="px-4 py-3 bg-rbai-surface border-b border-rbai-border flex items-center gap-3">
                    <button
                      onClick={() => { setMobileShowDetail(false); setSelectedId(null); setThread(null); }}
                      className="md:hidden p-1.5 hover:bg-rbai-primary-50 rounded-lg transition-colors"
                    >
                      <ArrowLeft className="h-5 w-5 text-rbai-text" />
                    </button>
                    <div className={cn("p-2 rounded-lg flex-shrink-0", def.chip)}>
                      <def.icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-rbai-text truncate">{thread.customerName}</h3>
                      </div>
                      <p className="text-xs text-rbai-text-light">
                        {def.label}
                        {thread.customerContact && ` — ${thread.customerContact}`}
                      </p>
                    </div>
                    <AiToggle
                      enabled={thread.aiEnabled !== false}
                      onChange={handleAiToggle}
                      disabled={togglingAi || globalAiOff}
                    />
                  </div>

                  {/* Takeover banner */}
                  {thread.aiEnabled === false && (
                    <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
                      <BotOff className="h-4 w-4 text-amber-600 flex-shrink-0" />
                      <p className="text-xs text-amber-800">
                        <span className="font-semibold">You took over.</span> The AI is silent on this
                        conversation — the customer talks directly to you. Flip the switch back on and the
                        AI resumes with full history.
                      </p>
                    </div>
                  )}

                  {/* Live agent activity — only while the agent is
                      genuinely working on this conversation right now. */}
                  <AgentActivityLine activity={thread.liveActivity} />

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                    {thread.messages.length === 0 ? (
                      <p className="text-sm text-rbai-text-light text-center">No messages yet</p>
                    ) : (
                      thread.messages.map((msg) => {
                        const isMine = msg.role === "assistant" || msg.role === "admin";
                        const isSystem = msg.role === "system";
                        if (isSystem) {
                          return (
                            <div key={msg.id} className="flex justify-center">
                              <div className="px-3 py-1.5 bg-rbai-surface border border-rbai-border rounded-full text-xs text-rbai-text-light">
                                {msg.content}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div key={msg.id} className={cn("flex", isMine ? "justify-end" : "justify-start")}>
                            <div
                              className={cn(
                                "max-w-[75%] rounded-2xl px-4 py-2.5",
                                isMine
                                  ? "bg-rbai-primary text-white rounded-br-md"
                                  : "bg-rbai-surface border border-rbai-border text-rbai-text rounded-bl-md"
                              )}
                            >
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className={cn("text-xs font-medium", isMine ? "text-white/80" : "text-rbai-text-light")}>
                                  {isMine ? (msg.role === "assistant" ? "AI Assistant" : "You") : thread.customerName}
                                </span>
                              </div>
                              <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                              <p className={cn("text-xs mt-1", isMine ? "text-white/60" : "text-rbai-text-light")}>
                                {formatRelativeTime(msg.createdAt)}
                                {msg.deliveryNote && ` — ${msg.deliveryNote}`}
                              </p>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Reply box */}
                  <div className="px-4 py-3 bg-rbai-surface border-t border-rbai-border">
                    {thread.aiEnabled === false && (
                      <p className="text-xs text-amber-700 mb-2 flex items-center gap-1">
                        <Pencil className="h-3 w-3" /> Replying as you (AI is off on this conversation)
                      </p>
                    )}
                    {deliveryNote && (
                      <p className="text-xs text-rbai-text-light mb-2 flex items-center gap-1">
                        <CheckCircle className="h-3 w-3 text-rbai-success" /> {deliveryNote}
                      </p>
                    )}
                    <div className="flex items-end gap-2">
                      <textarea
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Type your reply... (Enter to send)"
                        rows={1}
                        className="flex-1 px-4 py-2.5 text-sm border border-rbai-border rounded-xl bg-rbai-bg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary resize-none"
                        style={{ minHeight: "42px", maxHeight: "120px" }}
                        onInput={(e) => {
                          const t = e.target as HTMLTextAreaElement;
                          t.style.height = "auto";
                          t.style.height = Math.min(t.scrollHeight, 120) + "px";
                        }}
                      />
                      <button
                        onClick={handleSendReply}
                        disabled={!replyText.trim() || sending}
                        className={cn(
                          "p-2.5 rounded-xl transition-colors flex-shrink-0",
                          replyText.trim() && !sending
                            ? "bg-rbai-primary text-white hover:bg-rbai-primary-dark"
                            : "bg-rbai-border text-rbai-text-light cursor-not-allowed"
                        )}
                      >
                        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium",
            toast.type === "success" ? "bg-rbai-success text-white" : "bg-rbai-danger text-white"
          )}
        >
          {toast.type === "success" ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {toast.message}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Comments panel — the FB/IG comment approval queue.
// ---------------------------------------------------------------------------

function CommentsPanel({
  comments,
  loading,
  onApprove,
  onDismiss,
  onRetry,
}: {
  comments: CommentItem[];
  loading: boolean;
  onApprove: (id: string, text: string) => void;
  onDismiss: (id: string) => void;
  onRetry: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const c of comments) next[c.id] = c.draftReply || "";
    setDrafts(next);
  }, [comments]);

  const platformChip = (p: string) =>
    p === "facebook"
      ? "text-[#1877F2] bg-blue-50"
      : p === "instagram"
        ? "text-pink-600 bg-pink-50"
        : "text-slate-600 bg-slate-100";

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-rbai-primary" />
      </div>
    );
  }

  if (comments.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <div className="p-5 rounded-full bg-rbai-surface border border-rbai-border mb-4">
          <CheckCircle className="h-10 w-10 text-rbai-success" />
        </div>
        <p className="font-semibold text-lg text-rbai-text">Comment queue is clear</p>
        <p className="text-sm text-rbai-text-light mt-1 max-w-sm">
          New Facebook and Instagram comments will appear here with an AI-drafted reply for your approval.
        </p>
        <button
          onClick={onRetry}
          className="mt-4 px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary/90 transition-colors"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-rbai-bg">
      <div className="max-w-3xl mx-auto space-y-4">
        <p className="text-sm text-rbai-text-light">
          The AI drafted a reply for each comment below — <span className="font-medium text-rbai-text">nothing is posted until you approve it</span>.
          Edit the draft or send it as-is. Enable auto-reply per account in Channels to skip approval.
        </p>
        {comments.map((c) => (
          <div key={c.id} className="bg-rbai-surface rounded-xl border border-rbai-border overflow-hidden">
            <div className="px-5 py-4 border-b border-rbai-border">
              <div className="flex items-center gap-2 mb-2">
                <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold capitalize", platformChip(c.platform))}>
                  {c.platform}
                </span>
                <span className="text-xs text-rbai-text-light">{formatRelativeTime(c.createdAt)}</span>
              </div>
              <p className="text-sm text-rbai-text whitespace-pre-wrap">{c.content}</p>
            </div>
            <div className="px-5 py-4">
              <label className="block text-xs font-medium text-rbai-text-light mb-1.5">
                AI-drafted reply (edit before sending)
              </label>
              <textarea
                value={drafts[c.id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                rows={3}
                placeholder="No draft yet — write the reply yourself"
                className="w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary resize-y"
              />
              <div className="flex items-center gap-2 mt-3">
                <button
                  type="button"
                  disabled={busy === c.id || !(drafts[c.id] || "").trim()}
                  onClick={async () => {
                    setBusy(c.id);
                    await onApprove(c.id, drafts[c.id] || "");
                    setBusy(null);
                  }}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-rbai-primary rounded-lg hover:bg-rbai-primary-dark disabled:opacity-50 transition-colors"
                >
                  {busy === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Approve &amp; Send
                </button>
                <button
                  type="button"
                  disabled={busy === c.id}
                  onClick={() => onDismiss(c.id)}
                  className="px-4 py-2 text-sm font-medium text-rbai-text-light border border-rbai-border rounded-lg hover:bg-rbai-bg transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
