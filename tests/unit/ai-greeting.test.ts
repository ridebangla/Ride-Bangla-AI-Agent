import { describe, it, expect } from "vitest";
import { isPureGreeting } from "@/lib/ai/engine";

/**
 * F7 greeting fast-path detector (re-audit #2, 2026-10-22).
 * The detector must be conservative: it may only claim messages
 * that are ONLY a greeting — anything more belongs to the full
 * pipeline. A false negative costs speed; a false positive would
 * cost a real answer, so the negative cases matter most.
 */
describe("isPureGreeting", () => {
  const greetings = [
    "Hi",
    "hello",
    "Hello!",
    "hey",
    "salam",
    "Assalamu Alaikum",
    "assalamualaikum",
    "Good morning",
    "good evening",
    "আসসালামু আলাইকুম",
    "হাই",
    "হ্যালো",
    "শুভ সকাল",
    "শুভ বিকেল",
    "নমস্কার",
    "আদাব",
    // Emoji tolerance (voice/video round 2026-10-22): an emoji
    // riding on a bare greeting does not make it substantive.
    "Hello 👋",
    "হাই 😊",
    "good morning ☀️",
    "আসসালামু আলাইকুম 🤲",
  ];
  for (const g of greetings) {
    it(`treats ${JSON.stringify(g)} as a pure greeting`, () => {
      expect(isPureGreeting(g)).toBe(true);
    });
  }

  const notGreetings = [
    "Hello, what services do you offer?",
    "Hi, I need help",
    "hello?",
    "Hi, do you deliver to Faridpur?",
    "আসসালামু আলাইকুম, আপনাদের সার্ভিস সম্পর্কে জানতে চাই",
    "শুভ সকাল, আজ ডেলিভারি হবে?",
    "good morning, please send me the price list",
    "I need a delivery",
    "Tell me about your services",
    "",
    "   ",
    "hi there, I want to place an order",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    // Emoji do NOT rescue a substantive message (hard negatives).
    "Hello 👋, what services do you offer?",
    "হাই 😊, দাম কত?",
    "👋",
  ];
  for (const g of notGreetings) {
    it(`does NOT treat ${JSON.stringify(g)} as a pure greeting`, () => {
      expect(isPureGreeting(g)).toBe(false);
    });
  }
});
