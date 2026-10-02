---
name: price-review
description: Review prices in Nexus - master prices and their bounds, what each listing shows and why, sale events and eBay promotions, scheduled price changes (including ones that need a check), pricing rules and costs - then propose fixes (a master price, a listing price per market, a scheduled change, a promotion, tier prices, costs) as one change plan a person approves. Use when the person asks why a listing has a price, whether prices are right, about sales and promotions, scheduled price changes, margins or costs. For one change across many products use bulk-reprice.
---

# Price review

A listing's price comes from one of: a scheduled sale, its own override, the channel rule, a pricing rule's suggestion, the master price, or its own price. Prices outside a product's bounds (min and max) are refused, never clamped. Costs, fees and margins show only to a person who may see them.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read

- `price-status` (`productId`): master price and currency, bounds, per listing the listed and sale price with its window, currency, rule, override, out of bounds, and a held price (kept while a listing is paused or a draft).
- `price-explain` (`productId`, `channel`, `marketplace`, `fulfillment`, `accountId`): why that listing has its price, step by step, with the last 20 price changes there.
- `channel-price-stock` (filters, paged): many listings at once. `listing-matrix` (`productId`): per market for one family.
- `scheduled-price-changes` (`status`): changes waiting to run; `UNKNOWN` means a run died while applying it and needs a check (`needsCheck` counts them).
- `price-promotions`: sale events, eBay markdowns and volume pricing, and whether each would act (sale events apply only while the pricing schedule runs; eBay only when its live switch is on).
- `pricing-rules` (suggestions only; they send nothing), `product-costs` (`missingOnly`), `insights-report` (`report: "profit"`) for margins.

Report: prices out of bounds, listings below cost (when visible), missing prices, listings in another currency that do not follow the master, scheduled changes needing a check, promotions that will not act.

## 2. Propose

| To | Tool |
|---|---|
| One product's master price | `set-price` |
| The same move on many / each its own price | `bulk-price-change` / `set-master-prices` (see `bulk-reprice`) |
| A listing's price in one market (set, by %, copy from another market in the same currency, a sale) | `set-listing-price` with `targets` from `listing-matrix` (a formula-owned price is refused) |
| A price change later, cancel one, or settle an UNKNOWN one after checking | `schedule-price-change` (`action`: create, cancel, resolve) |
| A promotion on a channel, market or product type | `set-promotion` (create or end; nothing reaches a channel while the pricing schedule is off) |
| An eBay markdown or volume pricing | `set-ebay-price-promotion` (it cannot be ended from Nexus: it is ended in eBay Seller Hub) |
| B2B quantity tiers | `set-tier-prices` (Nexus quotes and B2B orders only) |
| A pricing rule's suggestions | `set-pricing-rule` |
| Cost prices | `set-product-costs` |

- The automatic repricer's rules belong to `automation-review` (`save-price-rule`).
- Show each change as from → to with its currency (master currency for master prices, the market's currency for listing prices), and which listings follow. Put the fixes in ONE `submit-change-plan`.
- An UNKNOWN scheduled change: check the master price first (`price-status`), then resolve it as `applied` or `retry`.
