"use client";

import { Header } from "@/components/layout/header";
import {
  Plus,
  Trash2,
  RefreshCw,
  Send,
  CheckCircle2,
  Clock,
  XCircle,
  MessageSquare,
  BarChart3,
  CalendarClock,
  Users,
  Terminal,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

interface SocialAccountData {
  id: string;
  platform: string;
  label: string;
  accountRef: string;
  tokenHint: string;
  isActive: boolean;
  lastSyncAt: string | null;
}

interface ScheduledPostData {
  id: string;
  platform: string;
  postType: string;
  topic: string;
  scheduledAt: string;
  status: string;
  resultRef: string;
  error: string;
}

interface InteractionData {
  id: string;
  platform: string;
  kind: string;
  content: string;
  likes: number;
  replied: boolean;
  repliedAt: string | null;
  createdAt: string;
}

interface AudienceProfileData {
  id: string;
  platform: string;
  data: {
    stats?: {
      totalInteractions: number;
      comments: number;
      messages: number;
      replyRate: number;
      totalLikes: number;
    };
    topTopics?: Array<{ topic: string; score: number }>;
    bestHours?: number[];
    sampleQuestions?: string[];
    updatedAt?: string;
  };
}

interface CommandData {
  id: string;
  command: string;
  status: string;
  result: string;
  createdAt: string;
}

const PLATFORMS = ["facebook", "instagram", "x"];
const POST_TYPES = ["promo", "announcement", "engagement", "tip"];

const cardClass =
  "bg-rbai-surface rounded-xl border border-rbai-border p-4";
const inputClass =
  "w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary text-rbai-text";
const labelClass = "block text-xs font-medium text-rbai-text-light mb-1";
const primaryBtn =
  "flex items-center gap-2 px-4 py-2 bg-rbai-primary text-white rounded-lg hover:bg-rbai-primary-dark transition-colors text-sm font-medium disabled:opacity-50";

function SectionTitle({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-3">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-rbai-primary/10 text-rbai-primary">
          {icon}
        </div>
        <div>
          <h3 className="text-base font-semibold text-rbai-text">{title}</h3>
          <p className="text-sm text-rbai-text-light">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    scheduled: "bg-blue-500/10 text-blue-600",
    posted: "bg-green-500/10 text-green-600",
    failed: "bg-red-500/10 text-red-600",
    cancelled: "bg-gray-500/10 text-gray-500",
    queued: "bg-blue-500/10 text-blue-600",
    running: "bg-amber-500/10 text-amber-600",
    done: "bg-green-500/10 text-green-600",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
        map[status] || "bg-gray-500/10 text-gray-500"
      )}
    >
      {status}
    </span>
  );
}

