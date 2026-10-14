---
name: price-review
description: Review prices in Nexus - master prices and their bounds, what each listing shows and why, sale events and eBay promotions, scheduled price changes (including ones that need a check), pricing rules and costs - then propose fixes (a master price, a listing price per market, an Amazon Business price and quantity discounts, a scheduled change, a promotion, costs) as one change plan a person approves. Use when the person asks why a listing has a price, whether prices are right, about sales and promotions, scheduled price changes, margins or costs. For one change across many products use bulk-reprice.
---

# Price review

A listing's price comes from one of: a scheduled sale, its own override, the channel rule, a pricing rule's suggestion, the master price, or its own price. Prices outside a product's bounds (min and max) are refused, never clamped. Costs, fees and margins show only to a person who may see them.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read

- `price-status` (`productId`): master price and currency, bounds, per listing the listed and sale price with its window, currency, rule, override, out of bounds, and a held price (kept while a listing is paused or a draft).
- `price-explain` (`productId`, `channel`, `marketplace`, `fulfillment`, `accountId`): why that listing has its price, step by step, with the last 20 price changes there. On Amazon it adds `business`: the business price for business buyers (Amazon Business) — its rule, the price it gives now and the normal price it follows, the quantity discounts and their unit prices, the last send to Amazon, and Amazon's own value when Nexus knows it (or why there is none).
- Amazon Business in `listing-matrix`: each Amazon market's `business` cell — rule `PERCENT_OFF` (the normal price minus a percent, following every normal price change) or `FIXED` (an exact price), the quantity discounts, the minimum and maximum price, `warnings` (for example hidden by Amazon), `held` (kept in Nexus until the listing can be sent to), the last `send`, Amazon's nightly check, and `setOutsideNexus` when Amazon shows a business price Nexus never kept. `writable` says whether it can be changed there; `blocked` says why not.
- `channel-price-stock` (filters, paged): many listings at once. `listing-matrix` (`productId`): per market for one family.
- `scheduled-price-changes` (`status`): changes waiting to run; `UNKNOWN` means a run died while applying it and needs a check (`needsCheck` counts them).
- `price-promotions`: sale events, eBay markdowns and volume pricing, and whether each would act (sale events apply only while the pricing schedule runs; eBay only when its live switch is on).
- `pricing-rules` (suggestions only; they send nothing), `product-costs` (`missingOnly`), `insights-report` (`report: "profit"`) for margins.

Report: prices out of bounds, listings below cost (when visible), missing prices, listings in another currency that do not follow the master, scheduled changes needing a check, promotions that will not act, and on Amazon business prices that Amazon hides, a business send that failed or waits, and a business price set outside Nexus.

## 2. Propose

| To | Tool |
|---|---|
| One product's master price | `set-price` |
| The same move on many / each its own price | `bulk-price-change` / `set-master-prices` (see `bulk-reprice`) |
| A listing's price in one market (set, by %, copy from another market in the same currency, a sale) | `set-listing-price` with `targets` from `listing-matrix` (a formula-owned price is refused) |
| A price change later, cancel one, or settle an UNKNOWN one after checking | `schedule-price-change` (`action`: create, cancel, resolve) |
| A promotion on a channel, market or product type | `set-promotion` (create or end; nothing reaches a channel while the pricing schedule is off) |
| An eBay markdown or volume pricing | `set-ebay-price-promotion` (it cannot be ended from Nexus: it is ended in eBay Seller Hub) |
| An Amazon listing's business price for business buyers (Amazon Business): a percent below the normal price or an exact price, up to 5 quantity discounts, or remove it | `set-listing-price` with `action: "business"`, `businessPrice` (`rule` `PERCENT_OFF` with `percent`, or `FIXED` with `price`; `tiers`; or `remove: true`) and `targets` (Amazon market keys) from `listing-matrix`; many listings at once: `bulk-listing-price-change` with `businessPrices` (each listing its own setting, one approval) |
| Send prices again, with the business price Nexus keeps | `resend-prices` (`which`: `both`, `price` or `business`) |
| A pricing rule's suggestions | `set-pricing-rule` |
| Cost prices | `set-product-costs` |

- The automatic repricer's rules belong to `automation-review` (`save-price-rule`).
- Show each change as from → to with its currency (master currency for master prices, the market's currency for listing prices), and which listings follow. Put the fixes in ONE `submit-change-plan`.
- An UNKNOWN scheduled change: check the master price first (`price-status`), then resolve it as `applied` or `retry`.
- Amazon Business: a business price above the normal price, or outside the listing's minimum or maximum price, is refused (Amazon would hide or refuse it), and so is one where Amazon lists no Amazon Business, or on a family parent: the tool says why. Fields left out keep what the listing has; only `remove: true` removes a business price, and one Amazon shows that Nexus never kept is never removed from Nexus (it is removed in Seller Central). A change on a paused, draft or Inactive listing is kept in Nexus and sent when it can be. A first business price is not sent while Amazon's shopper price differs from Nexus's: set the normal price right first. A business price change is never run by a rule: a person approves it in Nexus, and `undo-change` puts the old setting back.
