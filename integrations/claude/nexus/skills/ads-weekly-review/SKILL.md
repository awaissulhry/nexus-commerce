---
name: ads-weekly-review
description: Weekly advertising review in Nexus, market by market, for Amazon Sponsored Products and eBay Promoted Listings - read spend, sales and ACoS, wasteful and converting search terms, bids and the engines' recommendations, explain them in plain words, then offer the changes as one change plan (negatives, exact keywords, lower bids, budgets, eBay rates) that a person approves. A temporary stop is lower bids; it pauses an ad only when the person means a real pause. Use when the person asks how their ads are doing, for a weekly ads or bid review, or what to change in their campaigns.
---

# Ads weekly review

Reads first, then proposes. Nothing changes until a person approves the plan in Nexus (or the business lets a tool run by its rule). A temporary stop is **lower bids**, never a pause: an ad serves again about a minute after its bids go back, but only about an hour after a pause is lifted. To stop an Amazon campaign spending for a while, `suppress-campaign` lowers its bids to the 2-cent floor (a suppressed bid is never raised); on eBay, lower the ad rates (2 % is eBay's minimum), the keyword bids or the daily budget. Pause an Amazon ad (`pause-ads`) only when the person says they mean a real pause. Targets per market (target ACoS, ceilings, bid limits) are set with the `ads-strategy` skill; this review measures against them.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **Products the ads brain runs (Amazon).** Nexus's ads brain may run a product's levers in a market, each at a level (`OFF`, `OBSERVE` in shadow, `PROPOSE`, `AUTO`). Read `ads-brain` (8) before proposing anything for such a product. Never propose a change on a lever the brain owns on a campaign (its `brain` in the map is `PROPOSE` or `AUTO`, or its `owner` is the brain): no bid, placement, budget, negative, harvest, pause or structure there. Explain what the brain did instead, from its daily product report, and name its requests that wait for the person (a person decides them in Nexus: never ask for them again). Its clashes and tool gaps go in the explanation. Enrolling, a lever's level, a lock, an exclusion and its kill switch are the Owner's own (`set-ads-brain`, `set-brain-kill-switch`): only when he asks for one.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## How to read the numbers

- Amounts are minor units (cents) of each campaign's own currency, with the currency named beside them. Never convert, and never add two markets together: each market is reported on its own.
- The last 3 days are provisional (Amazon restates them for up to 72 hours). `dataAsOf` is the newest day of data.
- A person without the ad-spend money permission sees the same answers without amounts: say so, and review by clicks, orders and ACoS only.
- Live or sandbox is the server's switch: each change preview's `reach` says `live` or `sandbox` (sandbox = recorded in Nexus only). An Amazon sandbox preview skips the live checks (halt, connection, markets, allowlist, pins, spend ceiling, daily budget move, value cap), so it predicts nothing about live.
- Amazon live ad writes happen only in IT, DE, FR and ES; any other Amazon market is refused at the live write gate. On Amazon, `liveWrites` in `ad-campaigns` is the campaign's live-write allowlist: a campaign off it takes no live change, and putting it on (`set-campaign-live-writes`) waits for a person, unless the business lets it run by its rule for a campaign Claude itself created. eBay has no allowlist: its live or sandbox is server-wide (`writes`).

## 1. Per market: read

Ask which channel (`amazon`, the default, or `ebay`) and markets, or take every market with spend.

1. `ads-overview` (`channel`, `market`, `days`: 7 by default): spend, sales, ACoS, ROAS, against the period before; top spenders; the automation dial; data feed health. eBay: pacing against the monthly ceilings and findings (rates above break-even, missing costs, unpromoted listings). This eBay read also checks the ceilings: a market at its monthly ceiling halts every eBay ad write of the business until a person resumes it — say so if it happens.
2. `ad-campaigns` (`channel`, `market`, `status`, `days`): Amazon per campaign budget, `targetAcos` (a fraction), ACoS, `liveWrites`, suppressed bids, pins. eBay per campaign funding model, campaign rate (`bidPercentage`), daily budget (Priority), `automation` (posture, rules), account; eBay statuses are RUNNING, PAUSED, SYSTEM_PAUSED, ENDED, SUSPENDED, SCHEDULED.
3. Amazon only — `ad-search-terms` (`kind: "wasteful"` then `"converting"`, `market`, `days: 30`): terms that spent with no order (negative candidates) and terms with 2 or more orders (exact-keyword candidates). Rows with `isAsin: true` are ASINs: `harvest-search-term` makes one a product target, `add-negative-targets` (`asins`) negates one.
4. Amazon only — `ad-targets` (`campaignId` or `market`, `search`) for the bids behind a problem.
5. `ad-recommendations` (`channel`, `market`, `category`): Amazon — what the engines and the rules suggest, the autopilot plans' waiting decisions (`autopilot`) and the Keyword Tracker's waiting proposals (`tracker`), with the ids each change tool takes and `suggestedTool`. eBay — only the eBay rules' pending proposals (`category` absent or `"rule"`), with no `suggestedTool`. A pause suggestion is information only.
6. `ad-changes` (`channel`, `days: 14`) when the person asks "what changed" or a number moved for no clear reason.
7. Amazon only, when a change touches them: `ad-groups` (`campaignId`: default bids, floors, product ads), `ad-budgets` (`market`: the month's budget plan, budget schedules, pools, baselines), `ad-portfolios` (`market`) and `ad-hourly-plans` (`market`, or `planId` for one plan's week).
8. Amazon only — `ads-brain`: `view: "map"` (`market`) names the products the ads brain runs; for each, `view: "map"` (`productId`, `market`: who owns each lever of each campaign), `view: "report"` (`market`, then `productId`: the brain's daily product report in plain words, what waits for a person) and `view: "clashes"` (`market`); `view: "setup"` for the tools not set up; `view: "money"` (`productId`, `market`) for its off-Amazon lane (`offAmazon`: its share of spend and a line for the Owner when it stays above the band — the setting itself is in Amazon's console, Nexus cannot change it).

`ad-search-terms` and `ad-targets` read Amazon data only: they take no `channel`, and a call with one is refused. eBay: `ebay-ad-details` (`view`: `listings`, `ad-groups` or `keywords`; `campaignId`, `market`, `adGroupId`, `search`, `days`, `limit`, `cursor`) reads each promoted listing's ad rate and break-even rate (`rateNote` says why `set-ebay-ad-rates` cannot change a campaign's rates), a Priority campaign's ad groups, and its keywords with bids and metrics, under the ids `set-ebay-ad-rates` and `ebay-keywords-change` take (`ebayCampaignId`, `ebayItemId`, `ebayAdGroupId`, `ebayKeywordId`). No tool reads eBay search terms. Never call a change tool just to look (it queues a request).

