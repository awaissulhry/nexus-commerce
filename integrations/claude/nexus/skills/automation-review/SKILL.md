---
name: automation-review
description: Review every automation in a Nexus business - ads rules and engines, budget schedules and pools, the agent fleet, repricing, listing, replenishment, review and bulk rules, scheduled jobs and alerts - say what each may do now and what it actually did, explain why something did or did not happen, and propose changes (level up or down, a rule, a guardrail, a setting, stop or resume) as requests a person approves. Use when the person asks what is automated, why a rule did or did not act, to switch an automation on or off, or to create or tune a rule.
---

# Automation review

List, explain, propose. Every automation sits on a ladder: OFF · OBSERVE (runs and records, does nothing) · PROPOSE (suggests, a person decides) · AUTO (acts by itself inside its caps). What it may do is the lower of what the server allows (its env switch) and what this business set. eBay ads rules have no OBSERVE (OFF · PROPOSE · AUTO), and they run only while the business's eBay dial is SUGGEST or AUTO (it starts OFF; a person sets it in Nexus). Nothing here pauses an ad: rules lower bids instead. Targets, ceilings and bid limits per market are the `ads-strategy` skill's.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. List

`list-automations` (optional `area`: amazon-ads, ebay-ads, marketing, agents, pricing, products, listings, replenishment, reviews, bulk, alerts, detectors; optional `level`): each automation's number (A1 …, E1, F1, N1 …), its effective level and why, scope, schedule, caps, last run and up to 5 of its rules. An automation the server switches off reads OFF and names the env flag.

## 2. Explain

- One automation in full: `automation-detail` (`automation`, optional `rowId` for one rule, plan, schedule or pool).
- What it did: `automation-activity` (`automation`, `rowId`, `days` up to 30) — its runs, what it wrote, whether it ever wrote anything, and what stopped it (its own cap, a value cap). Use it for "why did it do X" and "why did nothing happen".
- What it would do now: `preview-automation` (`automation`, `rowId`, or an unsaved `draft`) — writes nothing, sends nothing. An Amazon (A1) `draft` takes the rule builder's shape (`actions[0].type` budget, bid, placement, sov or keyword-tracker), not `save-ad-rule`'s; a rule in `save-ad-rule`'s shape is previewed once saved, by `rowId` (it is born OBSERVE and writes nothing). An eBay (E1) `draft` is `{ name, trigger, action, guardrails, marketplace, cooldownHours }`.
- Business-wide brakes to check first: the Amazon dial (A3) at SUGGEST keeps every Amazon rule proposing, even one at AUTO; the dial at OFF or a halt refuses every live Amazon write, people's approved changes included (a suppression's lowering still passes). The eBay dial at OFF stops every eBay rule; an eBay halt (also set when a market reaches its monthly ceiling) or a market's kill switch refuses every eBay ad write too.
- An Amazon budget rule (`adjust_ad_budget`) reaches no campaign until a person assigns campaigns to it (Ads › Rules & Automation › Apply Rules): "never wrote" may mean "assigned to nothing" — its row's `reach` says how many campaigns it reaches.
- Report: what is at AUTO, what is only watching, what is off and why, and anything that looks wrong (a rule at AUTO that never wrote, a cap that decides more than the conditions).

## 3. Propose (only when asked)

