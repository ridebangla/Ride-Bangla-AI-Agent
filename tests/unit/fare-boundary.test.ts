import { describe, it, expect } from "vitest";
import {
  containsFareFigure,
  suppressFareFigures,
} from "@/lib/ai/guardrails";
import {
  composePriceAnswer,
  renderComposedPriceAnswer,
} from "@/lib/business-rules";

/**
 * TEAM FARE-BOUNDARY (2026-11-03) — head call, decision A4.
 *
 * Boundary: the agent NEVER states fare-table figures; a tenant's OWN
 * saved delivery charge, presented via composePriceAnswer (price +
 * delivery charge + total together, only when both figures are known
 * and currencies match), is a business-configured figure, NOT a
 * fare-table quote, and is ALLOWED. The filter exemption is a machine
 * marker plus structural validation — never a whitelist of arbitrary
 * "delivery charge" sentences.
 *
 * Figures below are neutral test fixtures (450/80/530), deliberately
 * distinct from any fare-table figures. No engine, widget, auth, or
 * dashboard behaviour is asserted here; the engine's all-fare silent
 * handling is verified by code read of the main path (empty filtered
 * reply => silent:true, no invented copy), not by this unit file.
 */

const START = "\u0001COMPOSED-PRICE-START\u0001";
const END = "\u0001COMPOSED-PRICE-END\u0001";

function composedBlock(): string {
  const answer = composePriceAnswer({
    price: 450,
    priceCurrency: "BDT",
    deliveryCharge: { amount: 80, currency: "BDT" },
  });
  expect(answer).toEqual({
    ok: true,
    price: 450,
    deliveryCharge: 80,
    total: 530,
    currency: "BDT",
  });
  const rendered = renderComposedPriceAnswer(answer);
  expect(rendered).not.toBeNull();
  return rendered as string;
}

describe("fare-boundary — fare-table sentences are stripped", () => {
  it("(a) a fare-table sentence with a figure is stripped, neighbours kept", () => {
    const reply =
      "We deliver across the city. Delivery charge is 50 BDT within the city. Delivery charge is 70 BDT outside. Let us know if you need anything else.";
    const out = suppressFareFigures(reply);
    expect(out).not.toContain("50");
    expect(out).not.toContain("70");
    expect(out).toContain("We deliver across the city.");
    expect(out).toContain("Let us know if you need anything else.");
    expect(containsFareFigure(reply)).toBe(true);
    expect(containsFareFigure(out)).toBe(false);
  });

  it("an unmarked delivery-charge sentence is stripped — no whitelist", () => {
    const reply = "Here is the breakdown. Delivery charge: 80 BDT. Thanks!";
    const out = suppressFareFigures(reply);
    expect(out).not.toContain("80");
    expect(out).toContain("Here is the breakdown.");
    expect(out).toContain("Thanks!");
  });

  it("a whole reply of fare figures goes silent at the filter level", () => {
    expect(
      suppressFareFigures("Delivery charge is 50 BDT. Fare 70 BDT per trip.")
    ).toBe("");
  });
});

