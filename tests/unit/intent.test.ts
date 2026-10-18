import { describe, it, expect } from "vitest";
import { classifyIntent, getIntentGuidance, RETENTION_DOCTRINE, UNAVAILABLE_PRODUCT_RULE } from "@/lib/ai/intent";

describe("intent classification", () => {
  it("detects price inquiries (EN + BN)", () => {
    expect(classifyIntent("What is the price of delivery?").intent).toBe("price_inquiry");
    expect(classifyIntent("ভাড়া কত?").intent).toBe("price_inquiry");
  });

  it("detects order requests", () => {
    expect(classifyIntent("I want to book a ride").intent).toBe("order_request");
    expect(classifyIntent("অর্ডার করতে চাই").intent).toBe("order_request");
  });

  it("detects complaints", () => {
    expect(classifyIntent("My parcel is late and broken").intent).toBe("complaint");
  });

  it("detects human handoff requests", () => {
    expect(classifyIntent("Connect me to a human agent please").intent).toBe("human_handoff");
  });

  it("detects greetings", () => {
    expect(classifyIntent("আসসালামু আলাইকুম").intent).toBe("greeting");
    expect(classifyIntent("Hello there").intent).toBe("greeting");
  });

  it("detects cancel/refund requests", () => {
    expect(classifyIntent("I want to cancel my order").intent).toBe("cancel_request");
  });

  it("falls back to other with low confidence", () => {
    const r = classifyIntent("zxqw asdf");
    expect(r.intent).toBe("other");
    expect(r.confidence).toBe("low");
  });

  it("gives strategy guidance for every intent", () => {
    const intents = [
      "greeting", "price_inquiry", "availability_inquiry", "order_request",
      "complaint", "support_request", "human_handoff", "cancel_request",
      "feedback_positive", "feedback_negative", "followup_question",
      "smalltalk", "other",
    ] as const;
    for (const intent of intents) {
      const g = getIntentGuidance(intent);
      expect(g.length).toBeGreaterThan(20);
    }
  });

  it("retention doctrine demands never walking away empty-handed", () => {
    expect(RETENTION_DOCTRINE).toMatch(/never.*walk away/i);
    expect(UNAVAILABLE_PRODUCT_RULE).toMatch(/alternative/i);
  });
});
