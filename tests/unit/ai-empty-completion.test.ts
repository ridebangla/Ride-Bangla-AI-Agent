import { describe, it, expect } from "vitest";
import { emptyCompletionFallbackText } from "@/lib/ai/engine";
import type { AIMessage } from "@/lib/ai/types";

/**
 * CF-4 (check #2, 2026-10-22): the engine's empty-completion fallback
 * was the English-only string "I apologize, I could not generate a
 * response." — a Bengali conversation hitting a tokenless completion
 * received an English apology. The fallback must now be selected with
 * the engine's existing language handling (resolveBehaviourLang: a
 * forced settings language wins; otherwise the customer's latest
 * message decides). The English variant must stay byte-identical to
 * the legacy string.
 */
const EN = "I apologize, I could not generate a response.";
const BN =
  "দুঃখিত, এই মুহূর্তে উত্তরটি তৈরি করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।";

const user = (content: string): AIMessage => ({ role: "user", content });
const system = (content: string): AIMessage => ({ role: "system", content });
const assistant = (content: string): AIMessage => ({
  role: "assistant",
  content,
});
const tool = (content: string): AIMessage => ({ role: "tool", content });

describe("emptyCompletionFallbackText (CF-4)", () => {
  it("auto + Bengali customer message → Bengali fallback", () => {
    expect(
      emptyCompletionFallbackText("auto", [user("আমার অর্ডারটা কোথায়?")])
    ).toBe(BN);
  });

  it("auto + English customer message → English fallback", () => {
    expect(emptyCompletionFallbackText("auto", [user("Where is my order?")])).toBe(
      EN
    );
  });

  it("forced settings language 'bn' wins over an English message", () => {
    expect(emptyCompletionFallbackText("bn", [user("Where is my order?")])).toBe(
      BN
    );
  });

  it("forced settings language 'en' wins over a Bengali message", () => {
    expect(
      emptyCompletionFallbackText("en", [user("আমার অর্ডারটা কোথায়?")])
    ).toBe(EN);
  });

  it("undefined settings language falls back to message detection", () => {
    expect(
      emptyCompletionFallbackText(undefined, [user("ধন্যবাদ, সাহায্য করুন")])
    ).toBe(BN);
    expect(emptyCompletionFallbackText(undefined, [user("Thanks, help me")])).toBe(
      EN
    );
  });

  it("no customer message at all → English default", () => {
    expect(emptyCompletionFallbackText("auto", [])).toBe(EN);
    expect(emptyCompletionFallbackText("auto", [system("You are…")])).toBe(EN);
  });

  it("the LATEST user message decides after tool rounds", () => {
    const messages: AIMessage[] = [
      system("You are…"),
      user("আমার অর্ডারটা কোথায়?"),
      assistant("Checking…"),
      tool("{\"status\":\"shipped\"}"),
      user("And when will it arrive?"),
    ];
    expect(emptyCompletionFallbackText("auto", messages)).toBe(EN);
  });

  it("trailing assistant/tool messages do not mask the customer's language", () => {
    const messages: AIMessage[] = [
      user("আমার অর্ডারটা কোথায়?"),
      assistant("Checking…"),
      tool("{\"status\":\"shipped\"}"),
    ];
    expect(emptyCompletionFallbackText("auto", messages)).toBe(BN);
  });

  it("English variant is byte-identical to the legacy fallback", () => {
    expect(emptyCompletionFallbackText("en", [user("hi")])).toBe(
      "I apologize, I could not generate a response."
    );
  });
});