export default function SocialAutomationPage() {
  const [accounts, setAccounts] = useState<SocialAccountData[]>([]);
  const [posts, setPosts] = useState<ScheduledPostData[]>([]);
  const [interactions, setInteractions] = useState<InteractionData[]>([]);
  const [audiences, setAudiences] = useState<AudienceProfileData[]>([]);
  const [commands, setCommands] = useState<CommandData[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [accountForm, setAccountForm] = useState({
    platform: "facebook",
    label: "",
    accountRef: "",
    token: "",
  });
  const [postForm, setPostForm] = useState({
    platform: "facebook",
    postType: "promo",
    topic: "",
    scheduledAt: "",
  });
  const [commandText, setCommandText] = useState("");

  const fetchAll = useCallback(async () => {
    try {
      const [a, p, i, au, c] = await Promise.all([
        fetch("/api/social/accounts").then((r) => r.json()),
        fetch("/api/social/scheduled-posts").then((r) => r.json()),
        fetch("/api/social/engagement").then((r) => r.json()),
        fetch("/api/social/audience").then((r) => r.json()),
        fetch("/api/agent/commands").then((r) => r.json()),
      ]);
      if (Array.isArray(a)) setAccounts(a);
      if (Array.isArray(p)) setPosts(p);
      if (Array.isArray(i)) setInteractions(i);
      if (Array.isArray(au)) setAudiences(au);
      if (Array.isArray(c)) setCommands(c);
    } catch {
      setError("Failed to load social data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  async function postJson(url: string, body?: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const handleAddAccount = async () => {
    if (!accountForm.accountRef.trim() || !accountForm.token.trim()) return;
    setBusy("account");
    setError(null);
    try {
      await postJson("/api/social/accounts", accountForm);
      setAccountForm({ platform: "facebook", label: "", accountRef: "", token: "" });
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add account.");
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!confirm("Disconnect this social account?")) return;
    setBusy("account");
    try {
      const res = await fetch(`/api/social/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed.");
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete account.");
    } finally {
      setBusy(null);
    }
  };

  const handleSchedulePost = async () => {
    if (!postForm.topic.trim() || !postForm.scheduledAt) return;
    setBusy("post");
    setError(null);
    try {
      await postJson("/api/social/scheduled-posts", postForm);
      setPostForm({ platform: "facebook", postType: "promo", topic: "", scheduledAt: "" });
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to schedule post.");
    } finally {
      setBusy(null);
    }
  };

  const handleDeletePost = async (id: string) => {
    if (!confirm("Delete this scheduled post?")) return;
    setBusy("post");
    try {
      const res = await fetch(`/api/social/scheduled-posts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed.");
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete post.");
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (key: string, url: string) => {
    setBusy(key);
    setError(null);
    try {
      const data = await postJson(url);
      if (data.limitations) {
        setError(`Done with notes: ${data.limitations.join(" | ")}`);
      }
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const handleRunCommand = async () => {
    if (!commandText.trim()) return;
    setBusy("command");
    setError(null);
    try {
      await postJson("/api/agent/commands", { command: commandText });
      setCommandText("");
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to queue command.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Header
        title="Social Automation"
        description="Scheduled text and picture posts, comment and message replies, audience insights, and the admin command queue"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => runAction("sync", "/api/social/engagement/sync")}
              disabled={busy !== null}
              className="flex items-center gap-2 px-3 py-2 border border-rbai-border rounded-lg text-sm hover:bg-rbai-bg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("h-4 w-4", busy === "sync" && "animate-spin")} />
              Sync engagement
            </button>
            <button
              onClick={() => runAction("process", "/api/social/process")}
              disabled={busy !== null}
              className={primaryBtn}
            >
              <Send className="h-4 w-4" />
              Run scheduler
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {error && (
          <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm text-rbai-text">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-rbai-text-light">Loading...</div>
        ) : (
          <>
            {/* Connected accounts */}
            <section className={cardClass}>
              <SectionTitle
                icon={<Users className="h-5 w-5" />}
                title="Connected accounts"
                description="Facebook pages, Instagram business accounts, and X accounts. Tokens are stored encrypted."
              />
              <div className="grid gap-2 mb-4">
                {accounts.length === 0 && (
                  <p className="text-sm text-rbai-text-light">No accounts connected yet.</p>
                )}
                {accounts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-lg border border-rbai-border"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-rbai-text">
                        {a.label || a.accountRef}
                        <span className="ml-2 text-xs text-rbai-text-light">{a.platform}</span>
                      </div>
                      <div className="text-xs text-rbai-text-light truncate">
                        {a.accountRef} · token {a.tokenHint}
                        {a.lastSyncAt && (
                          <> · synced {new Date(a.lastSyncAt).toLocaleString()}</>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteAccount(a.id)}
                      className="p-2 rounded-lg text-red-600 hover:bg-red-500/10 transition-colors"
                      title="Disconnect account"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                <div>
                  <label className={labelClass}>Platform</label>
                  <select
                    value={accountForm.platform}
                    onChange={(e) => setAccountForm({ ...accountForm, platform: e.target.value })}
                    className={inputClass}
                  >
                    {PLATFORMS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Label</label>
                  <input
                    value={accountForm.label}
                    onChange={(e) => setAccountForm({ ...accountForm, label: e.target.value })}
                    placeholder="Main page"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Page ID / account ref</label>
                  <input
                    value={accountForm.accountRef}
                    onChange={(e) => setAccountForm({ ...accountForm, accountRef: e.target.value })}
                    placeholder="e.g. 123456789"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Access token</label>
                  <input
                    type="password"
                    value={accountForm.token}
                    onChange={(e) => setAccountForm({ ...accountForm, token: e.target.value })}
                    placeholder="Paste token"
                    className={inputClass}
                    autoComplete="off"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={handleAddAccount}
                    disabled={busy === "account"}
                    className={primaryBtn}
                  >
                    <Plus className="h-4 w-4" />
                    Connect
                  </button>
                </div>
              </div>
            </section>

            {/* Scheduled posts */}
            <section className={cardClass}>
              <SectionTitle
                icon={<CalendarClock className="h-5 w-5" />}
                title="Scheduled posts"
                description="Text and picture posts only — no video. The scheduler publishes due posts automatically."
              />
              <div className="grid gap-2 mb-4">
                {posts.length === 0 && (
                  <p className="text-sm text-rbai-text-light">No posts scheduled.</p>
                )}
                {posts.slice(0, 15).map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-lg border border-rbai-border"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusBadge status={p.status} />
                        <span className="text-sm font-medium text-rbai-text truncate">
                          {p.topic}
                        </span>
                        <span className="text-xs text-rbai-text-light">
                          {p.platform} · {p.postType}
                        </span>
                      </div>
                      <div className="text-xs text-rbai-text-light mt-1">
                        {new Date(p.scheduledAt).toLocaleString()}
                        {p.resultRef && <> · ref {p.resultRef}</>}
                        {p.error && <span className="text-red-600"> · {p.error.slice(0, 120)}</span>}
                      </div>
                    </div>
                    {p.status === "scheduled" && (
                      <button
                        onClick={() => handleDeletePost(p.id)}
                        className="p-2 rounded-lg text-red-600 hover:bg-red-500/10 transition-colors"
                        title="Delete scheduled post"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                <div>
                  <label className={labelClass}>Platform</label>
                  <select
                    value={postForm.platform}
                    onChange={(e) => setPostForm({ ...postForm, platform: e.target.value })}
                    className={inputClass}
                  >
                    {PLATFORMS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Type</label>
                  <select
                    value={postForm.postType}
                    onChange={(e) => setPostForm({ ...postForm, postType: e.target.value })}
                    className={inputClass}
                  >
                    {POST_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Topic</label>
                  <input
                    value={postForm.topic}
                    onChange={(e) => setPostForm({ ...postForm, topic: e.target.value })}
                    placeholder="e.g. Friday delivery offer"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Scheduled at</label>
                  <input
                    type="datetime-local"
                    value={postForm.scheduledAt}
                    onChange={(e) => setPostForm({ ...postForm, scheduledAt: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={handleSchedulePost}
                    disabled={busy === "post"}
                    className={primaryBtn}
                  >
                    <Plus className="h-4 w-4" />
                    Schedule
                  </button>
                </div>
              </div>
            </section>

            {/* Recent interactions */}
            <section className={cardClass}>
              <SectionTitle
                icon={<MessageSquare className="h-5 w-5" />}
                title="Recent interactions"
                description="Comments and messages seen across connected accounts, and whether each got a reply."
                action={
                  <button
                    onClick={() => runAction("sync", "/api/social/engagement/sync")}
                    disabled={busy !== null}
                    className="flex items-center gap-2 px-3 py-2 border border-rbai-border rounded-lg text-sm hover:bg-rbai-bg transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={cn("h-4 w-4", busy === "sync" && "animate-spin")} />
                    Sync now
                  </button>
                }
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-rbai-text-light border-b border-rbai-border">
                      <th className="py-2 pr-3 font-medium">Platform</th>
                      <th className="py-2 pr-3 font-medium">Kind</th>
                      <th className="py-2 pr-3 font-medium">Content</th>
                      <th className="py-2 pr-3 font-medium">Likes</th>
                      <th className="py-2 pr-3 font-medium">Replied</th>
                      <th className="py-2 font-medium">Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {interactions.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-4 text-rbai-text-light">
                          No interactions yet. Run a sync.
                        </td>
                      </tr>
                    )}
                    {interactions.slice(0, 25).map((i) => (
                      <tr key={i.id} className="border-b border-rbai-border/50">
                        <td className="py-2 pr-3 text-rbai-text">{i.platform}</td>
                        <td className="py-2 pr-3 text-rbai-text">{i.kind}</td>
                        <td className="py-2 pr-3 text-rbai-text-light max-w-[320px] truncate">
                          {i.content || "—"}
                        </td>
                        <td className="py-2 pr-3 text-rbai-text">{i.likes}</td>
                        <td className="py-2 pr-3">
                          {i.replied ? (
                            <span className="inline-flex items-center gap-1 text-xs text-green-600">
                              <CheckCircle2 className="h-3.5 w-3.5" /> yes
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                              <Clock className="h-3.5 w-3.5" /> pending
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-xs text-rbai-text-light">
                          {new Date(i.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Audience */}
            <section className={cardClass}>
              <SectionTitle
                icon={<BarChart3 className="h-5 w-5" />}
                title="Audience insights"
                description="Learned from real engagement: top topics, best posting hours, common questions."
                action={
                  <button
                    onClick={() => runAction("analyze", "/api/social/audience/analyze")}
                    disabled={busy !== null}
                    className="flex items-center gap-2 px-3 py-2 border border-rbai-border rounded-lg text-sm hover:bg-rbai-bg transition-colors disabled:opacity-50"
                  >
                    <BarChart3 className="h-4 w-4" />
                    Analyze
                  </button>
                }
              />
              {audiences.length === 0 && (
                <p className="text-sm text-rbai-text-light">
                  No audience data yet. Sync engagement, then run Analyze.
                </p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {audiences.map((a) => (
                  <div key={a.id} className="p-3 rounded-lg border border-rbai-border">
                    <div className="text-sm font-semibold text-rbai-text mb-2">{a.platform}</div>
                    <div className="text-xs text-rbai-text-light space-y-1">
                      <div>Interactions: {a.data.stats?.totalInteractions ?? 0}</div>
                      <div>
                        Comments {a.data.stats?.comments ?? 0} · Messages{" "}
                        {a.data.stats?.messages ?? 0} · Likes {a.data.stats?.totalLikes ?? 0}
                      </div>
                      <div>
                        Reply rate:{" "}
                        {(((a.data.stats?.replyRate ?? 0) * 100) || 0).toFixed(0)}%
                      </div>
                      {a.data.topTopics && a.data.topTopics.length > 0 && (
                        <div className="pt-1">
                          <span className="font-medium text-rbai-text">Top topics:</span>{" "}
                          {a.data.topTopics.slice(0, 8).map((t) => t.topic).join(", ")}
                        </div>
                      )}
                      {a.data.bestHours && a.data.bestHours.length > 0 && (
                        <div>
                          <span className="font-medium text-rbai-text">Best hours:</span>{" "}
                          {a.data.bestHours.map((h) => `${h}:00`).join(", ")}
                        </div>
                      )}
                      {a.data.sampleQuestions && a.data.sampleQuestions.length > 0 && (
                        <div className="pt-1">
                          <span className="font-medium text-rbai-text">Sample question:</span>
                          <div className="italic">“{a.data.sampleQuestions[0]}”</div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Command queue */}
            <section className={cardClass}>
              <SectionTitle
                icon={<Terminal className="h-5 w-5" />}
                title="Command queue"
                description="Write a task in plain words; the agent executes it (schedule posts, publish now, sync, summarize audience)."
                action={
                  <button
                    onClick={() => runAction("commands", "/api/agent/commands/process")}
                    disabled={busy !== null}
                    className="flex items-center gap-2 px-3 py-2 border border-rbai-border rounded-lg text-sm hover:bg-rbai-bg transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={cn("h-4 w-4", busy === "commands" && "animate-spin")} />
                    Process one
                  </button>
                }
              />
              <div className="flex gap-2 mb-4">
                <input
                  value={commandText}
                  onChange={(e) => setCommandText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleRunCommand()}
                  placeholder="e.g. Schedule a promo post about Friday delivery on Facebook for tomorrow at 6pm"
                  className={inputClass}
                />
                <button
                  onClick={handleRunCommand}
                  disabled={busy === "command" || !commandText.trim()}
                  className={primaryBtn}
                >
                  <Plus className="h-4 w-4" />
                  Queue
                </button>
              </div>
              <div className="grid gap-2">
                {commands.length === 0 && (
                  <p className="text-sm text-rbai-text-light">No commands yet.</p>
                )}
                {commands.slice(0, 10).map((c) => (
                  <div
                    key={c.id}
                    className="p-3 rounded-lg border border-rbai-border"
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <StatusBadge status={c.status} />
                      <span className="text-sm text-rbai-text">{c.command}</span>
                    </div>
                    {c.result && (
                      <div className="text-xs text-rbai-text-light whitespace-pre-wrap">
                        {c.status === "failed" && (
                          <XCircle className="inline h-3.5 w-3.5 mr-1 text-red-600" />
                        )}
                        {c.result.slice(0, 500)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
