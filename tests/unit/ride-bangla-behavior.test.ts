import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/engine";
import type { ConversationContext } from "@/lib/ai/types";

/**
 * Ride Bangla knowledge + behavior upgrade.
 * The agentBehavior field (settings.agentBehavior) must be injected into the
 * system prompt as "Business Behavior Instructions", and the knowledge base
 * must carry the fare rules, honest Faridpur-only coverage and the
 * coming-soon roadmap framing.
 */
const baseContext: ConversationContext = {
  businessName: "Ride Bangla",
  businessDesc: "Ride Bangla multi-service platform. Currently serving Faridpur district only.",
  welcomeMessage: "Hello!",
  tone: "friendly",
  language: "auto",
  agentBehavior: [
    "CUSTOMER ADDRESS — MANDATORY:",
    "- Address EVERY customer as স্যার (Sir) / ম্যাডাম (Ma'am) in every reply.",
    "",
    "CONVINCE & RETAIN — NEVER A DEAD END:",
    "- Never end with a dead end; always offer an alternative or a roadmap item as coming soon.",
    "",
    "HONESTY — NEVER HALLUCINATE:",
    "- Fares you may quote: 0–5 km = ৳50, 5–7 km = ৳70. Above 7 km the team calculates manually — NEVER invent a per-km rate.",
  ].join("\n"),
  knowledgeBase: [
    {
      category: "Fares",
      title: "Fares — what the agent may quote",
      content:
        "Delivery/courier fare the AGENT MAY QUOTE: 0–5 km = ৳50, 5–7 km = ৳70. ABOVE 7 km: the team calculates the fare manually for each order — the agent must NEVER invent a per-km rate or any other number.",
      priority: 9,
    },
    {
      category: "Coverage",
      title: "Service Coverage",
      content:
        "HONEST coverage: Ride Bangla currently serves FARIDPUR DISTRICT ONLY (launch area).",
      priority: 9,
    },
    {
      category: "Roadmap",
      title: "Coming soon (roadmap — NEVER live)",
      content:
        'COMING SOON — always presented as "শীঘ্রই আসছে / coming soon", NEVER as live: Shariatpur next, then nationwide; Ride Bangla Studio.',
      priority: 8,
    },
  ],
  customerName: "Unknown",
  customerHistory: [],
  channel: "website",
};

describe("Ride Bangla behavior + knowledge wiring", () => {
  it("injects Business Behavior Instructions when agentBehavior is set", () => {
    const prompt = buildSystemPrompt(baseContext);
    expect(prompt).toContain("## Business Behavior Instructions");
    expect(prompt).toContain("স্যার");
    expect(prompt).toContain("ম্যাডাম");
    expect(prompt).toContain("NEVER A DEAD END");
  });

  it("omits the behavior section when agentBehavior is empty", () => {
    const prompt = buildSystemPrompt({ ...baseContext, agentBehavior: "" });
    expect(prompt).not.toContain("## Business Behavior Instructions");
  });

  it("carries fare rules, honest coverage and roadmap framing in the knowledge section", () => {
    const prompt = buildSystemPrompt(baseContext);
    expect(prompt).toContain("৳50");
    expect(prompt).toContain("৳70");
    expect(prompt).toContain("NEVER invent a per-km rate");
    expect(prompt).toContain("FARIDPUR DISTRICT ONLY");
    expect(prompt).toContain("শীঘ্রই আসছে");
  });
});
