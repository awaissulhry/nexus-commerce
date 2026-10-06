---
name: ads-strategy
description: Set a business's advertising strategy per market in Nexus, for Amazon Sponsored Products and eBay Promoted Listings - read every target ACoS, budget, spend ceiling, bid limit, protected term, harvest policy and automation level Nexus holds today, show one table per market, ask the person's goal and numbers per market, then propose the settings as ONE change plan a person approves. The strategy lives in Nexus, never in this skill. Use when the person wants to set or change targets, budgets, ceilings, bid limits or automation for a market, plan ads for a launch or a new market, or asks what their ads strategy is.
---

# Ads strategy

The strategy is the settings Nexus holds: read them fresh every time, never from memory, never from another business. Nexus has no per-market strategy record and no per-market target field: to give a market one target ACoS, set the same target on every campaign of that market (`set-campaign-target-acos` with `market` does it in one request). Amounts are minor units of each campaign's own currency; never convert, never add markets together.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, never pause an ad, never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read what Nexus holds

Amazon, per market:
1. `ads-overview` (`market`): `connection` (mode, writesEnabled), campaigns allowed live writes and suppressed, the dial (`automation.autonomy`, `halted`).
2. `ad-campaigns` (`market`; follow `nextCursor`): per campaign `targetAcos`, `dailyBudgetCents`, `currency`, `biddingStrategy`, `placementsPct`, `minBidCents`/`maxBidCents`, `minBudgetCents`/`maxBudgetCents`, `liveWrites`, `bidsSuppressed`, `pinned`.
3. `list-automations` (`area: "amazon-ads"`), then `automation-detail` (`automation`, `rowId` for one row): A3 dial, halt, breaker and `caps.defaultTargetAcosPct`; A13 spend ceilings and bid policies (grain, `scopeId`, caps); A14 harvest policies; A15 protected terms; A1 rules (scope, caps, level); A7 budget schedules; A8 monthly budget plans; A9 budget pools.

eBay, per market:
4. `ads-overview` (`channel: "ebay"`): pacing against the monthly ceilings, findings (rates above break-even, missing costs, unpromoted listings, campaigns without a rule), `writes` (live or sandbox).
5. `ad-campaigns` (`channel: "ebay"`, `market`): `fundingModel`, `adRateStrategy`, `bidPercentage` (the campaign rate), `dailyBudgetCents`, `rulesBased`, `automation` (posture, protected, rules), `account`.
6. `list-automations` (`area: "ebay-ads"`): E1 rules and `caps.spendCeilings` (monthly cap, kill switch); `levelReason` names the eBay dial when it holds rules back.
7. `ebay-ad-details` (`view`: `listings`, `ad-groups` or `keywords`; `market`, `campaignId`): each promoted listing's ad rate and break-even rate, a Priority campaign's ad groups, its keywords and bids.

Not readable by any tool — write "not readable", never guess: a campaign's max bid change % and CPC ceiling, its budget baseline, which campaigns a rule reaches (A1 rows give only the count, `reach`); eBay campaign policy rate/bid caps and floors, eBay search terms.

## 2. Show one table per market

Rows: target ACoS (each campaign's, and the business default), daily budgets, market and campaign spend ceilings, bid policy, protected terms, harvest policy (the market's own row, or "inherits"), rules scoped to the market and their levels, campaigns on the live-write allowlist, live or sandbox. eBay: campaigns with funding model, rate or budget, posture, rules, monthly ceiling. Name what is business-wide (the Amazon dial, breaker and default target; the eBay dial) once, under the tables.

## 3. Ask, per market

The goal in the person's words (for example launch, grow, defend, profit) and their numbers: target ACoS, daily budgets, daily spend ceiling, bid floor and ceiling, brand terms to protect, harvest criteria, and how far automation may act. Offer today's values as the starting point; never suggest numbers of your own as if they were theirs.

## 4. Units — exact

