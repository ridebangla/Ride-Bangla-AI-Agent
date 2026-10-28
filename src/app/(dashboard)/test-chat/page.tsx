/**
 * Test chat dashboard page — STAGED ONLY (test-chat sandbox leg).
 * Route: /test-chat (sidebar: Test chat, after Inbox).
 *
 * WHAT THE OWNER DOES HERE, IN ORDER:
 *  1. Starts a test session and chats with their OWN agent in TEST
 *     mode — many turns, live behaviour text + live knowledge —
 *     before enabling it live. Every bubble, every stored row, and
 *     every API response in this flow is labelled TEST.
 *  2. Ends the test (close) when done. Closing never deletes the
 *     test history and never touches a customer conversation.
 *  3. Goes live with ONE click: the button sends exactly
 *     { aiEnabled: true } through the EXISTING Settings PUT — the
 *     same switch in Settings > AI, no second settings writer, no
 *     new permission. Going live converts nothing: test history
 *     stays test history forever.
 *
 * HONEST LIVE STATE (read before changing this page):
 * At HEAD the engine reads settings.aiEnabled !== false, so a
 * tenant that never touched the switch is already live by
 * default. This page therefore never claims a test session is
 * itself a live gate. It shows one of three states, from
 * GET /api/test-chat: explicitly ON, explicitly OFF, or never
 * set (default ON). The pre-live flow is the tenant's own
 * discipline: keep the switch OFF while testing, then Go live.
 *
 * TEST-CHAT IS A TESTING TOOL, NOT A TEACHING PATH. Nothing typed
 * here teaches the agent, writes knowledge, or changes
 * website/details data. Website/details remain the primary
 * source; this page only tests what the live agent would say.
 *
 * This page never sends on load: only the Send button posts a
 * test turn, only End test closes a session, and only Go live
 * touches Settings. All wording on this page is PROPOSAL for the
 * owner's approval.
 */
"use client";

import { goLivePayload } from "@/lib/test-chat";
import { useCallback, useEffect, useState } from "react";

