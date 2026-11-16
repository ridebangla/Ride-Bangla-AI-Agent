"use client";

/**
 * /contact/thread — support chat. Signed-in account: no id → ticket list; ?id → chat. Tools visitors: ?id&k link, works while it is open.
 * Shows Admin Console replies and lets the visitor answer. Polls every 8s.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface Msg {
  id: string;
  text: string;
  fromStaff: boolean;
  createdAt: number;
}

function LoginNeeded() {
  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-800">
      <p>Please log in to see your support tickets and chat with the team.</p>
      <Link href="/login" className="mt-4 inline-block rounded-lg bg-[#4A7C9B] px-5 py-2 text-sm font-semibold text-white">
        Log in
      </Link>
    </div>
  );
}

function TicketList() {
  const [tickets, setTickets] = useState<{ id: string; subject: string; status: string }[] | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/contact/thread", { cache: "no-store" });
        if (res.status === 401) {
          if (alive) setNeedsLogin(true);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (alive) setTickets(data.tickets || []);
      } catch {
        if (alive) setError("Could not load your tickets. Please try again.");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-bold text-slate-900">My support tickets</h1>
      {needsLogin ? <LoginNeeded /> : null}
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
      {tickets && tickets.length === 0 ? (
        <p className="mt-6 text-sm text-slate-600">
          You have no tickets yet. <Link href="/contact" className="underline">Send one</Link>.
        </p>
      ) : null}
      <div className="mt-6 space-y-3">
        {(tickets || []).map((t) => (
          <Link key={t.id} href={`/contact/thread?id=${encodeURIComponent(t.id)}`} className="block rounded-2xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-900">{t.subject}</p>
            <p className="mt-1 text-xs uppercase tracking-wider text-slate-500">{t.status.replace(/_/g, " ")}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}

function Chat({ id, k }: { id: string; k: string }) {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [subject, setSubject] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError("This chat link is incomplete.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/contact/thread?id=${encodeURIComponent(id)}${k ? `&k=${encodeURIComponent(k)}` : ""}`, { cache: "no-store" });
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (res.status === 404) {
        setError("Ticket not found. Check your chat link.");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setMessages(data.messages || []);
      setSubject(data.subject || "");
      setStatus(data.status || "");
      setError("");
    } catch {
      setError("Could not load messages. Retrying…");
    } finally {
      setLoading(false);
    }
  }, [id, k]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (text.length < 2 || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/contact/thread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, k, message: text }),
      });
      if (res.status === 429) throw new Error("Too many messages. Please wait a while.");
      if (!res.ok) throw new Error("Could not send your message. Please try again.");
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-bold text-slate-900">{subject || "Support chat"}</h1>
      {status ? <p className="mt-1 text-xs uppercase tracking-wider text-slate-600">{status.replace(/_/g, " ")}</p> : null}
      {needsLogin ? <LoginNeeded /> : null}
      {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
      <div className="border border-slate-200 mt-6 space-y-3 rounded-2xl p-4">
        {loading ? <p className="text-sm text-slate-600">Loading…</p> : null}
        {messages.map((m) => (
          <div key={m.id} className={m.fromStaff ? "mr-10" : "ml-10 text-right"}>
            <p className="text-[11px] font-semibold text-slate-600">{m.fromStaff ? "Ride Bangla Support" : "You"}</p>
            <p className="inline-block whitespace-pre-wrap rounded-xl bg-slate-100 px-3 py-2 text-left text-sm text-slate-900">{m.text}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={send} className="mt-4 flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Write a message…"
          className="flex-1 rounded-xl border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900"
        />
        <button type="submit" disabled={sending || draft.trim().length < 2} className="bg-[#4A7C9B] text-white rounded-xl px-5 text-sm font-semibold disabled:opacity-50">
          {sending ? "…" : "Send"}
        </button>
      </form>
    </main>
  );
}

function Thread() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  const k = params.get("k") || "";
  return id ? <Chat id={id} k={k} /> : <TicketList />;
}

export default function ContactThreadPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      <header className="border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center">
          <Link href="/" className="font-bold">Ride Bangla AI Agent</Link>
        </div>
      </header>
      <Suspense fallback={null}>
        <Thread />
      </Suspense>
    </div>
  );
}