| Field | Set with | Unit |
|---|---|---|
| Campaign `targetAcos` | `set-campaign-target-acos` `targetAcosPct` | typed as a percent above 0 to 100 (30 = 30 %), like the screen; stored and read (`ad-campaigns`) as a fraction 0–1 (0.3) |
| Business default `targetAcosPct` | `tune-ad-engine` `account-target-acos` | whole percent 1–500; `null` clears |
| Rule `bid_apply` `value` (`op: targetAcos` / `curBidTargetAcos`) | `save-ad-rule` | percent (30 = 30 %); blank uses the business default |
| Rule `bid_to_target_acos.targetAcos`, `set_campaign_target_acos.targetAcos` | `save-ad-rule` | fraction |
| Rule conditions `acos`, `ctr`, `cvr`, `budgetUtilization`, `sovPct`, `topSharePct` | `save-ad-rule` | fraction (yes, the two `…Pct` too); `declinePct`, `growthPct` whole percents; `…Cents` cents |
| Harvest `maxAcosPct`; coverage `acosCapPct` | `tune-ad-engine` | percent |
| Spend ceiling `dailyCapCents`; bid policy `minBidCents`/`maxBidCents` | `set-ad-guardrail` | cents; a bid policy value at least 2 |
| `dailyBudgetCents` (Amazon and eBay) | `set-campaign-budget`, `set-ebay-campaign-budget` | minor units of the campaign's currency |
| eBay rule metrics `acos_pct`, `ctr_pct`, `fee_pct_of_sales`; action `deltaPct`, `bidDeltaPct`, `minRatePct` | `save-ad-rule` (`kind: "ebay-ads"`) | percent |
| eBay `ratePct` | `set-ebay-ad-rates`, `promote-ebay-listings` | percent 2–100, one decimal |
| eBay policy `rateCapPct`/`rateFloorPct`; `bidCapCents`/`bidFloorCents` | `tune-ad-engine` `ebay-campaign-policy` | percent; cents |

What reads which target: Nexus's bid optimiser (auto-bid, autopilot plans and `bid_to_target_acos` rules) moves each keyword's bid toward the first of: the rule's or plan's own target (one a person set), the campaign's own `targetAcos`, the business default, profit data (profit mode), 30 %. A value outside what the screens take (above 0, at most 500 %) is skipped there, never converted. It writes to Amazon only on campaigns on the live-write allowlist. `bid_apply` rules (`op: targetAcos` / `curBidTargetAcos`) use their own `value`, else the business default. The external bidding engine also reads the campaign's `targetAcos` when it runs. eBay has no target ACoS: an `acos_pct` condition in a market-scoped rule is the proxy.

## 5. Propose ONE change plan

