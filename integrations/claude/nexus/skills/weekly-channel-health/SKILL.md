---
name: weekly-channel-health
description: Weekly health check of a Nexus business across Amazon, eBay, Shopify and Etsy - listing errors, out-of-sync listings, stock drift, price problems and triggered alerts - ending in a short prioritised to-do list. Use when the person asks how their channels or listings are doing, wants a weekly or Monday check, or asks what needs attention or whether anything is broken in Nexus. It only reads; it proposes no change until the person asks for one.
---

# Weekly channel health

A read-only check of the one business this Nexus connection was approved for. Use only the Nexus tools named here. Never fill a gap from memory or by guessing: if something could not be read, say so.

## Before you start

- If no Nexus tools are available, Nexus is not connected, or its server is not switched on yet. Say so and stop. To connect in Claude Code: run `/mcp`, choose the Nexus server, then Authenticate. In claude.ai: Customize > Connectors.
- If the person named a channel (`AMAZON`, `EBAY`, `SHOPIFY`, `ETSY`) or a market (such as `IT` or `DE`; `GLOBAL` for Shopify and Etsy), pass it as `channel` or `market` to every tool that takes one. Otherwise check everything.
- If a tool is missing or refuses, pass on its reason in plain words (most often the person's role in Nexus does not allow it). Name the part you could not check and carry on with the rest.

## Paging

The list tools answer with `items` and `nextCursor`. To read on, call the same tool again with the same filters and `cursor` set to `nextCursor`. The list has ended only when `nextCursor` is null; a page shorter than `limit` does not mean the end. Use `limit: 100`, read at most 5 pages per tool for this check, and say how many you read out of how many (`total`, when the answer has it).

## Steps

1. **Listing issues, errors first.** `listing-issues` with `severity: "error"`. Count listings per channel and market, and group the common problems (same `code` or message). Then call it once with `severity: "warning"` and `limit: 1`, only to read `total`.
2. **Out of sync.** `out-of-sync-listings`. Count by reason: `push-failed` (the last push to the channel failed), `quantity-behind` (the listing holds a different quantity from the one Nexus would send now), `channel-differs` (a read-back found the channel holding a different quantity, price or content). One call checks at most 1,000 listings, so a short page with a `nextCursor` means "keep going".
   - Always say, in plain words, what the answer lists under `neverChecked`: what nobody compares on each channel (for example eBay price per listing, Shopify content, anything on Etsy). Take it from the answer, not from memory.
   - Never call listings "in sync". Say "no difference found in the last read-back", say when that was (`readBack`), and say that anything under `neverChecked`, or an item's `notChecked`, was not checked at all.
3. **Stock drift.** `channel-stock-drift` with `limit: 100`: unresolved differences between the quantity a channel reported and Nexus's own. Note the largest. If exactly 100 come back, say "at least 100".
4. **Prices.** `channel-price-stock`, paged as above. Flag listings with no listed price; a sale price at or above the listed price; and listings that follow the master price (`followsMaster: true`, no `override`) whose listed price is not what their rule gives: the master price for `FIXED`, master × (1 + `adjustPercent` / 100) for `PERCENT_OF_MASTER`. Those may be waiting for a push. Leave out of that last check: `MATCH_AMAZON` listings, and listings whose `currency` is not the `masterCurrency` (or is null). Nexus never sends the master price to those, so their own price is expected to differ; at most, count them in one line. Price differences a channel itself reported are already in step 2. To look closer at one product, use `price-status`.
5. **Alerts.** `detect-anomalies` with `limit: 20`: alerts that fired recently (rule, observed value, threshold, when).

## Report

Keep it short and in plain English. No raw JSON, no long tables.

- One opening line: the date, and which channels and markets were checked.
- One or two lines per area: the counts, where they are, and at most 5 examples (SKU, channel, market).
- **Do first**: 3 to 5 concrete actions (what, where, how many), most urgent first, ranked this way:
  1. Live listings buyers cannot see or buy: error or suppressed status, failed pushes.
  2. Stock that could oversell: quantity behind, or a channel showing more than Nexus holds.
  3. Price problems: missing prices, differences a channel reported.
  4. Listings blocked from publishing because required values are missing.
  5. Warnings and alerts worth a look.
- One line on what was not checked (from step 2), and anything you could not read or stopped paging early.

End by asking whether the person wants help with any item. In this skill, do not call a change tool and do not draft changes nobody asked for. If they want fixes, `fix-listing-issues` handles listing problems and `bulk-reprice` handles prices. Every change Claude asks for waits for a person's approval in Nexus.
