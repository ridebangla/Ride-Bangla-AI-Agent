/**
 * order-ratings.test.ts — LEG I (staged-only).
 * REPO PATH when applied: tests/unit/order-ratings.test.ts
 *
 * Covers ONLY the pure module src/lib/order-ratings.ts (zero runtime
 * imports, so this file needs no Firestore, no prisma mock, and no
 * network). The queue / capture / scan guards over injected stores are
 * exercised by the standalone harness (harness/run-harness.mjs) and
 * remain LIVE-UNVERIFIED until a real-repo test run.
 *
 * Invariants asserted throughout:
 * - A rating is recognised ONLY from the listed deterministic forms;
 *   out-of-range numbers are never clamped, ambiguous numbers are
 *   never guessed, and praise without stars is never a rating.
 * - A rating request fires ONLY on a real move TO confirmed, ONLY for
 *   a chat-linked order, at most once per order.
 * - A review request fires ONLY when the tenant switched it on, ONLY
 *   with a valid tenant-configured http(s) link, ONLY for a confirmed
 *   chat-linked order whose courier phase is exactly "delivered".
 * - No message built here carries a total, a price, a fare figure, or
 *   a currency symbol; no review text is ever collected or displayed.
 */

import { describe, it, expect } from "vitest";
import {
  ORDER_REVIEW_DELAY_MS,
  buildRatingConfirmationMessage,
  buildRatingRequestMessage,
  buildReviewRequestMessage,
  decideRatingRequest,
  decideReviewRequest,
  orderRef,
  parseRatingReply,
  validReviewUrl,
} from "@/lib/order-ratings";

describe("parseRatingReply — the ONLY way a rating is recognised", () => {
  it.each([
    ["5", 5],
    ["1", 1],
    ["৫", 5],
    ["১", 1],
    ["★★★★★", 5],
    ["★★★☆☆", 3],
    ["⭐⭐⭐⭐", 4],
    ["5 stars", 5],
    ["5 star", 5],
    ["I give it 5 stars", 5],
    ["৫ তারা", 5],
    ["five stars", 5],
  ])("%p -> %p", (text, stars) => {
    expect(parseRatingReply(text)).toBe(stars);
  });

  it.each([
    ["6 stars", "never clamped up"],
    ["0 stars", "never clamped down"],
    ["6", "out of range digit"],
    ["0", "out of range digit"],
    ["55", "two digits, no star word"],
    ["Room 5, 5 stars", "ambiguous: two numbers"],
    ["5/5", "not a listed form"],
    ["excellent, 5", "praise plus a stray number"],
    ["great service", "praise without stars"],
    ["", "empty"],
    ["☆☆☆☆☆", "no filled star"],
    ["★★★★★★", "six glyphs"],
    ["cancel my order", "handoff words, not a rating"],
  ])("%p -> null (%s)", (text) => {
    expect(parseRatingReply(text)).toBeNull();
  });
});

describe("decideRatingRequest — confirm-time queue", () => {
  const base = {
    status: "confirmed",
    previousStatus: "pending",
    conversationId: "conv_1",
    alreadyRequested: false,
  };
  it("real pending -> confirmed transition requests", () => {
    expect(decideRatingRequest(base)).toEqual({ request: true });
  });
  it("same-status re-save is silent", () => {
    expect(
      decideRatingRequest({ ...base, previousStatus: "confirmed" })
    ).toEqual({ request: false, reason: "no_transition" });
  });
  it("non-confirmed target is silent", () => {
    expect(decideRatingRequest({ ...base, status: "cancelled" })).toEqual({
      request: false,
      reason: "not_confirmed",
    });
  });
  it("hand-entered order (no linked chat) never gets a request", () => {
    expect(decideRatingRequest({ ...base, conversationId: null })).toEqual({
      request: false,
      reason: "no_conversation",
    });
  });
  it("second request for the same order is refused", () => {
    expect(decideRatingRequest({ ...base, alreadyRequested: true })).toEqual({
      request: false,
      reason: "already_requested",
    });
  });
});

describe("decideReviewRequest — delivered scan", () => {
  const base = {
    status: "confirmed",
    conversationId: "conv_1",
    courierPhase: "delivered",
    enabled: true,
    reviewUrl: "https://g.page/review-example",
    alreadyRequested: false,
  };
  it("all gates hold -> request with the tenant link", () => {
    expect(decideReviewRequest(base)).toEqual({
      request: true,
      link: "https://g.page/review-example",
    });
  });
  it("switch off -> no request, even when delivered", () => {
    expect(decideReviewRequest({ ...base, enabled: false })).toEqual({
      request: false,
      reason: "disabled",
    });
  });
  it("no tenant link -> no request (no website fallback)", () => {
    expect(decideReviewRequest({ ...base, reviewUrl: "" })).toEqual({
      request: false,
      reason: "no_link",
    });
  });
  it("non-URL link -> no request", () => {
    expect(decideReviewRequest({ ...base, reviewUrl: "not a link" })).toEqual({
      request: false,
      reason: "no_link",
    });
  });
  it("own-delivery / unknown phase -> no request", () => {
    expect(decideReviewRequest({ ...base, courierPhase: "unknown" })).toEqual({
      request: false,
      reason: "not_delivered",
    });
    expect(decideReviewRequest({ ...base, courierPhase: null })).toEqual({
      request: false,
      reason: "not_delivered",
    });
  });
  it("hand-entered order (no linked chat) never gets a review request", () => {
    expect(decideReviewRequest({ ...base, conversationId: null })).toEqual({
      request: false,
      reason: "no_conversation",
    });
  });
  it("already requested -> no duplicate", () => {
    expect(decideReviewRequest({ ...base, alreadyRequested: true })).toEqual({
      request: false,
      reason: "already_requested",
    });
  });
});

describe("message builders — proposal text, no money, no review capture", () => {
  const link = "https://g.page/review-example";
  it("rating request names the order ref and the star forms", () => {
    const msg = buildRatingRequestMessage("en", "Test Bakery", "abcd1234");
    expect(msg).toContain("abcd1234");
    expect(msg).toContain("★★★★★");
    expect(msg).not.toMatch(/[৳$£€]/);
  });
  it("review request carries the tenant link and nothing else external", () => {
    const msg = buildReviewRequestMessage("en", "Test Bakery", "abcd1234", link);
    expect(msg).toContain(link);
    expect(msg).toContain("abcd1234");
    expect(msg).not.toMatch(/[৳$£€]/);
  });
  it("confirmation echoes the stars only", () => {
    expect(buildRatingConfirmationMessage("en", 4)).toContain("4 out of 5");
    expect(buildRatingConfirmationMessage("bn", 5)).toContain("5/5");
  });
  it("review delay is exactly one day", () => {
    expect(ORDER_REVIEW_DELAY_MS).toBe(24 * 60 * 60 * 1000);
  });
  it("orderRef is the 8-char prefix convention", () => {
    expect(orderRef("abcdefghijklmnop")).toBe("abcdefgh");
  });
  it("validReviewUrl accepts http(s) only", () => {
    expect(validReviewUrl("https://example.com/r")).toBe(true);
    expect(validReviewUrl("http://example.com/r")).toBe(true);
    expect(validReviewUrl("")).toBe(false);
    expect(validReviewUrl("javascript:alert(1)")).toBe(false);
    expect(validReviewUrl("/reviews")).toBe(false);
  });
});
