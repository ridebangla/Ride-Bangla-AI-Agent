import { describe, it, expect } from "vitest";
import { isIdentityQuestion } from "@/lib/ai/engine";

/**
 * Identity fast-path detector (owner acceptance case, re-audit #2,
 * 2026-10-22). "তুমি কে" must ride the fast path to a short
 * professional self-introduction — but ONLY when the message is
 * purely the identity question. Anything more belongs to the full
 * pipeline, so the negative cases matter most.
 */
describe("isIdentityQuestion", () => {
  const identity = [
    "তুমি কে",
    "তুমি কে?",
    "তুমি কে।",
    "কে তুমি",
    "আপনি কে",
    "আপনি কে?",
    "তোমার নাম কি",
    "তোমার নাম কী?",
    "আপনার নাম কি",
    "তুমি কি রোবট",
    "তুমি কি মানুষ?",
    "Who are you",
    "who are you?",
    "What are you",
    "What is your name",
    "what's your name?",
    "Your name",
    "Are you a robot",
    "are you an AI?",
    "Are you human",
  ];
  for (const q of identity) {
    it(`treats ${JSON.stringify(q)} as a pure identity question`, () => {
      expect(isIdentityQuestion(q)).toBe(true);
    });
  }

  const notIdentity = [
    "তুমি কে, তোমাদের প্ল্যানগুলো বলো",
    "তুমি কে জানতে চাই এবং দাম কত",
    "Who are you and what are your prices?",
    "who are you to charge me this much, explain the bill please",
    "আপনি কে হে? আমার অর্ডার কোথায়",
    "What are your delivery hours",
    "What are you doing about my order",
    "তুমি কি ডেলিভারি দাও",
    "তুমি কি ফরিদপুরে ডেলিভারি দাও?",
    "hello",
    "Hi, who are you",
    "",
    "   ",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ];
  for (const q of notIdentity) {
    it(`does NOT treat ${JSON.stringify(q)} as a pure identity question`, () => {
      expect(isIdentityQuestion(q)).toBe(false);
    });
  }
});
