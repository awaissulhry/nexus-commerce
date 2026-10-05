---
name: ads-weekly-review
description: Weekly advertising review in Nexus, market by market, for Amazon Sponsored Products and eBay Promoted Listings - read spend, sales and ACoS, wasteful and converting search terms, bids and the engines' recommendations, explain them in plain words, then offer the changes as one change plan (negatives, exact keywords, lower bids, budgets, eBay rates) that a person approves. Never pauses anything. Use when the person asks how their ads are doing, for a weekly ads or bid review, or what to change in their campaigns.
---

# Ads weekly review

Reads first, then proposes. Nothing changes until a person approves the plan in Nexus (or the business lets a tool run by its rule). Ads in Nexus are **never paused**. To stop an Amazon campaign spending, `suppress-campaign` lowers its bids to the 2-cent floor (a suppressed bid is never raised); on eBay, lower the ad rates (2 % is eBay's minimum), the keyword bids or the daily budget. Targets per market (target ACoS, ceilings, bid limits) are set with the `ads-strategy` skill; this review measures against them.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, never pause an ad, never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## How to read the numbers

- Amounts are minor units (cents) of each campaign's own currency, with the currency named beside them. Never convert, and never add two markets together: each market is reported on its own.
- The last 3 days are provisional (Amazon restates them for up to 72 hours). `dataAsOf` is the newest day of data.
- A person without the ad-spend money permission sees the same answers without amounts: say so, and review by clicks, orders and ACoS only.
- Live or sandbox is the server's switch: each change preview's `reach` says `live` or `sandbox` (sandbox = recorded in Nexus only). An Amazon sandbox preview skips the live checks (halt, connection, markets, allowlist, pins, spend ceiling, daily budget move, value cap), so it predicts nothing about live.
- Amazon live ad writes happen only in IT, DE, FR and ES; any other Amazon market is refused at the live write gate. On Amazon, `liveWrites` in `ad-campaigns` is the campaign's live-write allowlist: a campaign off it takes no live change, and putting it on (`set-campaign-live-writes`) is the person's decision and always waits for a person. eBay has no allowlist: its live or sandbox is server-wide (`writes`).

## 1. Per market: read

Ask which channel (`amazon`, the default, or `ebay`) and markets, or take every market with spend.

1. `ads-overview` (`channel`, `market`, `days`: 7 by default): spend, sales, ACoS, ROAS, against the period before; top spenders; the automation dial; data feed health. eBay: pacing against the monthly ceilings and findings (rates above break-even, missing costs, unpromoted listings). This eBay read also checks the ceilings: a market at its monthly ceiling halts every eBay ad write of the business until a person resumes it — say so if it happens.
2. `ad-campaigns` (`channel`, `market`, `status`, `days`): Amazon per campaign budget, `targetAcos` (a fraction), ACoS, `liveWrites`, suppressed bids, pins. eBay per campaign funding model, campaign rate (`bidPercentage`), daily budget (Priority), `automation` (posture, rules), account; eBay statuses are RUNNING, PAUSED, SYSTEM_PAUSED, ENDED, SUSPENDED, SCHEDULED.
3. Amazon only — `ad-search-terms` (`kind: "wasteful"` then `"converting"`, `market`, `days: 30`): terms that spent with no order (negative candidates) and terms with 2 or more orders (exact-keyword candidates). Rows with `isAsin: true` have no tool.
4. Amazon only — `ad-targets` (`campaignId` or `market`, `search`) for the bids behind a problem.
5. `ad-recommendations` (`channel`, `market`, `category`): Amazon — what the engines and the rules suggest, with the ids each change tool takes and `suggestedTool`. eBay — only the eBay rules' pending proposals (`category` absent or `"rule"`), with no `suggestedTool`. A pause suggestion is information only.
6. `ad-changes` (`channel`, `days: 14`) when the person asks "what changed" or a number moved for no clear reason.

`ad-search-terms` and `ad-targets` read Amazon data only: they take no `channel`, and a call with one is refused. eBay: `ebay-ad-details` (`view`: `listings`, `ad-groups` or `keywords`; `campaignId`, `market`, `adGroupId`, `search`, `days`, `limit`, `cursor`) reads each promoted listing's ad rate and break-even rate (`rateNote` says why `set-ebay-ad-rates` cannot change a campaign's rates), a Priority campaign's ad groups, and its keywords with bids and metrics, under the ids `set-ebay-ad-rates` and `ebay-keywords-change` take (`ebayCampaignId`, `ebayItemId`, `ebayAdGroupId`, `ebayKeywordId`). No tool reads eBay search terms. Never call a change tool just to look (it queues a request).

## 2. Explain

Per market, a few lines: spend and sales against last week, ACoS against the target the business holds in Nexus (`ads-strategy`), the 3 biggest wastes, the 3 best converting terms (Amazon), campaigns over budget or starved, anything an engine flags. Then a short list of proposed changes with why.

## 3. Propose (one plan per review)

| To | Tool |
|---|---|
| Stop a search term triggering ads (Amazon) | `create-negative-keyword` (`externalCampaignId`, `externalAdGroupId`, `keywordText`, `matchType`) |
| Promote a converting term to an exact keyword (Amazon) | `graduate-keyword` (`query`, `sourceExternalCampaignId`, …); it does not negate the source — add that negative as its own step |
| Change one bid / many bids (Amazon) | `set-target-bid` (`targetId`, `proposedBidCents`, at least 5) / `bulk-ad-bid-change` (`bids` up to 250, or a selection and `percent`) |
| Change a daily budget (Amazon) | `set-campaign-budget` — every budget change waits for a person; by default it may move at most 30 % down or 50 % up per UTC day, so plan larger cuts over several days |
| Placement adjustments (Amazon) | `set-placement-multipliers` |
| Stop a campaign spending, no pause (Amazon only) | `suppress-campaign`; `restore-campaign` puts the bids back |
| Apply or dismiss what PROPOSE rules suggested | `decide-automation-suggestions` (`kind`: `amazon-ads` or `ebay-ads`; a pause suggestion is refused: dismiss it) |
| eBay: rates, keywords, budgets, promote listings | `set-ebay-ad-rates` (General, fixed-rate campaigns; a rate above a listing's known break-even is refused, an unknown one only warns), `ebay-keywords-change` (manual Priority, keyword ids from `ebay-ad-details` or a proposal), `set-ebay-campaign-budget` (Priority; 15 changes per campaign per day), `promote-ebay-listings` |

- Give `why` on every change: the approver reads it, and it stays in the ads audit.
- Put the review's changes in ONE `submit-change-plan` (a bulk bid change is one step). Show the table first: campaign, what, from → to, currency, live or sandbox.
- New campaigns (`create-ad-campaign`, `create-ebay-campaign`) only when the person asks: an Amazon one is born safe (bids at the 2-cent floor, off the allowlist), an eBay General one starts at the 2% minimum rate with no listings. The steps around a first campaign in a market are in `ads-strategy`.
- Targets, ceilings and bid limits belong to `ads-strategy`; rules, engines and their levels to `automation-review`.

## 4. After

`approval-status` shows `ads` (Amazon writes waiting, sent, refused by the write gate, failed, or run in sandbox) and `ebay` for eBay writes (sent, sandbox, partly, failed). `undo-change` asks to put an approved change back (see `review-and-undo`); on eBay an undo never removes anything: promoted listings drop to the 2 % rate, added keywords to a 2-cent bid, added negatives stay, and a created campaign stays.
