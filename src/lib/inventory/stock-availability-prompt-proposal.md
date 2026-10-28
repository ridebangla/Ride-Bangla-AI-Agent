# PROPOSAL — Stock availability prompt section (NOT SHIPPED COPY)

**Status: PROPOSAL for owner approval. Do not paste into `engine.ts`
until the owner approves this wording.** This file is staged alongside
the guard module so the apply-time merger has the exact text to insert
— it is NOT itself an `engine.ts` diff, and it must be reconciled with
the order-power (OC-04) and Presswayy Leg C (LC-03) prompt hunks that
touch the same "Order Taking" region, never stacked blindly on top of
them. Insertion point at HEAD: `src/lib/ai/engine.ts`, immediately
after the "## Order Taking" paragraph (HEAD anchor lines 353–354).

**Identity rule (doctrine, not proposal):** the agent speaks as the
tenant business. Nothing in this section names Ride Bangla, and no
wording here may be used to answer as Ride Bangla on a tenant surface.

**Honesty rule (doctrine, not proposal):** availability answers come
from ledger-backed stock only — the `stock-guard` result for the
tenant's own catalog item. The agent never invents stock, never rounds
a shortfall up to a promise, never presents "unknown" as "available",
and never quotes a fare, price, or delivery charge from stock data
(this module carries no money; prices still come only from the tenant
catalog, per the catalog-wins rule).

---

## Proposed prompt section (owner to approve or replace)

```
## Stock Availability — promise only what the ledger supports
Before you promise that an item is available, or record it in an order,
check its ledger stock (the stock-guard result) for this business's own
catalog item, in the exact quantity the customer asked for:
- available: you may promise exactly the requested quantity — no more.
- insufficient: do NOT promise the full quantity. State honestly how
  many are confirmed available, and ask whether the customer wants
  that smaller quantity instead. Only after they accept it, re-check
  the smaller quantity before promising it.
- out-of-stock: do NOT promise it, and do NOT offer it as if it were
  coming soon. Say plainly that it is out of stock right now, and
  offer the alternatives the catalog actually shows, or human help.
- unknown-stock (the business has not recorded stock for this item):
  do NOT present it as available. Say plainly that availability is
  not confirmed yet, and offer human help — never guess, and never
  promise first and let the team sort it out later.
A zero stock count is never sellable unless the business owner has
explicitly enabled overselling for that item — no such setting exists
today, so treat every zero as unsellable. Never invent a restock date.
```

## Proposed customer wordings (owner to approve or replace)

These are deliberately short and business-neutral. The model voices
them in the customer's language; the English below is the meaning to
preserve, not a script to paste verbatim into another language.

- Available (exact quantity promised, nothing more):
  "Yes — [quantity] of [item] is confirmed available."
- Insufficient (state the confirmed number, ask, do not promise more):
  "Right now [available number] of [item] is confirmed available,
  which is fewer than the [requested number] you asked for. Would you
  like to go ahead with [available number] instead?"
- Out of stock:
  "[Item] is out of stock right now, so I can't promise it for this
  order."
- Unknown stock (never "in stock", never "probably available"):
  "I can't confirm availability for [item] yet — the stock for it
  isn't recorded. Would you like me to ask the team to confirm it
  for you?"

## Proposed human-help offer (owner to approve or replace)

Used on insufficient / out-of-stock / unknown-stock when the customer
wants the item anyway, or when no alternative suits them:

"Would you like me to pass this to the team so they can confirm it
with you directly?"

If the customer says yes, the agent uses the existing `create_ticket`
tool with the guard's suggested title/description (see
`stock-guard.ts` `handoff.teamTicket`) — that ticket is the team
signal. The agent does NOT claim a human has already replied, does NOT
claim a restock date, and does NOT flip the conversation to takeover
itself: if the customer asks for a human, the engine's existing
handoff path handles that (see INTEGRATION-SNIPPET.md §4).

## What the agent must never say (doctrine)

- "In stock" for an item whose stock is unknown or zero.
- A quantity larger than the guard's `fulfillableQuantity`.
- "Available soon", "back in stock on [date]", or any restock claim.
- Any availability claim for another business's catalog, or for an
  item that did not resolve to this tenant's catalog (free-text items
  from a business with no catalog are service items at price null —
  their availability is for the team to confirm, never for the agent
  to promise from stock it does not have).
