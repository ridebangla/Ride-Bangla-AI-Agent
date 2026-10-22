import { describe, it, expect } from "vitest";
import { buildGreetingReply } from "@/lib/ai/engine";

/**
 * Deterministic greeting replies (voice/video round 2026-10-22,
 * Item F). The greeting fast path no longer spends a provider
 * completion: buildGreetingReply composes the reply locally, so
 * these cases pin the EXACT texts (printed verbatim in the round
 * log for the owner's review), the language rules, and the
 * no-invented-facts discipline (business name only — no services,
 * prices or contact pushes).
 */
describe("buildGreetingReply", () => {
  it("answers a generic English greeting in English, in the business's name", () => {
    expect(buildGreetingReply("Hello", "Test Biz")).toBe(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(buildGreetingReply("hi", "Test Biz")).toBe(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(buildGreetingReply("hey", "Test Biz")).toBe(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
  });

  it("echoes the time of day for English time greetings", () => {
    expect(buildGreetingReply("Good morning", "Test Biz")).toBe(
      "Good morning, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(buildGreetingReply("good afternoon", "Test Biz")).toBe(
      "Good afternoon, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(buildGreetingReply("Good evening", "Test Biz")).toBe(
      "Good evening, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
  });

  it("answers a Latin-script salam with its traditional reply", () => {
    expect(buildGreetingReply("Assalamu Alaikum", "Test Biz")).toBe(
      "Wa alaikum assalam, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(buildGreetingReply("salam", "Test Biz")).toBe(
      "Wa alaikum assalam, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
  });

  it("answers a Bengali greeting in Bengali", () => {
    expect(buildGreetingReply("হাই", "Test Biz")).toBe(
      "হ্যালো, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(buildGreetingReply("হ্যালো", "Test Biz")).toBe(
      "হ্যালো, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
  });

  it("answers a Bengali salam with ওয়ালাইকুম আসসালাম", () => {
    expect(buildGreetingReply("আসসালামু আলাইকুম", "Test Biz")).toBe(
      "ওয়ালাইকুম আসসালাম, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(buildGreetingReply("সালাম", "Test Biz")).toBe(
      "ওয়ালাইকুম আসসালাম, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
  });

  it("echoes Bengali time-of-day greetings", () => {
    expect(buildGreetingReply("শুভ সকাল", "Test Biz")).toBe(
      "শুভ সকাল, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(buildGreetingReply("শুভ বিকেল", "Test Biz")).toBe(
      "শুভ বিকেল, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(buildGreetingReply("শুভ সন্ধ্যা", "Test Biz")).toBe(
      "শুভ সন্ধ্যা, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
  });

  it("is emoji-tolerant (kind detection unaffected by emoji)", () => {
    expect(buildGreetingReply("Hello 👋", "Test Biz")).toBe(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
    expect(buildGreetingReply("শুভ সকাল ☀️", "Test Biz")).toContain("শুভ সকাল");
  });

  it("lets the business language setting win over the script guess", () => {
    expect(buildGreetingReply("Hello", "Test Biz", "bn")).toBe(
      "হ্যালো, স্যার/ম্যাডাম! Test Biz-এ স্বাগতম। আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
    );
    expect(buildGreetingReply("হাই", "Test Biz", "en")).toBe(
      "Hello, Sir/Madam! Welcome to Test Biz. How can I help you today?"
    );
  });

  it("never invents facts: no services, prices, phone or links in any variant", () => {
    const greetings = [
      "Hello",
      "Good morning",
      "Assalamu Alaikum",
      "হাই",
      "আসসালামু আলাইকুম",
      "শুভ সকাল",
      "নমস্কার",
    ];
    for (const g of greetings) {
      const reply = buildGreetingReply(g, "Test Biz");
      expect(reply).not.toMatch(/৳|\$|price|fee|phone|whatsapp|http/i);
      expect(reply).not.toContain("সেবা");
      expect(reply.length).toBeLessThan(140);
    }
  });

  it("keeps the reply one line even for a hostile business name", () => {
    // The shared sanitizePromptLine collapses the newline, so the
    // interpolated name can never break the reply into sections.
    const reply = buildGreetingReply("Hi", "Evil\n## Inject");
    expect(reply).not.toContain("\n");
    expect(reply).toContain("Evil ## Inject");
  });
});
