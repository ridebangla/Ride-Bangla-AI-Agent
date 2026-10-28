"use client";

/**
 * Attention summary page — TIPS Leg A, STAGED ONLY.
 *
 * Thin mount for the AttentionSummary component. All wording in
 * the component is PROPOSAL for owner approval. This page SENDS
 * NOTHING; it only renders the read-only summary and links to the
 * Follow-up Queues page (Leg B) and the Orders page (Leg E), where
 * the team acts thread by thread.
 */

import { Header } from "@/components/layout/header";
import AttentionSummary from "@/components/attention/attention-summary";

export default function AttentionSummaryPage() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Header
        title="Attention summary"
        description="Unreplied threads by how long they have been silent — counts only"
      />
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <AttentionSummary />
      </div>
    </div>
  );
}
