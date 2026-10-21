/**
 * plan-catalog.test.ts — pure helpers of the panel-driven plan catalog
 * (owner directive 2026-10-21). No DB: merge/parse/window/price logic.
 */

import { describe, it, expect } from "vitest";
import { PLAN_META } from "@/lib/plans";
import {
  codeCatalog,
  mergePlanDoc,
  parseOfferDoc,
  isOfferLive,
  offerEffectivePrice,
  bestOfferHit,
  type EffectivePlan,
  type ParsedOffer,
} from "@/lib/plan-catalog";

const starter: EffectivePlan = {
  id: "starter",
  name: "Starter",
  priceUsd: 19,
  yearlyPriceUsd: 190,
  tagline: PLAN_META.starter.tagline,
  messagesPerMonth: 1000,
  active: true,
  stripePriceId: null,
  stripeYearlyPriceId: null,
  source: "code",
};

function makeOffer(partial: Partial<ParsedOffer>): ParsedOffer {
  return {
    id: "offer-1",
    name: "Offer",
    planId: "starter",
    percentOff: null,
    offerPriceMonthlyUsd: null,
    offerPriceYearlyUsd: null,
    startsAt: new Date("2026-01-01T00:00:00Z"),
    endsAt: new Date("2026-12-31T00:00:00Z"),
    active: true,
    ...partial,
  };
}

describe("codeCatalog", () => {
  it("mirrors PLAN_META exactly, all active, code order", () => {
    const cat = codeCatalog();
    expect(cat.map((p) => p.id)).toEqual(["starter", "growth", "pro"]);
    for (const p of cat) {
      const meta = PLAN_META[p.id as keyof typeof PLAN_META];
      expect(p.name).toBe(meta.name);
      expect(p.priceUsd).toBe(meta.priceUsd);
      expect(p.yearlyPriceUsd).toBe(meta.yearlyPriceUsd);
      expect(p.messagesPerMonth).toBe(meta.messagesPerMonth);
      expect(p.active).toBe(true);
      expect(p.source).toBe("code");
    }
  });
});

describe("mergePlanDoc — code plans (tolerant per-field merge)", () => {
  it("applies good fields and ignores bad ones individually", () => {
    const merged = mergePlanDoc("starter", {
      name: "  ", // invalid → code name stands
      priceUsd: "nineteen", // invalid → code price stands
      yearlyPriceUsd: 150, // valid → applied
      messagesPerMonth: 2500, // valid → applied
      tagline: "New tagline", // valid → applied
    });
    expect(merged).not.toBeNull();
    expect(merged!.name).toBe("Starter");
    expect(merged!.priceUsd).toBe(19);
    expect(merged!.yearlyPriceUsd).toBe(150);
    expect(merged!.messagesPerMonth).toBe(2500);
    expect(merged!.tagline).toBe("New tagline");
    expect(merged!.source).toBe("config");
  });

  it("rejects a non-positive price and a fractional message count", () => {
    const merged = mergePlanDoc("growth", {
      priceUsd: -1,
      messagesPerMonth: 12.5,
    });
    expect(merged!.priceUsd).toBe(49);
    expect(merged!.messagesPerMonth).toBe(5000);
  });

  it("garbage doc data still yields the code plan", () => {
    expect(mergePlanDoc("pro", null)?.priceUsd).toBe(99);
    expect(mergePlanDoc("pro", "junk")?.messagesPerMonth).toBe(15000);
  });

  it("active: absent = true, only an explicit false deactivates", () => {
    expect(mergePlanDoc("starter", {})!.active).toBe(true);
    expect(mergePlanDoc("starter", { active: true })!.active).toBe(true);
    expect(mergePlanDoc("starter", { active: false })!.active).toBe(false);
    expect(mergePlanDoc("starter", { enabled: false })!.active).toBe(false);
    expect(mergePlanDoc("starter", { isActive: false })!.active).toBe(false);
  });

  it("carries configured Stripe price ids", () => {
    const merged = mergePlanDoc("starter", {
      stripePriceId: "price_123",
      stripeYearlyPriceId: "price_456",
    });
    expect(merged!.stripePriceId).toBe("price_123");
    expect(merged!.stripeYearlyPriceId).toBe("price_456");
  });
});