describe("fare-boundary — composed tenant price answer survives the filter", () => {
  it("(b) compose -> render -> filter end-to-end: delivery line survives, markers never leak, fare sentence still stripped", () => {
    const reply =
      `Here is your order summary.\n${composedBlock()}\nDelivery charge is 50 BDT within the city.`;
    const out = suppressFareFigures(reply);
    expect(out).toContain("Price: 450 BDT");
    expect(out).toContain("Delivery charge: 80 BDT");
    expect(out).toContain("Total: 530 BDT");
    expect(out).toContain("Here is your order summary.");
    expect(out).not.toContain("COMPOSED-PRICE");
    expect(out).not.toContain("\u0001");
    expect(out).not.toContain("within the city");
    // The exemption is input-side and single-pass by design: the
    // marked block itself carries no fare figure to a checker, but
    // the delivered plain text would be flagged if re-filtered —
    // so a composed block must pass through the filter exactly once
    // (or be appended after filtering), never twice.
    expect(containsFareFigure(composedBlock())).toBe(false);
  });

  it("double-filtering is fail-closed: a second pass strips the delivered delivery line", () => {
    const once = suppressFareFigures(`Summary:\n${composedBlock()}`);
    expect(once).toContain("Delivery charge: 80 BDT");
    const twice = suppressFareFigures(once);
    expect(twice).not.toContain("Delivery charge: 80 BDT");
    expect(twice).toContain("Summary:");
  });

  it("free delivery (0) is a real figure and survives as a composed block", () => {
    const answer = composePriceAnswer({
      price: 450,
      deliveryCharge: { amount: 0, currency: "BDT" },
    });
    expect(answer).toEqual({
      ok: true,
      price: 450,
      deliveryCharge: 0,
      total: 450,
      currency: "BDT",
    });
    const out = suppressFareFigures(
      `Summary:\n${renderComposedPriceAnswer(answer) as string}`
    );
    expect(out).toContain("Delivery charge: 0 BDT");
    expect(out).toContain("Total: 450 BDT");
    expect(out).not.toContain("COMPOSED-PRICE");
  });

  it("a forged marked block with wrong arithmetic is dropped whole, markers included", () => {
    const forged =
      `${START}\nPrice: 450 BDT\nDelivery charge: 80 BDT\nTotal: 999 BDT\n${END}`;
    const out = suppressFareFigures(`Summary:\n${forged}\nThanks!`);
    expect(out).not.toContain("450");
    expect(out).not.toContain("999");
    expect(out).not.toContain("COMPOSED-PRICE");
    expect(out).not.toContain("\u0001");
    expect(out).toContain("Summary:");
    expect(out).toContain("Thanks!");
  });

  it("a forged marked block with mismatched currencies is dropped whole", () => {
    const forged =
      `${START}\nPrice: 450 BDT\nDelivery charge: 80 USD\nTotal: 530 BDT\n${END}`;
    const out = suppressFareFigures(`Summary:\n${forged}`);
    expect(out).not.toContain("450");
    expect(out).not.toContain("COMPOSED-PRICE");
    expect(out).toContain("Summary:");
  });
});

describe("fare-boundary — legitimate non-fare content survives", () => {
  it("(c) product price, figure-free sentence, and trailing ellipsis survive", () => {
    const reply =
      "Price ৳500. Delivery is free. Let me check that for you...";
    const out = suppressFareFigures(reply);
    expect(out).toContain("Price ৳500");
    expect(out).toContain("Delivery is free");
    expect(out).toContain("Let me check that for you...");
    expect(containsFareFigure(reply)).toBe(false);
  });
});

describe("fare-boundary — composer blocks, never guesses", () => {
  it("(d) missing delivery charge blocks the total and renders nothing", () => {
    const answer = composePriceAnswer({ price: 450, deliveryCharge: null });
    expect(answer).toEqual({
      ok: false,
      reason: "missing_delivery_charge",
    });
    expect(renderComposedPriceAnswer(answer)).toBeNull();
  });

  it("(d) missing price blocks and renders nothing", () => {
    const answer = composePriceAnswer({
      price: null,
      deliveryCharge: { amount: 80, currency: "BDT" },
    });
    expect(answer).toEqual({ ok: false, reason: "missing_price" });
    expect(renderComposedPriceAnswer(answer)).toBeNull();
  });

  it("(e) currency mismatch blocks and renders nothing", () => {
    const answer = composePriceAnswer({
      price: 450,
      priceCurrency: "BDT",
      deliveryCharge: { amount: 80, currency: "USD" },
    });
    expect(answer).toEqual({ ok: false, reason: "currency_mismatch" });
    expect(renderComposedPriceAnswer(answer)).toBeNull();
  });
});
