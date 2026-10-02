---
name: bulk-reprice
description: Plan a price change for many products at once in Nexus (for example "raise all helmets by 5%", "set these SKUs to 49.90", "drop the jackets brand by 10 euros", "round everything to .90") - gather the products and their current prices, show the plan, and only after the person agrees ask for ONE bulk price change (or one change plan) that a person approves in Nexus. Use when the person wants to reprice several products together. Not for advertising bids.
---

# Bulk reprice

Works in the one business this Nexus connection was approved for, using only the Nexus tools. A change tool changes nothing by itself: it stores one request, and a person approves it in Nexus (unless the business set that tool to run by its rule). There is no tool to approve. Never say a price has changed until `approval-status` says the change ran.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Pin down the request

Ask only for what is missing:

- **Which products**: a SKU or the start of one (a parent SKU also matches its variants), a brand or name, a list of SKUs, or a channel and market.
- **The change**: one of
  - the same move for every product: a new price (`set`), a percentage (`percent`, e.g. -10) or an amount in the master currency (`amount`, e.g. 2.5) — `bulk-price-change`, rounded to the cent;
  - a price of its own for each product (to round to .90 or .99, or a list of new prices) — work out each price and use `set-master-prices`.
- **The price it changes**: both tools set the **master price**. Listings that follow the master price move with it and are sent to their marketplace; listings with their own price do not. A price for one channel and market only is a listing price: `set-listing-price` (see `price-review`).

## 2. Gather the products and their current prices

- `channel-price-stock` with a `sku` prefix, `channel`, `market` or `productId`: one row per channel listing with `productId`, `sku` and `price` (`master`, `listed`, `sale`, `followsMaster`, `override`, `rule`, `currency`, `masterCurrency`). Use `limit: 100`; call again with `cursor` set to `nextCursor` until it is null. Group the rows by product.
- `product-search` finds products by name, SKU or brand (or `savedViewId` from `saved-views`); then read prices with `channel-price-stock` (`productId`) or `price-status`. `price-status` also gives each product's price bounds (min and max): a new price outside them is refused, never clamped.
- Prefer one filtered list over one call per product. If you would need more than about 20 single calls, say it will take a while, or ask for a narrower filter.
- Leave out, and list separately, products with no master price. Master prices are in the one master currency (`masterCurrency`, normally EUR). A listing's `listed` price is in its market's `currency`, which can differ (GBP, SEK, PLN, USD).

## 3. Show the plan, then stop and ask

- How many products, and the change in one line ("raise the master price 5%, rounded to the cent").
- A table of up to 15 rows: SKU, current master price, new master price, change in %. Then "and N more", with the smallest and largest change.
- Which listings follow: those with `followsMaster: true`, no `override` and a `currency` equal to `masterCurrency`, under rule `FIXED` (they take the master price) or `PERCENT_OF_MASTER` (master adjusted by their `adjustPercent`). Those with an `override`, `followsMaster: false`, rule `MATCH_AMAZON`, or another currency keep their price. Give counts per channel, not every row.
- Anything odd: a change bigger than 20%, a new price below a listing's sale price, a price outside a product's bounds, products left out. A new price of 0 or less is refused.

Then ask: "Shall I send this to Nexus as one price change for approval, for <business>?" Go on only after a clear yes.

## 4. Ask for it: one request

- Read the tool's own description for its exact arguments. `bulk-price-change`: `products` (Nexus ids or SKUs, up to 250), `operation`, `value`. `set-master-prices`: `prices` as `[{ product, price }]`, up to 250. Both need `business`.
- Up to 250 products: call the tool **once**.
- More than 250: ONE `submit-change-plan` with one `bulk-price-change` (or `set-master-prices`) step per batch of up to 250 — one approval for all of it. Each step's `args` are the tool's own arguments without `business`; the plan names the business once.
- `set-price` is only for a plan with exactly one product. Never loop it.
- If the tool is not offered or refuses, say why (the connection may be read-only: connect again and allow "Ask for changes"; or the person's role does not allow price changes) and stop.

## 5. Say what happens next

- Waiting for approval: nothing has changed yet; give the `approveAt` link and `expiresAt`.
- Runs by rule: it runs at `runsAt` unless someone stops it at `stopAt`.
- After it runs, Nexus sets the master prices; the listings that follow them get the new price and each channel is updated by Nexus's own push, with that channel's checks — not all at once.
- `approval-status` with the `approvalId` shows where it is, including the channel pushes (`channels`: waiting, sent, failed). Offer to check later.
- To put the old prices back later: `undo-change` with the `approvalId` (see `review-and-undo`).