| To | Tool |
|---|---|
| Business default target ACoS | `tune-ad-engine` (`setting: "account-target-acos"`, `accountTargetAcos: { targetAcosPct }`) |
| Campaign target ACoS (one per market, or per campaign) | `set-campaign-target-acos` (`market` = every Amazon campaign there, or `campaignIds`; `targetAcosPct`; `why`). Nexus only: nothing is sent to Amazon. A person approves it in Nexus, or the person who asked confirms it in Claude when the business allows that; it never runs by rule. Show the list: campaign, now → target |
| Market or campaign daily spend ceiling | `set-ad-guardrail` (`kind: "spend-ceiling"`, `op: "set"`, `grain: "MARKET"` + `scopeId` market code, or `"CAMPAIGN"` + campaign id, `dailyCapCents`) |
| Market bid floor / ceiling | `set-ad-guardrail` (`kind: "bid-policy"`, `grain: "MARKET"`, `scopeId`, `minBidCents`, `maxBidCents`) |
| Protect a brand term from negation | `set-ad-guardrail` (`kind: "protected-term"`, `op: "set"`, `term`, `matchType` EXACT · PREFIX · CONTAINS, optional `marketplace`) |
| Daily budgets | `set-campaign-budget` (`campaignId`, `dailyBudgetCents`) — every change waits for a person |
| Harvest criteria for a market | `tune-ad-engine` (`setting: "harvest-policy"`, `harvestPolicy: { scopeGrain: "market", scopeId, minOrders, minClicks, maxAcosPct, windowDays }`) |
| Budget pool, budget schedule windows, breaker | `tune-ad-engine` (`budget-pool` / `budget-schedule` with `subjectId` of an existing one — a schedule's windows are replaced whole; `breaker`) |
| A market's rule | `save-ad-rule` (`scope: { marketplace: "IT" }`; eBay `"EBAY_IT"`), born OBSERVE (eBay: OFF); levels and previews in `automation-review` |
| Automation level, dial, engine switch | `turn-up-automation` / `turn-down-automation` (A3 dial and engine switches: no `rowId`) |
| eBay rates, budgets, rule guard rails | `set-ebay-ad-rates`, `set-ebay-campaign-budget`, `tune-ad-engine` (`ebay-campaign-policy`, `subjectId` = eBay campaign, one per step) |

- Show the plan per market: setting, from → to, unit, whether it can raise spend (`tune-ad-engine` previews say `spend: can-rise`; a guardrail preview says `loosen`).
- Every step is dry-run when the plan is submitted: a step that needs an earlier step to have run (a campaign after its market's new ceiling; on live, `restore-campaign` after `set-campaign-live-writes`) is refused. Ask for those as separate requests, one after another.
- The eBay campaign policy binds the eBay rules only, not Claude's or anyone's manual rate and bid changes; posture `OFF` or `protected` stops every rule on that campaign, `SUGGEST` makes them propose, `AUTO` adds nothing over `INHERIT`.

## 6. Limits that refuse or shrink a plan

- **Live or sandbox** is the server's, not the business's: each change preview says `live` or `sandbox`. An Amazon sandbox preview skips the live checks (halt, connection, markets, allowlist, pins, spend ceiling, daily budget move, value cap): a sandbox yes predicts nothing about live.
- **Amazon live ad writes only in IT, DE, FR and ES.** Any other Amazon market is refused at the live write gate, with no way round from Claude.
- **Allowlist:** an Amazon campaign takes a live write (approved change, rule or schedule) only when `liveWrites` is true; `set-campaign-live-writes` always waits for a person. eBay has no allowlist and no `suppress-campaign` (both Amazon-only).
- **Daily budget move:** by default an Amazon campaign's budget may move at most 30 % down or 50 % up (more for very small budgets) from the day's opening value per UTC day, counting every writer; it resets at 00:00 UTC. Plan bigger moves over several days. eBay: 15 budget changes per campaign per day.
- **Spend ceiling** caps the sum of today's Amazon budget increases, not spend; it never binds bids. One write above the server's value cap is refused.
- **Dial and halt are business-wide:** Amazon dial OFF or a halt refuses every live Amazon write except a suppression's lowering, approved changes included; SUGGEST keeps every rule proposing. An eBay market at its monthly ceiling (checked by `ads-overview` with `channel: "ebay"` and by the rule run) halts every eBay ad write of the business, lowering included, until a person resumes it.
- **First Amazon campaign in a new market:** `create-ad-campaign` needs that market's spend ceiling, and a MARKET ceiling or bid policy needs a campaign already in the market. So a person creates the first campaign (Nexus campaign builder, or Amazon's console, then it syncs); then set the ceiling; then Claude may create more. A new campaign is born with every bid at 2 cents and off the allowlist: then `set-campaign-live-writes`, then `restore-campaign`, each its own request.
- **eBay:** a General campaign starts at the 2 % minimum with no listings; a Priority campaign needs the market's monthly eBay ceiling in the market's currency holding 31 days of its budget, and is refused on eBay Spain when it runs.

## 7. No Claude tool — a person, in Nexus

| Setting | Where |
|---|---|
| A campaign's own bid bounds, pins, CPC ceiling | Ads › Rules & Automation › Control Room (guardrails) |
| Which campaigns a budget rule acts on (it reaches none until assigned) | Ads › Rules & Automation › Apply Rules; harvest destinations: Keyword Harvest |
| Creating budget pools, budget schedules, rank plans, coverage sets; monthly budget plans (A8) | Ads › Rules & Automation |
| Amazon Ads connection mode and enabling its writes | Nexus's Amazon Ads connection (an operator's step) |
| eBay dial, kill switch, monthly ceiling (that screen sets the EBAY_IT ceiling only today) | Ads › eBay › Rules & Automation |
| eBay campaign-level rate and rate strategy, ad groups | Ads › eBay |

## 8. After

`approval-status` per request; then read again (`ad-campaigns`, `list-automations`) and show the market tables with the new values. Weekly tuning against the strategy is `ads-weekly-review`; rule levels and why a rule acted are `automation-review`.