interface TestSessionRow {
  id: string;
  isTest: true;
  status: "open" | "closed";
  title: string;
  createdByName: string;
  startedWhileLive: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface TestMessageRow {
  id: string;
  sessionId: string;
  isTest: true;
  role: "tester" | "assistant";
  channel: "test-chat";
  content: string;
  model: string;
  createdAt: string;
}

export default function TestChatPage() {
  const [sessions, setSessions] = useState<TestSessionRow[]>([]);
  const [agentLive, setAgentLive] = useState(true);
  const [agentLiveExplicit, setAgentLiveExplicit] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TestSessionRow | null>(null);
  const [messages, setMessages] = useState<TestMessageRow[]>([]);
  const [title, setTitle] = useState("");
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/test-chat");
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions || []);
      setAgentLive(data.agentLive !== false);
      setAgentLiveExplicit(data.agentLiveExplicit === true);
    } catch {
      /* list refresh is best-effort; the tester can retry */
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/test-chat/${id}`);
      if (!res.ok) {
        setNotice("That test session could not be opened.");
        return;
      }
      const data = await res.json();
      setSelected(data.session || null);
      setMessages(data.messages || []);
      setSelectedId(id);
    } catch {
      setNotice("That test session could not be opened.");
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function startSession() {
    setNotice("");
    setBusy(true);
    try {
      const res = await fetch("/api/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(data.error || "That test session did not start.");
        return;
      }
      setTitle("");
      await loadList();
      if (data.session?.id) await loadSession(data.session.id);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!selectedId || !input.trim()) return;
    setNotice("");
    setBusy(true);
    try {
      const res = await fetch(`/api/test-chat/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(data.error || "That test reply did not come back.");
        return;
      }
      setInput("");
      setSelected(data.session || null);
      setMessages(data.messages || []);
    } finally {
      setBusy(false);
    }
  }

  async function closeSession() {
    if (!selectedId) return;
    setNotice("");
    const res = await fetch(`/api/test-chat/${selectedId}/close`, {
      method: "POST",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNotice(data.error || "That test session did not close.");
      return;
    }
    setSelected(data.session || null);
    await loadList();
  }

  async function goLive() {
    setNotice("");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goLivePayload()),
    });
    if (!res.ok) {
      setNotice(
        "Going live did not go through. Only an admin can enable the agent live."
      );
      return;
    }
    setNotice("Agent is now live.");
    await loadList();
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Test chat</h1>

      <div className="border rounded p-3 bg-amber-50">
        <p className="text-sm font-semibold">
          TEST MODE — This chat is only for testing.
        </p>
        <p className="text-sm text-gray-600">
          Nothing here is sent to customers, and nothing here counts
          as a real conversation, order, or usage. Testing does not
          teach the agent: website and business details remain the
          primary source.
        </p>
      </div>

      {notice && <p className="text-sm border rounded p-2">{notice}</p>}

      <section className="border rounded p-3 space-y-2">
        <h2 className="font-semibold">Go live</h2>
        {agentLive && agentLiveExplicit ? (
          <p className="text-sm text-gray-600">
            Agent is already live. Test sessions stay test-only and
            are never shown to customers.
          </p>
        ) : agentLive && !agentLiveExplicit ? (
          <p className="text-sm text-gray-600">
            Agent switch was never set — the platform default is ON,
            so customers already reach the live agent. Go live makes
            the ON state explicit through Settings.
          </p>
        ) : (
          <p className="text-sm text-gray-600">
            Agent switch is OFF. Test as much as you like, then go
            live with one click when you are ready.
          </p>
        )}
        <button
          type="button"
          onClick={goLive}
          disabled={busy || (agentLive && agentLiveExplicit)}
          className="border rounded px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {agentLive && agentLiveExplicit
            ? "Agent is live"
            : agentLive
              ? "Make live explicit"
              : "Go live"}
        </button>
        <p className="text-xs text-gray-500">
          Going live only flips the existing AI switch in Settings.
          It does not publish test chats or change test history.
        </p>
      </section>

      <section className="border rounded p-3 space-y-2">
        <h2 className="font-semibold">Start a test session</h2>
        <label className="flex items-center gap-2 text-sm">
          <span>Title (optional)</span>
          <input
            className="border rounded px-2 py-1 flex-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. First test before going live"
          />
        </label>
        <button
          type="button"
          onClick={startSession}
          disabled={busy}
          className="border rounded px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Start test session
        </button>
        {sessions.length === 0 ? (
          <p className="text-sm text-gray-600">
            No test sessions yet. Start one above to chat with your
            agent in TEST mode.
          </p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => loadSession(s.id)}
                  className="text-sm underline"
                >
                  TEST — {s.title || "Untitled test"} ({s.status},{" "}
                  {s.messageCount} turns)
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section className="border rounded p-3 space-y-2">
          <h2 className="font-semibold">
            TEST — {selected.title || "Untitled test"} ({selected.status})
          </h2>
          <p className="text-xs text-gray-500">
            TEST session. Replies below were never sent to a customer.
          </p>
          <div className="space-y-2">
            {messages.length === 0 ? (
              <p className="text-sm text-gray-600">
                No test turns yet. Send a message below to test your
                agent.
              </p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className="border rounded p-2">
                  <p className="text-xs font-semibold">
                    {m.role === "tester"
                      ? "You (tester)"
                      : "Agent reply — TEST (not sent)"}
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                </div>
              ))
            )}
          </div>
          {selected.status === "open" ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <span>Test message</span>
                <input
                  className="border rounded px-2 py-1 flex-1"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void send();
                  }}
                  placeholder="Type a message a customer might send"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={send}
                  disabled={busy || !input.trim()}
                  className="border rounded px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Send test message
                </button>
                <button
                  type="button"
                  onClick={closeSession}
                  disabled={busy}
                  className="border rounded px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  End test
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-600">
              This test session is closed. Start a new test session
              to keep testing.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