| To | Tool |
|---|---|
| Go up the ladder | `turn-up-automation` (`automation`, `rowId`, `level`). AUTO only after the graduation gate (14 days since the rule was made, 10 real runs, 1 match; Amazon rules also a live production connection with writes on) and always a person's click; an Amazon rule's graduation ceiling and a contested placement lane refuse too. eBay: PROPOSE or AUTO, never OBSERVE. An engine the server env switches goes up only as far as the env allows (leave `rowId` out; the A3 dial too). |
| Go down | `turn-down-automation` (`level`: PROPOSE, OBSERVE or OFF; eBay: PROPOSE or OFF). Turning down a brake (a rule that lowers bids or rates, a dayparting or budget schedule, budget enforcement, rank-defend) can raise spend: it needs a person unless the business allows it. OFF retires a rule; nothing is deleted. |
| Stop an area now | `stop-automation` (`area`: amazon-ads, ebay-ads, agent-fleet, review-mailer, or rules + `domain`; `reason` required, 3–200 characters). For ads rules pass `domain: "advertising"` — left out, it is replenishment. Stopping amazon-ads also refuses people's approved live Amazon changes until it is resumed. |
| Resume it | `resume-automation` — always a person's decision |
| A new or changed ads or marketing rule | `save-ad-rule`. Amazon and marketing: born OBSERVE, `caps` (`maxExecutionsPerDay`, `maxWritesPerDay`, `maxValueCentsEur`) required. eBay (`kind: "ebay-ads"`): saved OFF, `guardrails.maxActionsPerRun` required, `scope.marketplace` like `EBAY_IT`. A pause is refused: Amazon lowers with `bid_down` or `lower_bid_to_floor` (a plain bid of at least 5 cents that any engine may raise again, not a suppression); eBay has no `lower_bid_to_floor` — use `adjust_ad_rate` with a negative `deltaPct`, `set_rate_to_breakeven_factor` or `bid_down_keyword`. Units below. |
| An operations rule (listings, replenishment, reviews, bulk) | `save-ops-rule` (born OBSERVE; a review rule OFF; daily run cap required) |
| A repricing rule | `save-price-rule` (born OFF; its min/max must sit inside the product's price bounds) |
| A guardrail (Amazon only: spend ceiling, bid policy, protected term; a campaign's own bid or budget bounds, largest bid change, CPC ceiling or pins) | `set-ad-guardrail` (tightening may run inside the business's limits; loosening needs a person unless the business allows it; a MARKET ceiling or bid policy needs a campaign already in that market) |
| Stop an Amazon ad write before it is sent (inside its grace window, about 5 minutes) | `cancel-queued-ad-write` (`outboundQueueId`, or `changeSetId` for every write of one request; `why`). Nexus only; by rule only a raise a Claude request queued — never another's write or a lowering (cancelling one keeps spend up) unless the business allows it |
| An engine's setting (budget pool, coverage caps, rank target, budget schedule, harvest policy, eBay campaign policy, account target ACoS, breaker) | `tune-ad-engine` — a person decides every tune (the preview's `spend` says `can-rise` or `cannot-rise`). The eBay campaign policy binds the eBay rules only, never a person's or Claude's own rate and bid changes. |
| The agent fleet's workers | `steer-fleet` (run now, pause, resume, level, assign; never their prompts, model or budget) |
| Rule suggestions waiting | `decide-automation-suggestions` (`kind`: amazon-ads or ebay-ads; apply or dismiss; a pause suggestion is refused — dismiss it; an eBay proposal once decided cannot be put back) |

Rule units — the guard catches only some mistakes, so write each in its own unit:
- Amazon condition ratios are fractions: `acos`, `ctr`, `cvr`, `budgetUtilization`, and also `sovPct` and `topSharePct` (0.3, not 30); `declinePct` and `growthPct` are whole percents; `…Cents` are cents.
- Amazon action values: `bid_apply` `value` (target ACoS) and every `percent` / `…Pct` parameter are percents; `targetAcos` in `bid_to_target_acos` and `set_campaign_target_acos` is a fraction.
- eBay: percent metrics and parameters are percents (`acos_pct` 30 = 30 %, `ctr_pct`, `fee_pct_of_sales`, `deltaPct`, `bidDeltaPct`, `minRatePct`); `factor` and a benchmark's `multiplier` are plain multipliers; `…_cents` are cents. Of the eBay `guardrails`, only `maxActionsPerRun` binds today: put click and spend minimums in the trigger's conditions (`clicks`, `ad_fees_cents`).

- Before proposing a rule, preview what it would do now (eBay: the draft; Amazon: see §2) and show it.
- Several changes: ONE `submit-change-plan`. Show the table: automation, from → to level (or setting from → to), why, and whether it can raise spend.
- Never edit a worker's prompt, the AI providers, budgets or the kill switch: those stay a person's own settings in Nexus. The eBay dial, monthly ceilings and kill switch have no Claude tool either.

## 4. After

`approval-status` for each request; then `list-automations` again to confirm the new level, and `automation-activity` after its next run.
