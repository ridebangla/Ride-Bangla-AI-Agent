/**
 * COURIER SUGGESTION — Team J (2026-11-03). Pure decision table.
 *
 * Customer-facing courier routing for the agent's answer path, built
 * on the EXISTING served-district gate (src/lib/courier-bridge.ts:
 * SERVED_COURIER_DISTRICTS = ["faridpur"] today, growing district by
 * district). This module decides; it never books, never dispatches,
 * and never confirms anything — booking stays team-confirmed only
 * (handleOrderConfirmed) and the agent never confirms an order.
 *
 * DECISION TABLE (owner rules):
 *   served area  -> suggest the own (Ride Bangla) courier FIRST and
 *                   highlighted; the customer may still choose
 *                   otherwise — never forced.
 *   unserved area -> highlighted "Coming Soon" for the own courier,
 *                   AND partner-courier ordering stays allowed.
 *   no district determinable -> the order stays pending for the shop
 *                   to arrange (needsDistrict flag; the agent must
 *                   ask, not guess, a district).
 *   in every case -> the agent NEVER books a third-party courier
 *                   outside the Coming Soon allowance, and never books
 *                   anything before team confirmation: booksThirdParty
 *                   is false on every outcome by construction.
 *
 * CUSTOMER-FACING TEXT: this module emits machine codes only, plus
 * the owner's own given words "Coming Soon" as the display marker on
 * the unserved outcome. Every other customer wording (how the own
 * courier is highlighted, how partner ordering is offered, how the
 * pending-for-shop state is explained) is a PROPOSAL in the Team J
 * report for owner approval — it is NOT shipped here, and no other
 * wording is invented in this module.
 *
 * The consumer that turns these codes into an answer lives in
 * forbidden files for this team (src/lib/ai/tools.ts take_order
 * handler, src/lib/ai/engine.ts prompt); the exact patch for that
 * wiring is in the Team J report §c. The order-record helper below
 * (courierSuggestionForOrder) reuses the bridge's own district
 * extraction so the patch and this module can never disagree about
 * which district an order carries.
 */

import {
  extractDeliveryDistrict,
  isServedDistrict,
} from "./courier-bridge";

export type CourierSuggestionPath =
  | "own_first"
  | "coming_soon_partner"
  | "customer_choice_partner"
  | "pending_for_shop";

export interface CourierSuggestion {
  /** Machine code for the answer path (never customer copy). */
  path: CourierSuggestionPath;
  /** True when the delivery district is in the served set. */
  served: boolean;
  /** True when the own courier must be presented first + highlighted. */
  highlightOwnFirst: boolean;
  /** Owner's own words, on the unserved outcome only. */
  displayMarker: "Coming Soon" | null;
  /** Partner-courier ordering is allowed on this outcome. */
  partnerOrderingAllowed: boolean;
  /** The customer chose a courier other than the suggestion (never forced). */
  customerChoiceHonoured: boolean;
  /** Invariant: the agent never books a third-party courier. */
  booksThirdParty: false;
  /** No district could be determined: order stays pending for the shop. */
  needsDistrict: boolean;
  /** The district text the decision was taken on ("" when unknown). */
  districtText: string;
}

export function decideCourierSuggestion(input: {
  /** Delivery district text, or a full address containing it. */
  districtText?: string | null;
  /** Full delivery address (fallback district source). */
  deliveryAddress?: string | null;
  /** The customer's own courier choice, when they stated one. */
  customerChoice?: "own" | "partner" | null;
}): CourierSuggestion {
  const districtText = String(
    input.districtText ?? input.deliveryAddress ?? ""
  ).trim();
  const served = districtText !== "" && isServedDistrict(districtText);
  if (districtText === "") {
    return {
      path: "pending_for_shop",
      served: false,
      highlightOwnFirst: false,
      displayMarker: null,
      partnerOrderingAllowed: false,
      customerChoiceHonoured: false,
      booksThirdParty: false,
      needsDistrict: true,
      districtText: "",
    };
  }
  if (served) {
    if (input.customerChoice === "partner") {
      return {
        path: "customer_choice_partner",
        served: true,
        highlightOwnFirst: false,
        displayMarker: null,
        partnerOrderingAllowed: true,
        customerChoiceHonoured: true,
        booksThirdParty: false,
        needsDistrict: false,
        districtText,
      };
    }
    return {
      path: "own_first",
      served: true,
      highlightOwnFirst: true,
      displayMarker: null,
      partnerOrderingAllowed: true,
      customerChoiceHonoured: false,
      booksThirdParty: false,
      needsDistrict: false,
      districtText,
    };
  }
  // Unserved: own courier is Coming Soon; partner ordering allowed.
  // A customer choice of "own" cannot be honoured here (the own
  // courier does not serve this district) — the outcome stays
  // coming_soon_partner and the choice is NOT silently rewritten
  // into a booking of anything.
  return {
    path: "coming_soon_partner",
    served: false,
    highlightOwnFirst: false,
    displayMarker: "Coming Soon",
    partnerOrderingAllowed: true,
    customerChoiceHonoured: false,
    booksThirdParty: false,
    needsDistrict: false,
    districtText,
  };
}

/** Suggestion for an order record, using the bridge's own district
 *  extraction (explicit district field, else drop-address text). */
export function courierSuggestionForOrder(order: {
  customFields?: unknown;
  deliveryAddress?: string | null;
}): CourierSuggestion {
  const district = extractDeliveryDistrict(order as { customFields?: unknown });
  return decideCourierSuggestion({
    districtText: district,
    deliveryAddress: order.deliveryAddress ?? null,
  });
}