describe("mergePlanDoc — new panel-created plans (full field set required)", () => {
  const full = {
    name: "Team",
    priceUsd: 29,
    yearlyPriceUsd: 290,
    messagesPerMonth: 2000,
    tagline: "For teams",
  };

  it("accepts a complete doc", () => {
    const plan = mergePlanDoc("team", full);
    expect(plan).not.toBeNull();
    expect(plan!.id).toBe("team");
    expect(plan!.name).toBe("Team");
    expect(plan!.priceUsd).toBe(29);
    expect(plan!.yearlyPriceUsd).toBe(290);
    expect(plan!.messagesPerMonth).toBe(2000);
    expect(plan!.source).toBe("config");
    expect(plan!.active).toBe(true);
  });

  it("allows a zero yearly price (>= 0)", () => {
    expect(mergePlanDoc("team", { ...full, yearlyPriceUsd: 0 })).not.toBeNull();
  });

  it("returns null for each incomplete variant", () => {
    expect(mergePlanDoc("team", { ...full, name: "" })).toBeNull();
    expect(mergePlanDoc("team", { ...full, name: undefined })).toBeNull();
    expect(mergePlanDoc("team", { ...full, priceUsd: 0 })).toBeNull();
    expect(mergePlanDoc("team", { ...full, priceUsd: -5 })).toBeNull();
    expect(mergePlanDoc("team", { ...full, yearlyPriceUsd: -1 })).toBeNull();
    expect(mergePlanDoc("team", { ...full, yearlyPriceUsd: undefined })).toBeNull();
    expect(mergePlanDoc("team", { ...full, messagesPerMonth: 0 })).toBeNull();
    expect(mergePlanDoc("team", { ...full, messagesPerMonth: 1.5 })).toBeNull();
    expect(mergePlanDoc("team", {})).toBeNull();
    expect(mergePlanDoc("team", null)).toBeNull();
  });
});

