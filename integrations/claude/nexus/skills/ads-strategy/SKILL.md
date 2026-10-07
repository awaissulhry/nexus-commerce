---
name: ads-strategy
description: Set a business's advertising strategy in Nexus, for Amazon Sponsored Products (per market, and per category or product inside a market) and eBay Promoted Listings - read the strategy Nexus holds (ads-strategy) and the older settings that still bind (campaign targets, budgets, spend ceilings, bid policies, protected terms, harvest policies, automation levels), show one table per market, ask the person's goal and numbers per market and for any category or product that differs, then propose the changes as ONE change plan a person approves (set-ads-strategy for the strategy). The strategy lives in Nexus, never in this skill. Use when the person wants to set or change targets, budgets, ceilings, bid limits or what Claude may do alone for a market, a category or a product, plan ads for a launch or a new market, or asks what their ads strategy is.
---

# Ads strategy

The Amazon ads strategy lives in Nexus, in one place per market, and per category or product inside a market: goal and why, target ACoS or TACoS, monthly spend cap, lowest and highest bid, largest bid change per action, most actions per run, protection, harvest and negate thresholds, how a temporary stop works, and what Claude may do alone per kind of ad action. Read it with `ads-strategy`; change it with `set-ads-strategy`. Read it fresh every time, never from memory, never from another business. Amounts are minor units of each market's own currency; never convert, never add markets together.

