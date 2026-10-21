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
    "- Address EVERY customer as স্যার/ম্যাডাম (Sir/Madam) in every reply.",
    "",
    "CONVINCE & RETAIN — NEVER A DEAD END:",
    "- Never end with a dead end; always offer an alternative or a roadmap item as coming soon.",
    "",
    "HONESTY — NEVER HALLUCINATE:",
    "- Fares: NEVER quote any fare figure or amount. There is NO public rate chart — every delivery/ride charge is calculated from the road distance and confirmed with the customer when they order. NEVER invent a per-km rate or any other number.",
  ].join("\n"),
  knowledgeBase: [
    {
      category: "Fares",
      title: "Fares — distance-based, never quote figures",
      content:
        "FARES — NEVER QUOTE FIGURES: Ride Bangla has NO public fare/rate chart. Every delivery/ride charge is calculated from the delivery (road) distance and confirmed with the customer when they order. The agent must NEVER quote, guess or promise any fare amount. NEVER invent a per-km rate or any taka amount. If a customer asks the price, explain the charge depends on the road distance and is confirmed at order time.",
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
    expect(prompt).not.toContain("৳50");
    expect(prompt).not.toContain("৳70");
    expect(prompt).not.toContain("0–5 km");
    expect(prompt).not.toContain("MAY QUOTE");
    expect(prompt).toContain("NEVER QUOTE FIGURES");
    expect(prompt).toContain("NEVER invent a per-km rate");
    expect(prompt).toContain("FARIDPUR DISTRICT ONLY");
    expect(prompt).toContain("শীঘ্রই আসছে");
  });
});
