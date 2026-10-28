"use client";

/**
 * LEG K — Team Performance dashboard page (STAGED ONLY).
 *
 * Shows exactly four stats per roster member — messages sent,
 * conversations, median response time, orders touched — plus one
 * visually distinct unattributed-team row. There is no fifth stat
 * column on this page, and no stat here is derived from any
 * owner-excluded record type.
 *
 * Attribution honesty is part of the UI, not just the report: the
 * explainer box under the table states, in plain words, that team
 * replies are recognised by a delivery-note heuristic, that no
 * message at HEAD records its sender, that per-member message and
 * response figures therefore cover sole-link conversations only,
 * and that unattributed work is shown whole, never split by
 * guesswork. A member with no recorded activity shows zeros and
 * "—" for the median (never an invented figure).
 *
 * ALL user-facing wording on this page is PROPOSAL for owner
 * approval (standing no-invented-copy rule) — approve or rewrite
 * the strings before landing; the numbers and gating are code.
 */

import { Header } from "@/components/layout/header";
import { useState, useEffect, useCallback } from "react";

interface MemberStat {
  memberId: string;
  memberName: string;
  departmentName: string | null;
  messagesSent: number;
  conversationsLinked: number;
  medianResponseMinutes: number | null;
  ordersTouched: number;
  soleLinkConversations: number;
  attribution: {
    messages: string;
    conversations: string;
    medianResponse: string;
    orders: string;
  };
}

interface BucketStat {
  messagesSent: number;
  conversations: number;
  medianResponseMinutes: number | null;
  ordersTouched: number;
}

interface Payload {
  windowDays: number;
  members: MemberStat[];
  unattributedTeam: BucketStat;
  teamRepliesTotal: number;
  attributionNote: string;
}

function fmtMedian(v: number | null): string {
  return v === null ? "—" : `${v} min`;
}

export default function TeamPerformancePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/team-performance?windowDays=${windowDays}`);
      if (res.status === 403) {
        setError(
          "Team performance is visible to supervisors and admins only.",
        );
        setData(null);
        return;
      }
      if (!res.ok) throw new Error("Failed to load team performance");
      setData(await res.json());
    } catch {
      setError("Failed to load team performance. Please try again.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <Header
        title="Team Performance"
        description="Per-member messages, conversations, response time, and orders touched"
      />
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-2">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                windowDays === d
                  ? "bg-rbai-primary text-white"
                  : "bg-rbai-surface border border-rbai-border text-rbai-text"
              }`}
            >
              Last {d} days
            </button>
          ))}
        </div>

        {loading && <p className="text-sm text-rbai-text-light">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {data && (
          <>
            <div className="bg-rbai-surface rounded-xl border border-rbai-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-rbai-border">
                    <th className="px-4 py-3 font-medium">Member</th>
                    <th className="px-4 py-3 font-medium">Messages sent</th>
                    <th className="px-4 py-3 font-medium">Conversations</th>
                    <th className="px-4 py-3 font-medium">
                      Median response time
                    </th>
                    <th className="px-4 py-3 font-medium">Orders touched</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr
                      key={m.memberId}
                      className="border-b border-rbai-border last:border-0"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">{m.memberName}</div>
                        {m.departmentName && (
                          <div className="text-xs text-rbai-text-light">
                            {m.departmentName}
                          </div>
                        )}
                        {m.messagesSent === 0 &&
                          m.conversationsLinked === 0 &&
                          m.ordersTouched === 0 && (
                            <div className="text-xs text-rbai-text-light">
                              No recorded activity in this window
                            </div>
                          )}
                      </td>
                      <td className="px-4 py-3">{m.messagesSent}</td>
                      <td className="px-4 py-3">{m.conversationsLinked}</td>
                      <td className="px-4 py-3">
                        {fmtMedian(m.medianResponseMinutes)}
                      </td>
                      <td className="px-4 py-3">{m.ordersTouched}</td>
                    </tr>
                  ))}
                  <tr className="bg-rbai-primary-50">
                    <td className="px-4 py-3">
                      <div className="font-medium">
                        Team work not linked to one member
                      </div>
                      <div className="text-xs text-rbai-text-light">
                        Shown whole, never split across members
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {data.unattributedTeam.messagesSent}
                    </td>
                    <td className="px-4 py-3">
                      {data.unattributedTeam.conversations}
                    </td>
                    <td className="px-4 py-3">
                      {fmtMedian(data.unattributedTeam.medianResponseMinutes)}
                    </td>
                    <td className="px-4 py-3">
                      {data.unattributedTeam.ordersTouched}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {data.members.length === 0 && (
              <p className="text-sm text-rbai-text-light">
                No team members on the roster yet.
              </p>
            )}
            <p className="text-xs text-rbai-text-light leading-relaxed">
              How these numbers are counted (please read): team replies are
              recognised by a delivery-note mark — dashboard team replies
              and AI replies are otherwise stored identically, so a team
              reply with no delivery note counts as AI. No message
              records which team member sent it, so a member&apos;s
              messages and response time cover only conversations linked
              to that member alone (by ticket assignment or takeover);
              conversations and orders linked to a member are counted
              for each linked member, so those two columns do not add
              up across rows. Orders are counts only — no money figures
              are shown here.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