Inside a market the most specific row wins: the product (a variation, then its parent), then its primary category (deepest first), then the market. Several products in one ad group take the safer number per field. Every category or product row belongs to one market. The older settings (a campaign's own target and bid limits, bid and harvest policies, spend ceilings, budget plans) keep binding: for a target the campaign's own wins; for a limit the stricter one binds.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **Raising needs the person's code.** A strategy change that loosens anything (a higher target, cap or bid ceiling, a lower bar to harvest, more for Claude to do alone) waits for the person's authenticator code, in Nexus or with `confirm-change`. A change that only tightens does not.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read what Nexus holds

Amazon, per market:
1. `ads-strategy` (`market`, `view: "rows"`): every strategy row of the market — the market's own, each category's and each product's — with its version, and the older settings at the same grains. Then `view: "effective"` for the market, and for each category, product, campaign or ad group the person asks about: every number in force with the row it came from (`source`), the older settings that still bind (`alsoInForce`, and which is `stricter`), the campaigns whose own target ACoS wins over the strategy (`shadowedBy`), and what Claude may do alone (`claude`: the business's level per tool, the strategy's, and the one that applies, `effective`). `view: "history"` lists the changes.
2. What acts today: each field's `readBy` names what reads it, and `notReadYet` lists the fields that are stored and shown only. Say which is which in plain words; never say an engine follows a field it does not read yet.
3. `ads-overview` (`market`): `connection` (mode, writesEnabled), campaigns allowed live writes and suppressed, the dial (`automation.autonomy`, `halted`).
4. `ad-campaigns` (`market`; follow `nextCursor`): per campaign `targetAcos`, `dailyBudgetCents`, `currency`, `biddingStrategy`, `placementsPct`, `minBidCents`/`maxBidCents`, `minBudgetCents`/`maxBudgetCents`, `liveWrites`, `bidsSuppressed`, `pinned`.
5. `list-automations` (`area: "amazon-ads"`), then `automation-detail` (`automation`, `rowId` for one row): A3 dial, halt, breaker and `caps.defaultTargetAcosPct`; A13 spend ceilings and bid policies (grain, `scopeId`, caps); A14 harvest policies; A15 protected terms; A1 rules (scope, caps, level); A7 budget schedules; A8 monthly budget plans; A9 budget pools.

eBay, per market (the strategy covers Amazon only in this release):
6. `ads-overview` (`channel: "ebay"`): pacing against the monthly ceilings, findings (rates above break-even, missing costs, unpromoted listings, campaigns without a rule), `writes` (live or sandbox).
7. `ad-campaigns` (`channel: "ebay"`, `market`): `fundingModel`, `adRateStrategy`, `bidPercentage` (the campaign rate), `dailyBudgetCents`, `rulesBased`, `automation` (posture, protected, rules), `account`.
8. `list-automations` (`area: "ebay-ads"`): E1 rules and `caps.spendCeilings` (monthly cap, kill switch); `levelReason` names the eBay dial when it holds rules back.
9. `ebay-ad-details` (`view`: `listings`, `ad-groups` or `keywords`; `market`, `campaignId`): each promoted listing's ad rate and break-even rate, a Priority campaign's ad groups, its keywords and bids.

Not readable by any tool — write "not readable", never guess: a campaign's max bid change % and CPC ceiling, which campaigns a rule reaches (A1 rows give only the count, `reach`); eBay campaign policy rate/bid caps and floors, eBay search terms. Budget baselines, monthly budget plans, budget schedules and pools are in `ad-budgets`; hourly bid plans in `ad-hourly-plans`; portfolios in `ad-portfolios`.

## 2. Show one table per market

Rows: each strategy field with its value and where it comes from (the market's row, or "not set"), and whether anything reads it yet; then one line per category or product row that differs. Beside them, the older settings that still bind: target ACoS (each campaign's own, and the business default), daily budgets, market and campaign spend ceilings, bid policy, protected terms, harvest policy, rules scoped to the market and their levels, campaigns on the live-write allowlist, live or sandbox. eBay: campaigns with funding model, rate or budget, posture, rules, monthly ceiling. Name what is business-wide (the Amazon dial, breaker and default target; the eBay dial; each tool's level for Claude) once, under the tables.

## 3. Ask, per market

The goal in the person's words (for example launch, grow, profit, clear stock, defend) and their numbers: target ACoS (or TACoS), monthly spend cap, bid floor and ceiling, largest bid change per action, brand terms and products to protect, harvest and negate criteria, and what Claude may do alone per kind of ad action. Then ask whether any category or product needs its own numbers (a launch, a product to protect, one to clear). Offer today's values as the starting point; never suggest numbers of your own as if they were theirs.

## 4. What Claude may do alone

The strategy's `claudeAutonomy` holds a level per kind of ad action — `bid`, `negative`, `harvest`, `placement`, `budget`, `target`, `suggestion`, `stop`, `restore`, `create`, `rule`, `undo`, `allowlist`, `automation`, `pause`, `enable`, `archive`, `phase`, `settings`, `portfolio`, `hourly`, `targeting`, `retire` — each `off`, `ask`, `confirm`, `watch` or `auto`. `stop` is the temporary stop with low bids (`suppress-campaign`, `set-ad-group` `op: "stop"`); `pause` is a real pause (`pause-ads`); `enable` switches back on what a Claude request paused (`enable-ads`) — with `includePeoplesPauses` also what a person, Seller Central or a rule now off paused, which always needs the approver's authenticator code and never runs by rule; `archive` (`archive-ads`) is for good: Amazon cannot switch an archived ad on again, so advise keeping it at `ask`. `create` makes a campaign (born at the floor and off the allowlist) or an ad group (`create-ad-group`, born at the floor), or adds product ads (`add-product-ads`); switching a campaign on is `allowlist` (`set-campaign-live-writes`) and starting it is `restore`, each its own kind.

The other kinds: `negative` includes the list form (`add-negative-targets`); `harvest` includes `harvest-search-term` and `set-harvest-destination`; `budget` includes the month's budget plan, budget schedules, budget pools and baselines (`set-monthly-ad-budget`, `set-budget-schedule`, `set-budget-pool`, `restore-budget-baselines`); `automation` is an automation moved up or tuned, the campaigns a rule acts on, a coverage set and an engine's Run now (`turn-up-automation`, `tune-ad-engine`, `assign-ad-rules`, `set-coverage-set`, `run-ad-engine-now`); `settings` is a campaign's name, portfolio, end date and bidding strategy (`set-campaign-settings`); `portfolio` is a portfolio made, renamed, capped or archived (`set-portfolio`; an archive is the `archive` kind too); `hourly` is the hourly bid plans (`set-hourly-bid-plan`; a plan a person made changes by rule only where the business allowed it); `targeting` is keywords and product or category targets added to an ad group (`add-ad-targets`); `retire` is negatives lifted (`retire-negatives`); `phase` is a playbook's phase switch (`apply-ads-playbook` `op: "phase"`).

- It only narrows the level the business set for each tool (Nexus, Settings › AI › Claude): a change Claude asks for is held to the lower of the two where it lands. It never widens it.
- Brakes are never narrowed: `stop-automation`, `turn-down-automation`, a guardrail.
- Where Nexus cannot tell exactly where a change lands (every campaign of a market, an id it cannot find, a rule for the whole account), the strictest row of that market, or of the business, applies. Name the campaigns or ad groups to hold each to its own level.
- An answer the strategy narrowed carries `trust.strategy` (the row, its market and version) and `trust.why`; `off` refuses the change before anything is queued. Pass the reason on in plain words.

## 5. Units — exact

| Field | Set with | Unit |
|---|---|---|
| Strategy target (`target`: kind `ACOS` or `TACOS`) | `set-ads-strategy` | whole percent 1–500 (30 = 30 %) |
| Strategy monthly cap, lowest and highest bid, stop bid, negate spend | `set-ads-strategy` | minor units of the market's currency |
| Strategy largest bid change per action | `set-ads-strategy` | whole percent 1–100 |
| Strategy harvest and negate windows | `set-ads-strategy` | 30, 60 or 90 days |
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

What reads which target: Nexus's bid optimiser (auto-bid, autopilot plans and `bid_to_target_acos` rules) moves each keyword's bid toward the first of: the rule's or plan's own target (one a person set), the campaign's own `targetAcos`, the business default, profit data (profit mode), 30 %. The strategy's target sits after the campaign's own once the bid engines read it: `ads-strategy` says whether they do (`readBy` of `targetAcosPct`) and gives the order (`order`). A value outside what the screens take (above 0, at most 500 %) is skipped there, never converted. It writes to Amazon only on campaigns on the live-write allowlist. `bid_apply` rules (`op: targetAcos` / `curBidTargetAcos`) use their own `value`, else the business default. The external bidding engine also reads the campaign's `targetAcos` when it runs. eBay has no target ACoS: an `acos_pct` condition in a market-scoped rule is the proxy.

The bid brain (`bid-brain`, read only) runs in shadow on IT and DE: it decides each keyword bid of an allowlisted campaign from this target and writes nothing yet. Before proposing a new target, `bid-brain` `view: "what-if"` with `targetAcosPct` shows what it would do to the bids; `view: "why"` explains a bid, `view: "diff"` sets the brain against what today's writers set.

## 6. Propose ONE change plan

| To | Tool |
|---|---|
| A market's, a category's or a product's strategy (goal and why, target, monthly cap, bid limits, largest change, actions per run, protection, harvest and negate thresholds, stop, what Claude may do alone) | `set-ads-strategy`, one step per market, category or product (its own description gives the arguments). Its preview says what raises and what lowers; a raise needs the person's authenticator code |
| Business default target ACoS | `tune-ad-engine` (`setting: "account-target-acos"`, `accountTargetAcos: { targetAcosPct }`) |
| A campaign's own target ACoS (an exception that wins over the strategy) | `set-campaign-target-acos` (`campaignIds`, or `market` = every Amazon campaign there; `targetAcosPct`; `why`). Nexus only: nothing is sent to Amazon. A person approves it in Nexus, or the person who asked confirms it in Claude when the business allows that, or it runs by the business's rule when the business allows that, inside its limits and the ads strategy (a raise never above the strategy's own target there). Show the list: campaign, now → target. Campaigns that keep their own target are listed in `shadowedBy` |
| Market or campaign daily spend ceiling | `set-ad-guardrail` (`kind: "spend-ceiling"`, `op: "set"`, `grain: "MARKET"` + `scopeId` market code, or `"CAMPAIGN"` + campaign id, `dailyCapCents`) |
| Market bid policy (an older bound; it keeps binding beside the strategy's bid limits, the stricter wins) | `set-ad-guardrail` (`kind: "bid-policy"`, `grain: "MARKET"`, `scopeId`, `minBidCents`, `maxBidCents`) |
| Protect a brand term from negation | `set-ad-guardrail` (`kind: "protected-term"`, `op: "set"`, `term`, `matchType` EXACT · PREFIX · CONTAINS, optional `marketplace`) |
| One campaign's own guardrails (they only narrow the strategy: where both set a number, the stricter binds) | `set-ad-guardrail` with `campaignId` and `kind` `campaign-bid-bounds` (`minBidCents`/`maxBidCents`), `campaign-budget-bounds` (`minBudgetCents`/`maxBudgetCents`/`budgetBaselineCents`), `bid-change-cap` (`maxBidChangePct`), `cpc-ceiling` (`cpcMultiple`, `enabled`) or `pin` (`pinBids`/`pinBudget`/`pinPlacement`); `null` clears a value, `op: "remove"` clears the kind. Nexus only. Loosening (a pin set or lifted too) waits for a person; by rule only in the markets or campaigns the business lists |
| Daily budgets | `set-campaign-budget` (`campaignId`, `dailyBudgetCents`, or `campaigns`, a list) — it waits for a person unless the business lets it run by its rule; `restore-budget-baselines` puts budgets back to a captured baseline |
| A market's budget plan for a month (Budget Manager: budget, Auto Pacing, Stop Over Spend, the calendar, each campaign's lowest and highest daily budget) | `set-monthly-ad-budget` (`market`, `month`). Nexus only: the budget engine acts on it. The strategy's own monthly cap binds beside it |
| A budget schedule or a budget pool (create, change, delete; a pool's campaigns; a rebalance now) | `set-budget-schedule`, `set-budget-pool`. Switching a pool on, off or live is `turn-up-automation` / `turn-down-automation` |
| Portfolios, and the campaigns in them | `set-portfolio` (create, rename, budget cap; archive is for good), `set-campaign-settings` (into or out of a portfolio, name, end date, bidding strategy) |
| An hourly bid plan | `set-hourly-bid-plan` (the plans are the Owner's: only when the person asks) |
| Which campaigns a rule acts on; where harvested terms land | `assign-ad-rules`; `set-harvest-destination` |
| Harvest policy for a market (an older setting; it keeps binding beside the strategy's harvest thresholds, the stricter wins) | `tune-ad-engine` (`setting: "harvest-policy"`, `harvestPolicy: { scopeGrain: "market", scopeId, minOrders, minClicks, maxAcosPct, windowDays }`) |
| A budget pool's or schedule's values, breaker | `tune-ad-engine` (`budget-pool` / `budget-schedule` with `subjectId` of an existing one — a schedule's windows are replaced whole; `breaker`) |
| A market's rule | `save-ad-rule` (`scope: { marketplace: "IT" }`; eBay `"EBAY_IT"`), born OBSERVE (eBay: OFF); levels and previews in `automation-review` |
| Automation level, dial, engine switch | `turn-up-automation` / `turn-down-automation` (A3 dial and engine switches: no `rowId`) |
| eBay rates, budgets, rule guard rails | `set-ebay-ad-rates`, `set-ebay-campaign-budget`, `tune-ad-engine` (`ebay-campaign-policy`, `subjectId` = eBay campaign, one per step) |

- Show the plan per market: setting, from → to, unit, whether it can raise spend (`tune-ad-engine` previews say `spend: can-rise`; a guardrail preview says `loosen`).
- Every step is dry-run when the plan is submitted: a step that needs an earlier step to have run (a campaign after its market's new ceiling; on live, `restore-campaign` after `set-campaign-live-writes`; anything that relies on a strategy change) is refused. Set the strategy in its own plan first, then ask for the rest.
- The eBay campaign policy binds the eBay rules only, not Claude's or anyone's manual rate and bid changes; posture `OFF` or `protected` stops every rule on that campaign, `SUGGEST` makes them propose, `AUTO` adds nothing over `INHERIT`.

## 7. Limits that refuse or shrink a plan

- **Live or sandbox** is the server's, not the business's: each change preview says `live` or `sandbox`. An Amazon sandbox preview skips the live checks (halt, connection, markets, allowlist, pins, spend ceiling, daily budget move, value cap): a sandbox yes predicts nothing about live.
- **Amazon live ad writes only in IT, DE, FR and ES.** Any other Amazon market is refused at the live write gate, with no way round from Claude.
- **Allowlist:** an Amazon campaign takes a live write (approved change, rule or schedule) only when `liveWrites` is true; putting a campaign on with `set-campaign-live-writes` is a big door: a person approves it with their authenticator code, or the business's rule runs it inside its limits for a campaign Claude itself created (by default never; taking one off is a brake). eBay has no allowlist and no `suppress-campaign` (both Amazon-only).
- **Daily budget move:** by default an Amazon campaign's budget may move at most 30 % down or 50 % up (more for very small budgets) from the day's opening value per UTC day, counting every writer; it resets at 00:00 UTC. Plan bigger moves over several days. eBay: 15 budget changes per campaign per day.
- **Spend ceiling** caps the sum of today's Amazon budget increases, not spend; it never binds bids. One write above the server's value cap is refused.
- **Dial and halt are business-wide:** Amazon dial OFF or a halt refuses every live Amazon write except a suppression's lowering, approved changes included; SUGGEST keeps every rule proposing. An eBay market at its monthly ceiling (checked by `ads-overview` with `channel: "ebay"` and by the rule run) halts every eBay ad write of the business, lowering included, until a person resumes it.
- **First Amazon campaign in a new market:** `create-ad-campaign` needs that market's spend ceiling, and a MARKET ceiling or bid policy needs a campaign already in the market. So a person creates the first campaign (Nexus campaign builder, or Amazon's console, then it syncs); then set the ceiling; then Claude may create more. A new campaign is born with every bid at 2 cents and off the allowlist: then `set-campaign-live-writes`, then `restore-campaign`, each its own request.
- **eBay:** a General campaign starts at the 2 % minimum with no listings; a Priority campaign needs the market's monthly eBay ceiling in the market's currency holding 31 days of its budget, and is refused on eBay Spain when it runs.

## 8. No Claude tool — a person, in Nexus

| Setting | Where |
|---|---|
| Amazon Ads connection mode and enabling its writes | Nexus's Amazon Ads connection (an operator's step) |
| eBay dial, kill switch, monthly ceiling (that screen sets the EBAY_IT ceiling only today) | Ads › eBay › Rules & Automation |
| eBay campaign-level rate and rate strategy, ad groups | Ads › eBay |

## 9. After

`approval-status` per request; then read again (`ads-strategy`, `ad-campaigns`, `list-automations`) and show the market tables with the new values. Weekly tuning against the strategy is `ads-weekly-review`; rule levels and why a rule acted are `automation-review`.
