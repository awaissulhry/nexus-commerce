---
name: stock-count
description: Count and correct stock at the business's own warehouses in Nexus - find what is due for a count, run a stock count (create, start, record what was counted, complete), show the differences, and apply them; or set counts directly, move stock between warehouses and hold units - each as a request a person approves. Never touches Amazon FBA or Shopify locations. Use when the person wants to count stock, fix a stock number, do a cycle count or inventory, move stock between warehouses, or hold units.
---

# Stock count

Stock changes only through Nexus's own movements, each one audited, and every listing that follows stock shows the new number. Amazon FBA stock is Amazon's number and Shopify locations are Shopify's: neither is counted or set here. A product that sells from another business's shared stock has no own stock row.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read

- `stock-locations`: every location, who owns its number (nexus, amazon-fba, shopify), the markets it serves and its totals. Only `nexus` locations can be counted or set.
- `cycle-counts`: the counts and their status; `dueAt` (a location code) lists the products due for a count there; `countId` gives one count's items (expected, counted, variance).
- `stock-search` (`location`, `band`: out, critical, low; `belowThreshold`), `stock-levels` (`productId`), `stock-movements` (`productId` or `sku`, `kind`, `since`) for why a number is what it is.

## 2. A stock count (the careful way)

One request per stage, because each needs the one before to have run:

1. `stock-count` `action: "create"` with `location` (the expected numbers are taken then), and a `note`.
2. `stock-count` `action: "start"` with the `countId` (`cycle-counts` names it).
3. `stock-count` `action: "record"` with `items` (`productId` + `counted`, up to 250 per request; more in ONE plan of several record steps). `action: "ignore"` leaves products out.
4. `stock-count` `action: "complete"`.
5. Show the differences from `cycle-counts` (`countId`): per item expected → counted, and the biggest gaps first. Ask about any large one before going on.
6. `reconcile-stock-count` (`countId`, optional `productIds`): stock moves by counted − expected, one movement each. A sale between the approval and the run stops it: read again and ask again.

## 3. Quicker fixes

| To | Tool |
|---|---|
| Set the on-hand count (the absolute number) | `set-stock` (`items`: `productId`, `location`, `quantity`, up to 250; `reason`: INVENTORY_COUNT, MANUAL_ADJUSTMENT or WRITE_OFF; `note`) |
| Move units between own warehouses | `transfer-stock` (`items`: `productId`, `fromLocation`, `toLocation`, `quantity`; out and in together) |
| Hold or release units (a promotion, a customer, a check) | `reserve-stock` (`action`: reserve or release) |
| Create, rename, switch off or on an own warehouse | `set-stock-location` (switch off only at 0 units, never the default one) |

- Show before asking: per product and location, the number now → after, and which channels will show the change.
- How each listing takes its number (pin, follow, buffer, push now) is per listing: `set-listing-stock` with targets from `listing-matrix` (see `list-product`). Amazon's EU markets share ONE quantity.
