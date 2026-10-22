import { describe, it, expect } from "vitest";
import { depthGuardFallbackText } from "@/lib/ai/engine";
import type { AIMessage } from "@/lib/ai/types";

/**
 * CF-4 sibling (check #2 follow-up, 2026-10-22): the engine's depth>5
 * recursion-guard fallback was the English-only string "I apologize,
 * but I'm having trouble processing your request. Let me connect you
 * with a team member." — a Bengali conversation that exhausted the
 * tool-recursion depth received an English handoff line. The fallback
 * must now be selected with the engine's existing language handling
 * (resolveBehaviourLang: a forced settings language wins; otherwise
 * the customer's latest message decides), exactly like the CF-4
 * empty-completion fallback. The English variant must stay
 * byte-identical to the legacy string.
 */
const EN =
  "I apologize, but I'm having trouble processing your request. Let me connect you with a team member.";
const BN =
  "দুঃখিত, আপনার অনুরোধটি প্রক্রিয়া করতে সমস্যা হচ্ছে। আমি আপনাকে টিমের একজন সদস্যের সঙ্গে যুক্ত করে দিচ্ছি।";

const user = (content: string): AIMessage => ({ role: "user", content });
const system = (content: string): AIMessage => ({ role: "system", content });
const assistant = (content: string): AIMessage => ({
  role: "assistant",
  content,
});
const tool = (content: string): AIMessage => ({ role: "tool", content });

describe("depthGuardFallbackText (CF-4 sibling)", () => {
  it("auto + Bengali customer message → Bengali fallback", () => {
    expect(
      depthGuardFallbackText("auto", [user("আমার অর্ডারটা কোথায়?")])
    ).toBe(BN);
  });

  it("auto + English customer message → English fallback", () => {
    expect(depthGuardFallbackText("auto", [user("Where is my order?")])).toBe(
      EN
    );
  });

  it("forced settings language 'bn' wins over an English message", () => {
    expect(depthGuardFallbackText("bn", [user("Where is my order?")])).toBe(
      BN
    );
  });

  it("forced settings language 'en' wins over a Bengali message", () => {
    expect(
      depthGuardFallbackText("en", [user("আমার অর্ডারটা কোথায়?")])
    ).toBe(EN);
  });

  it("undefined settings language falls back to message detection", () => {
    expect(
      depthGuardFallbackText(undefined, [user("ধন্যবাদ, সাহায্য করুন")])
    ).toBe(BN);
    expect(depthGuardFallbackText(undefined, [user("Thanks, help me")])).toBe(
      EN
    );
  });

  it("no customer message at all → English default", () => {
    expect(depthGuardFallbackText("auto", [])).toBe(EN);
    expect(depthGuardFallbackText("auto", [system("You are…")])).toBe(EN);
  });

  it("the LATEST user message decides after tool rounds", () => {
    const messages: AIMessage[] = [
      system("You are…"),
      user("আমার অর্ডারটা কোথায়?"),
      assistant("Checking…"),
      tool("{\"status\":\"shipped\"}"),
      user("And when will it arrive?"),
    ];
    expect(depthGuardFallbackText("auto", messages)).toBe(EN);
  });

  it("trailing assistant/tool messages do not mask the customer's language", () => {
    const messages: AIMessage[] = [
      user("আমার অর্ডারটা কোথায়?"),
      assistant("Checking…"),
      tool("{\"status\":\"shipped\"}"),
    ];
    expect(depthGuardFallbackText("auto", messages)).toBe(BN);
  });

  it("English variant is byte-identical to the legacy guard string", () => {
    expect(depthGuardFallbackText("en", [user("hi")])).toBe(
      "I apologize, but I'm having trouble processing your request. Let me connect you with a team member."
    );
  });
});
