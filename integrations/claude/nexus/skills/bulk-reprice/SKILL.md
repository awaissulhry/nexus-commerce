---
name: bulk-reprice
description: Plan a price change for many products at once in Nexus (for example "raise all helmets by 5%", "set these SKUs to 49.90", "drop the jackets brand by 10 euros") - gather the products and their current prices, show the plan, and only after the person agrees queue ONE bulk price change that a person approves in Nexus. Use when the person wants to reprice several products together. Not for advertising bids.
---

# Bulk reprice

Works in the one business this Nexus connection was approved for, using only the Nexus tools. Claude cannot change a price: `bulk-price-change` only queues one request, and a person approves or rejects it in the Nexus Approvals page. There is no tool to approve. Never say a price has changed.

If no Nexus tools are available, Nexus is not connected, or its server is not switched on yet: say so and stop (to connect in Claude Code: `/mcp`, choose the Nexus server, Authenticate; in claude.ai: Customize > Connectors).

## 1. Pin down the request

Make sure you know, and ask only for what is missing:

- **Which products**: a SKU or the start of one (a parent SKU also matches its variants), a brand or name, a list of SKUs, or a channel and market.
- **The change**: a percentage, an amount, or a new price; and any rounding the person wants (to .90 or .99, say). Without one, round to the cent.
- **The price it changes**: `bulk-price-change` sets the **master price** only. Channel listings that follow the master price move with it; listings with their own price do not. A price for one channel only cannot be set from here: say so, and point the person to the listing in Nexus.

## 2. Gather the products and their current prices

- `channel-price-stock` with a `sku` prefix, `channel`, `market` or `productId`: one row per channel listing with `productId`, `sku` and `price` (`master`, `listed`, `sale`, `followsMaster`, `override`, `rule`). Use `limit: 100`; to read on, call again with the same filters and `cursor` set to `nextCursor`, until `nextCursor` is null. Group the rows by product.
- `product-search` finds products by name, SKU or brand (at most 50 per call, no paging); then read each product's prices with `channel-price-stock` (`productId`) or `price-status`.
- Prefer one filtered list over one call per product. If you would need more than about 20 single calls, say it will take a while, or ask for a narrower filter.
- Skip, and list separately, products with no master price. Prices are in each product's own currency: a fixed amount must not mix currencies.

## 3. Show the plan, then stop and ask

Keep it short:

- How many products, and the change in one line ("raise the master price 5%, rounded to .90").
- A table of up to 15 rows: SKU, current master price, new master price, change in %. Then "and N more", with the smallest and largest change.
- Which channel listings will follow: those with `followsMaster: true` and no `override`, under rule `FIXED` (they take the master price) or `PERCENT_OF_MASTER` (master adjusted by their `adjustPercent`). Those with an `override`, `followsMaster: false` or rule `MATCH_AMAZON` keep their price. Give counts per channel, not every row.
- Ask about anything odd before going on: a new price of 0, a change bigger than 20%, a new price below a listing's sale price, products left out.

Then ask plainly: "Shall I send this to Nexus as one price change for approval?" Go on only after a clear yes. If the person changes the plan, show it again.

## 4. Queue it: one request

- Read the tool's own description for its exact arguments, then call `bulk-price-change` **once** with every product in the plan.
- It takes up to 250 products. If the plan has more, say so before calling, and offer batches of up to 250: each batch is a separate request and a separate approval. Queue them only if the person agrees.
- Never loop `set-price` over the products to get around the bulk tool. `set-price` is only for a plan with exactly one product.
- If `bulk-price-change` is not offered or refuses, say why in plain words (the connection may be read-only: connect Nexus again and allow "Ask for changes"; or the person's role in Nexus does not allow price changes) and stop. Do not fall back to single calls.

## 5. Say what happens next

The answer has `status: "waiting_for_approval"`, an `approvalId`, `expiresAt`, `approveAt` (the link to the Approvals page) and a `preview`. Tell the person, in a few lines:

- Nothing has changed yet. Someone with the right permission must approve it in Nexus: give the `approveAt` link. It expires at `expiresAt` if nobody decides.
- After approval, Nexus holds the change for a short undo window, then sets the master prices.
- The channels follow after that, not at once: listings that follow the master price get their new price in Nexus, and each channel is updated by Nexus's own push, with that channel's settings and checks. Listings with their own price do not change.
- `approval-status` with the `approvalId` shows where it is; offer to check later, and repeat its `meaning` when you do.