describe("parseOfferDoc", () => {
  const base = {
    name: "Launch",
    planId: "starter",
    percentOff: 20,
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-02-01T00:00:00.000Z",
  };

  it("normalizes a valid percent offer", () => {
    const o = parseOfferDoc("o1", base);
    expect(o).not.toBeNull();
    expect(o!.percentOff).toBe(20);
    expect(o!.startsAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(o!.endsAt.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(o!.active).toBe(true);
  });

  it("requires a parseable endsAt and a planId", () => {
    expect(parseOfferDoc("o1", { ...base, endsAt: undefined })).toBeNull();
    expect(parseOfferDoc("o1", { ...base, endsAt: "not-a-date" })).toBeNull();
    expect(parseOfferDoc("o1", { ...base, planId: "" })).toBeNull();
    expect(parseOfferDoc("o1", null)).toBeNull();
  });

  it("a present-but-unparseable startsAt invalidates the doc", () => {
    expect(parseOfferDoc("o1", { ...base, startsAt: "junk" })).toBeNull();
  });

  it("an out-of-range percentOff is ignored per-field, fixed prices kept", () => {
    const o = parseOfferDoc("o1", {
      ...base,
      percentOff: 150,
      offerPriceMonthlyUsd: 12,
    });
    expect(o).not.toBeNull();
    expect(o!.percentOff).toBeNull();
    expect(o!.offerPriceMonthlyUsd).toBe(12);
  });

  it("percentOff bounds: 1 and 90 valid, 0 and 91 ignored", () => {
    expect(parseOfferDoc("o1", { ...base, percentOff: 1 })!.percentOff).toBe(1);
    expect(parseOfferDoc("o1", { ...base, percentOff: 90 })!.percentOff).toBe(90);
    expect(parseOfferDoc("o1", { ...base, percentOff: 0 })!.percentOff).toBeNull();
    expect(parseOfferDoc("o1", { ...base, percentOff: 91 })!.percentOff).toBeNull();
  });

  it("active: explicit false deactivates", () => {
    expect(parseOfferDoc("o1", { ...base, active: false })!.active).toBe(false);
    expect(parseOfferDoc("o1", base)!.active).toBe(true);
  });
});

describe("isOfferLive — window edges", () => {
  const offer = makeOffer({});
  it("live inside the window, including exactly at startsAt", () => {
    expect(isOfferLive(offer, new Date("2026-06-01T00:00:00Z"))).toBe(true);
    expect(isOfferLive(offer, new Date("2026-01-01T00:00:00Z"))).toBe(true);
  });
  it("not live before the start", () => {
    expect(isOfferLive(offer, new Date("2025-12-31T23:59:59Z"))).toBe(false);
  });
  it("not live exactly at endsAt (end is exclusive)", () => {
    expect(isOfferLive(offer, new Date("2026-12-31T00:00:00Z"))).toBe(false);
    expect(isOfferLive(offer, new Date("2027-01-01T00:00:00Z"))).toBe(false);
  });
  it("inactive offers are never live", () => {
    expect(
      isOfferLive(makeOffer({ active: false }), new Date("2026-06-01T00:00:00Z"))
    ).toBe(false);
  });
});

describe("offerEffectivePrice", () => {
  it("applies a percent discount, rounded to cents", () => {
    expect(
      offerEffectivePrice(starter, makeOffer({ percentOff: 15 }), "monthly")
    ).toBe(16.15);
    const growth: EffectivePlan = { ...starter, id: "growth", priceUsd: 49, yearlyPriceUsd: 490 };
    expect(
      offerEffectivePrice(growth, makeOffer({ percentOff: 33 }), "monthly")
    ).toBe(32.83);
  });

  it("uses the fixed price for the interval when set", () => {
    const offer = makeOffer({
      percentOff: 50,
      offerPriceMonthlyUsd: 9,
      offerPriceYearlyUsd: null,
    });
    // Monthly: fixed 9 wins over the 50% figure (9.50).
    expect(offerEffectivePrice(starter, offer, "monthly")).toBe(9);
    // Yearly: no fixed yearly price → percent applies to 190.
    expect(offerEffectivePrice(starter, offer, "yearly")).toBe(95);
  });

  it("ignores an offer that is not cheaper than the regular price", () => {
    expect(
      offerEffectivePrice(starter, makeOffer({ offerPriceMonthlyUsd: 19 }), "monthly")
    ).toBeNull();
    expect(
      offerEffectivePrice(starter, makeOffer({ offerPriceMonthlyUsd: 25 }), "monthly")
    ).toBeNull();
    expect(
      offerEffectivePrice(starter, makeOffer({}), "monthly")
    ).toBeNull();
  });
});

describe("bestOfferHit — lowest of multiple live offers wins", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("picks the cheapest live offer and reports regular + effective", () => {
    const offers = [
      makeOffer({ id: "a", percentOff: 10 }), // 17.10
      makeOffer({ id: "b", percentOff: 25 }), // 14.25
      makeOffer({ id: "c", offerPriceMonthlyUsd: 15 }), // 15
    ];
    const hit = bestOfferHit(starter, offers, "monthly", now);
    expect(hit).not.toBeNull();
    expect(hit!.offerId).toBe("b");
    expect(hit!.effectivePriceUsd).toBe(14.25);
    expect(hit!.regularPriceUsd).toBe(19);
  });

  it("skips expired, not-yet-started, inactive and other-plan offers", () => {
    const offers = [
      makeOffer({ id: "expired", percentOff: 50, endsAt: new Date("2026-05-01T00:00:00Z") }),
      makeOffer({ id: "future", percentOff: 50, startsAt: new Date("2026-07-01T00:00:00Z") }),
      makeOffer({ id: "off", percentOff: 50, active: false }),
      makeOffer({ id: "other", percentOff: 50, planId: "growth" }),
      makeOffer({ id: "live", percentOff: 10 }),
    ];
    const hit = bestOfferHit(starter, offers, "monthly", now);
    expect(hit!.offerId).toBe("live");
    expect(hit!.effectivePriceUsd).toBe(17.1);
  });

  it("returns null when nothing live is cheaper", () => {
    expect(bestOfferHit(starter, [], "monthly", now)).toBeNull();
    expect(
      bestOfferHit(starter, [makeOffer({ offerPriceMonthlyUsd: 19 })], "monthly", now)
    ).toBeNull();
  });
});