## 2. Explain

Per market, a few lines: spend and sales against last week, ACoS against the target the business holds in Nexus (`ads-strategy`), the 3 biggest wastes, the 3 best converting terms (Amazon), campaigns over budget or starved, anything an engine flags. For each product the ads brain runs: what it did or would do in shadow, what waits for a person, its clashes and the tools not set up. Then a short list of proposed changes with why — none on a lever the brain owns.

## 3. Propose (one plan per review)

| To | Tool |
|---|---|
| Stop a search term triggering ads (Amazon) | `create-negative-keyword` (`externalCampaignId`, `externalAdGroupId`, `keywordText`, `matchType`); many at once, one set of terms into many of one product's ad groups, campaign negatives or negative ASINs: `add-negative-targets`. Never a term that converts where it lands; another product's ad group only on the person's word (`allowOtherProducts`) |
| Lift a negative that blocks too much (Amazon) | `retire-negatives` (any negative, Claude's or a person's): at Amazon it is archived for good, so blocking again adds a new one; lifting a block can raise spend. The preview says who added each |
| Promote a converting term to an exact keyword (Amazon) | `harvest-search-term` (`query`, `sourceAdGroupId`; the destination is the one named, else the one `set-harvest-destination` stored): the keyword and, once it stands, the source negative in one step. A term that converts in its source is never negated there: ask with `negateSource: false`, and close the old place later with `add-negative-targets` once the new keyword wins. `graduate-keyword` is the keyword alone |
| Add keywords, product or category targets to an ad group (Amazon) | `add-ad-targets` (up to 250; `startAtFloor: true` starts them at the floor, raised later with `set-target-bid`). A term the same product already buys elsewhere waits for `sameProductTerms` |
| Change one bid / many bids (Amazon) | `set-target-bid` (`targetId`, `proposedBidCents`, at least 5) / `bulk-ad-bid-change` (`bids` up to 250, or a selection and `percent`); an ad group's default bid: `set-ad-group` (`op: "edit"`). A bid past the largest change is warned on the card and the person's approval sends it in full. `afterwards: "auto-bid"` hands a bid back to auto-bid; the default `hold` keeps auto-bid off it for 60 days |
| Change a daily budget (Amazon) | `set-campaign-budget` (one campaign, or `campaigns` in one request) — by default it may move at most 30 % down or 50 % up per UTC day, so plan larger cuts over several days; `restore-budget-baselines` puts budgets back to a captured baseline |
| The month's budget plan, budget schedules, budget pools (Amazon) | `set-monthly-ad-budget`, `set-budget-schedule`, `set-budget-pool`, read with `ad-budgets` |
| Portfolios and campaign settings (Amazon) | `set-portfolio` (create, rename, cap; archive is for good), `set-campaign-settings` (into or out of a portfolio, name, end date, bidding strategy), read with `ad-portfolios` |
| Ad groups and product ads (Amazon) | `create-ad-group` (born at the floor; `set-ad-group` `op: "start"` gives its planned bids back), `add-product-ads`, `set-ad-group` (`op: "stop"` is low bids, never a pause) |
| An hourly bid plan (Amazon) | `set-hourly-bid-plan`, read with `ad-hourly-plans`, only when the person asks: the plans are the Owner's. A plan a person made changes by rule only where the business allowed it; a playbook's own plan is refused |
| Placement adjustments (Amazon) | `set-placement-multipliers` |
| An existing Sponsored Brands or Sponsored Display campaign (Amazon) | the same tools: `set-campaign-budget`, `set-target-bid`, `bulk-ad-bid-change`, `pause-ads`, `enable-ads`, `add-negative-targets`, `retire-negatives` (not for them yet: placements, a stop by low bids, archive, ad groups and product ads; a new SB/SD campaign is made on the Nexus screens; a retired Sponsored Brands negative keyword can never be added to that campaign again) |
| Stop a campaign spending for a while, no pause (Amazon only) | `suppress-campaign`; `restore-campaign` puts the bids back (for a campaign born at the floor that never served, its first restore is a go-live: the approver's authenticator code) |
| A real pause, only when the person means one (Amazon only) | `pause-ads` (campaigns, ad groups, keywords and targets, product ads by ad group and SKU); `enable-ads` switches back on what a Claude request paused. With `includePeoplesPauses: true` it also switches on what a person paused in Nexus or at Amazon, or a rule that is off now: the preview says who paused it and when, the approver's authenticator code is needed, and it never runs by rule. Never while the rule that paused it is still on |
| Archive, only when the person means it for good (Amazon only) | `archive-ads`: PERMANENT — Amazon cannot switch an archived ad on again (its API calls this delete). Say so before asking; advise keeping archive at ask |
| Apply or dismiss what PROPOSE rules suggested | `decide-automation-suggestions` (`kind`: `amazon-ads` or `ebay-ads`; an Amazon apply may carry a value of its own, `override`; a pause suggestion is refused: dismiss it, and ask for `pause-ads` if the person wants a real pause) |
| Carry out the engines' recommendations, autopilot decisions and Keyword Tracker proposals (Amazon) | `apply-ad-recommendations` (ids from `ad-recommendations`, up to 100: one change plan of its own); set aside the wrong ones with `mute-ad-recommendations` (`mute`, or `dismiss` for a rule's suggestion, an autopilot decision or a proposal) |
| eBay: rates, keywords, budgets, promote listings | `set-ebay-ad-rates` (General, fixed-rate campaigns; a rate above a listing's known break-even is refused, an unknown one only warns), `ebay-keywords-change` (manual Priority, keyword ids from `ebay-ad-details` or a proposal), `set-ebay-campaign-budget` (Priority; 15 changes per campaign per day), `promote-ebay-listings` |

- Give `why` on every change: the approver reads it, and it stays in the ads audit.
- Put the review's changes in ONE `submit-change-plan` (a bulk bid change is one step). Show the table first: campaign, what, from → to, currency, live or sandbox.
- New campaigns (`create-ad-campaign`, `create-ebay-campaign`) only when the person asks: an Amazon one is born safe (bids at the 2-cent floor, off the allowlist), an eBay General one starts at the 2% minimum rate with no listings. The steps around a first campaign in a market are in `ads-strategy`.
- Targets, ceilings and bid limits belong to `ads-strategy`; rules, engines and their levels to `automation-review`.

## 4. After

`approval-status` shows `ads` (Amazon writes waiting, sent, refused by the write gate, failed, or run in sandbox) and `ebay` for eBay writes (sent, sandbox, partly, failed). `undo-change` asks to put an approved change back (see `review-and-undo`); on eBay an undo never removes anything: promoted listings drop to the 2 % rate, added keywords to a 2-cent bid, added negatives stay, and a created campaign stays.
